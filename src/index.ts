import {
  assignedKeyForTeam,
  bulkTeamKeys,
  deleteConfig,
  fetchKeyStats,
  getConfig,
  getEventInfo,
  importKeyPool,
  managementToken,
  setConfig,
  validateManifest,
} from "./config";
import { activeRunCount, authTeam, countedRuns, getRun, getTeamByName, intVar, randomCode, sha256Hex } from "./db";
import { resolveTarballUrl } from "./github";
import { createRun, finalizeIfDone } from "./runs";
import type { Env, EventInfo, KeyPoolRow, Manifest, RunKind, RunRow } from "./types";

export { ContainerProxy, Sandbox } from "./sandbox";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function badRequest(message: string, status = 400): Response {
  return json({ error: message }, status);
}

async function readJsonBody<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

const TEAM_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{1,31}$/;

function elapsedMs(startedAt: string): number {
  return Math.max(0, Date.now() - new Date(startedAt.replace(" ", "T") + "Z").getTime());
}

function serializeRun(run: RunRow, opts: { admin?: boolean } = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: run.id,
    kind: run.kind,
    repo: run.repo,
    status: run.status,
    started_at: run.started_at,
    finished_at: run.finished_at,
    elapsed_ms: run.status === "running" || run.status === "finalizing" ? elapsedMs(run.started_at) : null,
    duration_ms: run.duration_ms,
    exit_code: run.exit_code,
    llm_calls: run.llm_calls,
  };

  const hideDetails = run.kind === "final" && !opts.admin;
  if (hideDetails) {
    // Final-run scores stay sealed until the organizers reveal them.
    base.sealed = true;
    if (run.status === "succeeded") {
      base.message = "Final run scored. Results are revealed at the end of the event.";
    } else if (run.error) {
      base.error = run.error.split(".")[0] + ".";
    }
    return base;
  }

  return {
    ...base,
    reported: run.reported,
    matched: run.matched,
    precision: run.precision,
    recall: run.recall,
    f1: run.f1,
    cost_usd: run.cost_usd,
    error: run.error,
    log_tail: run.log_tail,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function handleClaimTeam(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody<{ name?: string }>(request);
  const name = body?.name?.trim() ?? "";
  if (!TEAM_NAME_RE.test(name)) {
    return badRequest("Team names use 2-32 letters, numbers, spaces, dots, dashes, or underscores.");
  }

  const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM teams").first<{ n: number }>();
  if ((total?.n ?? 0) >= 300) return badRequest("Team registration is full.", 409);

  const code = randomCode();
  const codeHash = await sha256Hex(code);
  try {
    await env.DB.prepare("INSERT INTO teams (name, code_hash) VALUES (?, ?)").bind(name, codeHash).run();
  } catch {
    return badRequest("That team name is taken. Pick another one.", 409);
  }
  return json({ name, code, note: "Save this code. It is shown only once." }, 201);
}

async function handleTeamRuns(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody<{ name?: string; code?: string }>(request);
  const team = await authTeam(env.DB, body?.name?.trim() ?? "", body?.code ?? "");
  if (!team) return badRequest("Unknown team name or wrong code.", 401);

  const rows = await env.DB
    .prepare("SELECT * FROM runs WHERE team_id = ? ORDER BY id DESC LIMIT 50")
    .bind(team.id)
    .all<RunRow>();

  const maxTest = intVar(env, "MAX_TEST_RUNS", 3);
  const maxFinal = intVar(env, "MAX_FINAL_RUNS", 1);
  return json({
    team: team.name,
    test_runs_used: await countedRuns(env.DB, team.id, "test"),
    final_runs_used: await countedRuns(env.DB, team.id, "final"),
    max_test_runs: maxTest,
    max_final_runs: maxFinal,
    runs: (rows.results ?? []).map((r) => serializeRun(r)),
  });
}

async function handleCreateRun(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody<{ name?: string; code?: string; repo?: string; kind?: string }>(request);
  const team = await authTeam(env.DB, body?.name?.trim() ?? "", body?.code ?? "");
  if (!team) return badRequest("Unknown team name or wrong code.", 401);

  const kind = body?.kind === "final" ? "final" : body?.kind === "test" ? "test" : null;
  if (!kind) return badRequest('Run kind must be "test" or "final".');

  const resolved = resolveTarballUrl(body?.repo ?? "", env.DEV_MODE === "1");
  if ("error" in resolved) return badRequest(resolved.error);

  const maxRuns = kind === "test" ? intVar(env, "MAX_TEST_RUNS", 3) : intVar(env, "MAX_FINAL_RUNS", 1);
  const used = await countedRuns(env.DB, team.id, kind);
  if (used >= maxRuns) {
    return badRequest(
      kind === "test"
        ? `Your team already used all ${maxRuns} test runs.`
        : "Your team already submitted its final run.",
      409,
    );
  }

  const ownActive = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM runs WHERE team_id = ? AND status IN ('running','finalizing')")
    .bind(team.id)
    .first<{ n: number }>();
  if ((ownActive?.n ?? 0) > 0) return badRequest("Your team already has a run in progress.", 409);

  if ((await activeRunCount(env.DB)) >= intVar(env, "MAX_CONCURRENT_RUNS", 3)) {
    return badRequest("All run slots are busy. Try again in a minute.", 429);
  }

  try {
    const created = await createRun(env, team, kind as RunKind, resolved.url, resolved.display);
    return json(created, 201);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return badRequest(`Could not start the run: ${message}. This did not use one of your runs.`, 500);
  }
}

async function handlePollRun(request: Request, env: Env, id: number): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  let run = await getRun(env.DB, id);
  if (!run || run.poll_token !== token) return badRequest("Run not found.", 404);
  run = await finalizeIfDone(env, run);
  return json(serializeRun(run));
}

async function handleEventInfo(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody<{ name?: string; code?: string }>(request);
  const team = await authTeam(env.DB, body?.name?.trim() ?? "", body?.code ?? "");
  if (!team) return badRequest("Unknown team name or wrong code.", 401);

  const info = (await getEventInfo(env)) ?? {};
  const assigned = await assignedKeyForTeam(env, team.id);
  let teamKey: Record<string, unknown> | null = null;
  if (assigned) {
    const stats = (await fetchKeyStats(env)).get(assigned.name);
    teamKey = {
      name: assigned.name,
      key: assigned.api_key,
      usage: stats?.usage ?? null,
      limit: stats?.limit ?? null,
      disabled: stats?.disabled ?? null,
    };
  }
  return json({ event_info: info, team_key: teamKey });
}

async function handleLeaderboard(env: Env): Promise<Response> {
  const teams = await env.DB
    .prepare(
      `SELECT t.id, t.name,
         SUM(CASE WHEN r.kind = 'test' AND r.status != 'infra_error' THEN 1 ELSE 0 END) AS test_used,
         MAX(CASE WHEN r.kind = 'final' AND r.status = 'succeeded' THEN 1 ELSE 0 END) AS final_done
       FROM teams t LEFT JOIN runs r ON r.team_id = t.id
       GROUP BY t.id ORDER BY t.name`,
    )
    .all<{ id: number; name: string; test_used: number; final_done: number }>();

  const best = await env.DB
    .prepare("SELECT * FROM runs WHERE kind = 'test' AND status = 'succeeded' ORDER BY team_id")
    .all<RunRow>();

  const bestByTeam = new Map<number, RunRow>();
  for (const run of best.results ?? []) {
    const current = bestByTeam.get(run.team_id);
    if (!current || better(run, current)) bestByTeam.set(run.team_id, run);
  }

  const rows = (teams.results ?? []).map((t) => {
    const b = bestByTeam.get(t.id);
    return {
      team: t.name,
      test_runs_used: t.test_used ?? 0,
      max_test_runs: intVar(env, "MAX_TEST_RUNS", 3),
      final_submitted: (t.final_done ?? 0) === 1,
      f1: b?.f1 ?? null,
      precision: b?.precision ?? null,
      recall: b?.recall ?? null,
      cost_usd: b?.cost_usd ?? null,
      duration_ms: b?.duration_ms ?? null,
    };
  });

  rows.sort((a, b) => {
    if ((b.f1 ?? -1) !== (a.f1 ?? -1)) return (b.f1 ?? -1) - (a.f1 ?? -1);
    if ((a.cost_usd ?? Infinity) !== (b.cost_usd ?? Infinity)) {
      return (a.cost_usd ?? Infinity) - (b.cost_usd ?? Infinity);
    }
    return (a.duration_ms ?? Infinity) - (b.duration_ms ?? Infinity);
  });

  return json({ updated_at: new Date().toISOString(), teams: rows });
}

function better(a: RunRow, b: RunRow): boolean {
  if ((a.f1 ?? -1) !== (b.f1 ?? -1)) return (a.f1 ?? -1) > (b.f1 ?? -1);
  if ((a.cost_usd ?? Infinity) !== (b.cost_usd ?? Infinity)) {
    return (a.cost_usd ?? Infinity) < (b.cost_usd ?? Infinity);
  }
  return (a.duration_ms ?? Infinity) < (b.duration_ms ?? Infinity);
}

// ---------------------------------------------------------------------------
// Admin API
// ---------------------------------------------------------------------------

function isAdmin(request: Request, env: Env): boolean {
  const header = request.headers.get("authorization") ?? "";
  return Boolean(env.ADMIN_TOKEN) && header === `Bearer ${env.ADMIN_TOKEN}`;
}

async function handleAdmin(request: Request, env: Env, path: string): Promise<Response> {
  if (!isAdmin(request, env)) return badRequest("Admin token required.", 401);

  if (path === "overview" && request.method === "GET") {
    const teams = await env.DB.prepare("SELECT id, name, created_at FROM teams ORDER BY id").all();
    const runs = await env.DB
      .prepare(
        `SELECT r.*, t.name AS team_name FROM runs r JOIN teams t ON t.id = r.team_id
         ORDER BY r.id DESC LIMIT 200`,
      )
      .all<RunRow & { team_name: string }>();
    const blocked = await env.DB
      .prepare("SELECT * FROM blocked_requests ORDER BY id DESC LIMIT 100")
      .all();
    return json({
      teams: teams.results,
      runs: (runs.results ?? []).map((r) => ({ team: r.team_name, ...serializeRun(r, { admin: true }) })),
      blocked: blocked.results,
    });
  }

  if (path === "void-run" && request.method === "POST") {
    const body = await readJsonBody<{ run_id?: number }>(request);
    if (!body?.run_id) return badRequest("run_id is required.");
    const res = await env.DB
      .prepare("UPDATE runs SET status = 'infra_error', error = COALESCE(error,'') || ' [voided by admin]' WHERE id = ?")
      .bind(body.run_id)
      .run();
    return json({ voided: (res.meta.changes ?? 0) === 1 });
  }

  if (path === "config" && request.method === "GET") {
    const manifests: Record<string, unknown> = {};
    for (const dataset of ["test", "validation"]) {
      const override = await getConfig<Manifest>(env, `manifest:${dataset}`);
      manifests[dataset] = { source: override ? "admin override" : "bundled asset", manifest: override };
    }
    const pool = await env.DB
      .prepare(
        `SELECT p.name, p.api_key, t.name AS team FROM key_pool p
         LEFT JOIN teams t ON t.id = p.team_id ORDER BY p.name`,
      )
      .all<{ name: string; api_key: string; team: string | null }>();
    const stats = await fetchKeyStats(env);
    return json({
      event_info: (await getEventInfo(env)) ?? {},
      manifests,
      stats_available: Boolean(managementToken(env)),
      pool: (pool.results ?? []).map((p) => ({
        name: p.name,
        key_tail: `…${p.api_key.slice(-6)}`,
        team: p.team,
        usage: stats.get(p.name)?.usage ?? null,
        limit: stats.get(p.name)?.limit ?? null,
        disabled: stats.get(p.name)?.disabled ?? null,
      })),
    });
  }

  if (path === "config" && request.method === "POST") {
    const body = await readJsonBody<{ event_info?: EventInfo }>(request);
    if (!body?.event_info || typeof body.event_info !== "object") return badRequest("event_info object required.");
    await setConfig(env, "event_info", body.event_info);
    return json({ saved: true });
  }

  if (path === "manifest" && request.method === "POST") {
    const body = await readJsonBody<{ dataset?: string; manifest?: unknown }>(request);
    const dataset = body?.dataset === "validation" ? "validation" : body?.dataset === "test" ? "test" : null;
    if (!dataset) return badRequest('dataset must be "test" or "validation".');
    if (body?.manifest === null) {
      await deleteConfig(env, `manifest:${dataset}`);
      return json({ cleared: true, source: "bundled asset" });
    }
    const checked = validateManifest(body?.manifest);
    if (!checked.manifest) return json({ saved: false, errors: checked.errors, warnings: checked.warnings }, 400);
    await setConfig(env, `manifest:${dataset}`, checked.manifest);
    return json({ saved: true, entries: checked.manifest.errors.length, warnings: checked.warnings });
  }

  if ((path === "keys-disable-all" || path === "keys-delete-all") && request.method === "POST") {
    try {
      const result = await bulkTeamKeys(env, path === "keys-delete-all" ? "delete" : "disable");
      return json({ ...result, action: path === "keys-delete-all" ? "deleted" : "disabled" });
    } catch (e) {
      return badRequest(e instanceof Error ? e.message : String(e), 500);
    }
  }

  if (path === "key-pool" && request.method === "POST") {
    const body = await readJsonBody<{ csv?: string }>(request);
    if (!body?.csv?.trim()) return badRequest("csv text required (lines of name,api_key).");
    const result = await importKeyPool(env, body.csv);
    return json(result);
  }

  if (path === "delete-team" && request.method === "POST") {
    const body = await readJsonBody<{ team?: string }>(request);
    const team = await getTeamByName(env.DB, body?.team?.trim() ?? "");
    if (!team) return badRequest("Team not found.", 404);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM llm_calls WHERE run_id IN (SELECT id FROM runs WHERE team_id = ?)").bind(team.id),
      env.DB.prepare("DELETE FROM runs WHERE team_id = ?").bind(team.id),
      env.DB.prepare("UPDATE key_pool SET team_id = NULL WHERE team_id = ?").bind(team.id),
      env.DB.prepare("DELETE FROM teams WHERE id = ?").bind(team.id),
    ]);
    return json({ deleted: team.name });
  }

  return badRequest("Unknown admin endpoint.", 404);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // The datasets live in the asset bundle. Never serve them.
    if (path.startsWith("/datasets/")) return badRequest("Not found.", 404);

    if (!path.startsWith("/api/")) return env.ASSETS.fetch(request);

    try {
      if (path === "/api/teams" && request.method === "POST") return await handleClaimTeam(request, env);
      if (path === "/api/team/runs" && request.method === "POST") return await handleTeamRuns(request, env);
      if (path === "/api/event-info" && request.method === "POST") return await handleEventInfo(request, env);
      if (path === "/api/runs" && request.method === "POST") return await handleCreateRun(request, env);

      const pollMatch = /^\/api\/runs\/(\d+)$/.exec(path);
      if (pollMatch && request.method === "GET") {
        return await handlePollRun(request, env, parseInt(pollMatch[1], 10));
      }

      if (path === "/api/leaderboard" && request.method === "GET") return await handleLeaderboard(env);

      const adminMatch = /^\/api\/admin\/([a-z-]+)$/.exec(path);
      if (adminMatch) return await handleAdmin(request, env, adminMatch[1]);

      if (path === "/api/config" && request.method === "GET") {
        return json({
          max_test_runs: intVar(env, "MAX_TEST_RUNS", 3),
          max_final_runs: intVar(env, "MAX_FINAL_RUNS", 1),
          run_timeout_seconds: intVar(env, "RUN_TIMEOUT_SECONDS", 600),
          max_llm_calls_per_run: intVar(env, "MAX_LLM_CALLS_PER_RUN", 300),
        });
      }

      return badRequest("Not found.", 404);
    } catch (e) {
      console.log(`api error on ${path}: ${e instanceof Error ? e.stack : e}`);
      return badRequest("Internal error. Ask an organizer for help.", 500);
    }
  },
};
