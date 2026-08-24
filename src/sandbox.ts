import { Sandbox as BaseSandbox, ContainerProxy } from "@cloudflare/sandbox";
import { getRunningRunByDoId, intVar } from "./db";
import type { Env } from "./types";

// The ContainerProxy export is required: the SDK dispatches outbound
// traffic through it (ctx.exports.ContainerProxy).
export { ContainerProxy };

/**
 * Sandbox for submission runs.
 *
 * Egress policy (deny by default):
 * - enableInternet = false blocks all traffic that no handler permits.
 * - interceptHttps = true routes HTTPS through the outbound handler too.
 * - The single catch-all `outbound` handler below is the full allowlist.
 */
export class Sandbox extends BaseSandbox<Env> {
  override enableInternet = false;
  override interceptHttps = true;
  override sleepAfter = "20m";
}

// Package registries and the GitHub tarball host. Read-only content
// sources; safe to pass through without modification.
const PASSTHROUGH_HOSTS = new Set([
  "pypi.org",
  "files.pythonhosted.org",
  "registry.npmjs.org",
  "codeload.github.com",
]);

// Response bodies are buffered to extract the OpenRouter generation id.
// Cap the buffer so a huge response cannot blow up Worker memory.
const MAX_BUFFERED_RESPONSE_BYTES = 4 * 1024 * 1024;

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

Sandbox.outbound = async (request, env, ctx): Promise<Response> => {
  const typedEnv = env as Env;
  const url = new URL(request.url);
  const host = url.hostname.toLowerCase();

  // Attribute the request to a run via the sandbox's Durable Object id.
  const run = await getRunningRunByDoId(typedEnv.DB, ctx.containerId);

  // Local dev only: allow the tarball server on the host machine.
  if (typedEnv.DEV_MODE === "1" && host === "host.docker.internal") {
    return fetch(request);
  }

  if (!run) {
    console.log(`outbound: no active run for container ${ctx.containerId}, blocked ${host}`);
    return jsonError(403, "No active run for this sandbox.");
  }

  if (host === "openrouter.ai") {
    if (run.llm_calls >= intVar(typedEnv, "MAX_LLM_CALLS_PER_RUN", 300)) {
      return jsonError(429, "LLM call limit reached for this run.");
    }

    // Swap whatever the team sent for the real key. The key never
    // enters the sandbox.
    const authed = new Request(request);
    authed.headers.set("authorization", `Bearer ${typedEnv.OPENROUTER_API_KEY}`);

    const upstream = await fetch(authed);

    // Buffer the body to pull out the generation id ("id":"gen-...").
    // Cost per generation is fetched from the OpenRouter API at grading
    // time, so self-reporting is impossible.
    let genId: string | null = null;
    let body: ArrayBuffer | null = null;
    if (upstream.body) {
      body = await upstream.arrayBuffer();
      if (body.byteLength <= MAX_BUFFERED_RESPONSE_BYTES) {
        const text = new TextDecoder().decode(body.slice(0, MAX_BUFFERED_RESPONSE_BYTES));
        genId = /"id"\s*:\s*"(gen-[^"]+)"/.exec(text)?.[1] ?? null;
      }
    }

    try {
      await typedEnv.DB.batch([
        typedEnv.DB
          .prepare("INSERT OR IGNORE INTO llm_calls (run_id, gen_id, status_code) VALUES (?, ?, ?)")
          .bind(run.id, genId, upstream.status),
        typedEnv.DB.prepare("UPDATE runs SET llm_calls = llm_calls + 1 WHERE id = ?").bind(run.id),
      ]);
    } catch (e) {
      console.log(`outbound: failed to record llm call for run ${run.id}: ${e}`);
    }

    // fetch() already decompressed the body; drop stale encoding headers.
    const headers = new Headers(upstream.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    headers.delete("transfer-encoding");
    return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers });
  }

  if (PASSTHROUGH_HOSTS.has(host)) {
    return fetch(request);
  }

  // Everything else: log and block.
  try {
    await typedEnv.DB
      .prepare("INSERT INTO blocked_requests (run_id, host, method, url) VALUES (?, ?, ?, ?)")
      .bind(run.id, host, request.method, request.url.slice(0, 2000))
      .run();
  } catch (e) {
    console.log(`outbound: failed to log blocked request: ${e}`);
  }
  console.log(`outbound: blocked ${request.method} ${host} (run ${run.id})`);
  return jsonError(403, `Host ${host} is not on the allowlist. This attempt was logged.`);
};
