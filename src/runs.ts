import { getSandbox } from "@cloudflare/sandbox";
import { getConfig } from "./config";
import { intVar, randomToken } from "./db";
import { grade, parseOutput } from "./grade";
import type { Env, Manifest, RunKind, RunRow, TeamRow } from "./types";

const DATASET_FOR_KIND: Record<RunKind, string> = {
  test: "test",
  final: "validation",
};

// ---------------------------------------------------------------------------
// Asset helpers (datasets live in the Worker's asset bundle, never public)
// ---------------------------------------------------------------------------

async function readAsset(env: Env, path: string): Promise<Response> {
  return await env.ASSETS.fetch(new Request(`https://assets.internal${path}`));
}

export async function loadDatasetFileList(env: Env, dataset: string): Promise<string[]> {
  const resp = await readAsset(env, `/datasets/${dataset}/files.json`);
  if (!resp.ok) throw new Error(`Dataset "${dataset}" has no files.json (status ${resp.status}).`);
  const files = (await resp.json()) as string[];
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error(`Dataset "${dataset}" files.json is empty.`);
  }
  return files.filter((f) => /^[A-Za-z0-9._-]+$/.test(f) && f !== "manifest.json" && f !== "files.json");
}

export async function loadManifest(env: Env, dataset: string): Promise<Manifest> {
  // An answer key saved from /admin overrides the bundled asset, so the
  // key can be fixed mid-event without a redeploy.
  const override = await getConfig<Manifest>(env, `manifest:${dataset}`);
  if (override && Array.isArray(override.errors) && override.errors.length > 0) return override;

  const resp = await readAsset(env, `/datasets/${dataset}/manifest.json`);
  if (!resp.ok) throw new Error(`Dataset "${dataset}" has no manifest.json (status ${resp.status}).`);
  const manifest = (await resp.json()) as Manifest;
  if (!Array.isArray(manifest.errors)) throw new Error(`Dataset "${dataset}" manifest has no errors array.`);
  return manifest;
}

// ---------------------------------------------------------------------------
// Run creation
// ---------------------------------------------------------------------------

const SETUP_SCRIPT = `#!/bin/bash
set -u
RESULT=/work/result.json
fail() { printf '{"phase":"setup","setup_error":"%s"}' "$1" > "$RESULT"; exit 1; }

curl -fsSL --retry 2 -o /work/repo.tgz "$TARBALL_URL" || fail "repo download failed (check the repo URL; the repo must be public)"
SIZE=$(stat -c%s /work/repo.tgz 2>/dev/null || echo 0)
[ "$SIZE" -le $((MAX_REPO_MB * 1024 * 1024)) ] || fail "repo tarball is larger than \${MAX_REPO_MB}MB"
mkdir -p /work/repo
tar -xzf /work/repo.tgz -C /work/repo --strip-components=1 || fail "could not extract the repo tarball"
[ -f /work/repo/run.sh ] || fail "run.sh not found at the repo root"

cd /work/repo
START=$(date +%s%3N)
timeout -k 15 "\${RUN_TIMEOUT_SECONDS}s" bash run.sh >/work/run.log 2>&1
EXIT=$?
END=$(date +%s%3N)
printf '{"phase":"done","exit_code":%d,"duration_ms":%d}' "$EXIT" "$((END-START))" > "$RESULT"
`;

export interface CreatedRun {
  id: number;
  kind: RunKind;
  status: string;
  poll_token: string;
}

export async function createRun(
  env: Env,
  team: TeamRow,
  kind: RunKind,
  tarballUrl: string,
  repoDisplay: string,
): Promise<CreatedRun> {
  const pollToken = randomToken(16);
  const sandboxId = `run-${randomToken(6)}`;
  const doId = env.Sandbox.idFromName(sandboxId).toString();

  const inserted = await env.DB
    .prepare(
      `INSERT INTO runs (team_id, kind, repo, status, poll_token, sandbox_id, sandbox_do_id)
       VALUES (?, ?, ?, 'running', ?, ?, ?) RETURNING id`,
    )
    .bind(team.id, kind, repoDisplay, pollToken, sandboxId, doId)
    .first<{ id: number }>();
  if (!inserted) throw new Error("Could not create the run row.");
  const runId = inserted.id;

  try {
    const dataset = DATASET_FOR_KIND[kind];
    const files = await loadDatasetFileList(env, dataset);

    const sandbox = getSandbox(env.Sandbox, sandboxId);
    await sandbox.mkdir("/work/dataset", { recursive: true });

    // Copy the document set into the sandbox. The ground-truth manifest
    // stays out on purpose.
    for (const file of files) {
      const resp = await readAsset(env, `/datasets/${dataset}/${file}`);
      if (!resp.ok || !resp.body) throw new Error(`Dataset file ${file} is missing (status ${resp.status}).`);
      await sandbox.writeFile(`/work/dataset/${file}`, resp.body);
    }

    await sandbox.writeFile("/work/setup.sh", SETUP_SCRIPT);
    await sandbox.startProcess("bash /work/setup.sh", {
      processId: `run-${runId}`,
      cwd: "/work",
      env: {
        TARBALL_URL: tarballUrl,
        MAX_REPO_MB: String(intVar(env, "MAX_REPO_MB", 25)),
        RUN_TIMEOUT_SECONDS: String(intVar(env, "RUN_TIMEOUT_SECONDS", 600)),
        // Placeholder credential. The outbound proxy replaces it with the
        // real key on requests to openrouter.ai.
        OPENROUTER_API_KEY: `sk-or-v1-${randomToken(24)}`,
        DATASET_DIR: "/work/dataset",
        OUTPUT_PATH: "/work/output.json",
      },
    });
  } catch (e) {
    // Setup failed before the team's code ran: free the slot, do not
    // consume a run.
    const message = e instanceof Error ? e.message : String(e);
    await env.DB
      .prepare("UPDATE runs SET status = 'infra_error', error = ?, finished_at = datetime('now') WHERE id = ?")
      .bind(`Run setup failed: ${message}`, runId)
      .run();
    try {
      await getSandbox(env.Sandbox, sandboxId).destroy();
    } catch {
      /* best effort */
    }
    throw e;
  }

  return { id: runId, kind, status: "running", poll_token: pollToken };
}

// ---------------------------------------------------------------------------
// Finalization (invoked from the poll endpoint)
// ---------------------------------------------------------------------------

interface SandboxResult {
  phase: string;
  setup_error?: string;
  exit_code?: number;
  duration_ms?: number;
}

// Generation stats lag a few seconds behind the call itself, so back off
// across ~12s before giving up on a generation.
const COST_RETRY_DELAYS_MS = [1500, 3000, 7000];

async function fetchGenerationCost(env: Env, genId: string): Promise<number | null> {
  for (let attempt = 0; attempt <= COST_RETRY_DELAYS_MS.length; attempt++) {
    try {
      const resp = await fetch(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(genId)}`, {
        headers: { authorization: `Bearer ${env.OPENROUTER_API_KEY}` },
      });
      if (resp.ok) {
        const data = (await resp.json()) as { data?: { total_cost?: number } };
        const cost = data.data?.total_cost;
        return typeof cost === "number" ? cost : 0;
      }
      if (resp.status !== 404) return null;
    } catch {
      return null;
    }
    if (attempt < COST_RETRY_DELAYS_MS.length) {
      await new Promise((r) => setTimeout(r, COST_RETRY_DELAYS_MS[attempt]));
    }
  }
  return null;
}

async function sumRunCost(env: Env, runId: number): Promise<{ cost: number; missing: number }> {
  const rows = await env.DB
    .prepare("SELECT gen_id FROM llm_calls WHERE run_id = ? AND gen_id IS NOT NULL LIMIT 500")
    .bind(runId)
    .all<{ gen_id: string }>();
  const genIds = [...new Set((rows.results ?? []).map((r) => r.gen_id))];

  let cost = 0;
  let missing = 0;
  const BATCH = 10;
  for (let i = 0; i < genIds.length; i += BATCH) {
    const batch = genIds.slice(i, i + BATCH);
    const costs = await Promise.all(batch.map((id) => fetchGenerationCost(env, id)));
    for (const c of costs) {
      if (c === null) missing++;
      else cost += c;
    }
  }
  return { cost, missing };
}

function elapsedMs(startedAt: string): number {
  // D1 datetime('now') is UTC without a timezone suffix.
  return Date.now() - new Date(startedAt.replace(" ", "T") + "Z").getTime();
}

/**
 * Move a run forward if its sandbox finished. Returns the fresh row.
 * Safe to call on every poll: a status claim prevents double grading.
 */
export async function finalizeIfDone(env: Env, run: RunRow): Promise<RunRow> {
  if (run.status !== "running") return run;

  const sandbox = getSandbox(env.Sandbox, run.sandbox_id);

  let resultRaw: string | null = null;
  try {
    resultRaw = (await sandbox.readFile("/work/result.json")).content;
  } catch {
    resultRaw = null;
  }

  if (resultRaw === null) {
    // Still running — unless the sandbox died or stalled past the timeout.
    const graceMs = (intVar(env, "RUN_TIMEOUT_SECONDS", 600) + 300) * 1000;
    if (elapsedMs(run.started_at) > graceMs) {
      const claimed = await claim(env, run.id);
      if (!claimed) return (await getRunFresh(env, run.id)) ?? run;
      await destroyQuietly(sandbox);
      return await finish(env, run.id, {
        status: "timeout",
        error: "The run did not finish inside the time limit and was stopped.",
      });
    }
    return run;
  }

  const claimed = await claim(env, run.id);
  if (!claimed) return (await getRunFresh(env, run.id)) ?? run;

  try {
    return await gradeRun(env, run, sandbox, resultRaw);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await destroyQuietly(sandbox);
    return await finish(env, run.id, { status: "error", error: `Grading failed: ${message}` });
  }
}

type SandboxHandle = ReturnType<typeof getSandbox>;

async function gradeRun(env: Env, run: RunRow, sandbox: SandboxHandle, resultRaw: string): Promise<RunRow> {
  let result: SandboxResult;
  try {
    result = JSON.parse(resultRaw) as SandboxResult;
  } catch {
    await destroyQuietly(sandbox);
    return await finish(env, run.id, { status: "error", error: "The runner produced an unreadable result file." });
  }

  const logTail = await readLogTail(sandbox);

  if (result.setup_error) {
    await destroyQuietly(sandbox);
    return await finish(env, run.id, {
      status: "infra_error",
      error: `Setup failed: ${result.setup_error}. This run does not count against your limit.`,
      logTail,
    });
  }

  const exitCode = result.exit_code ?? -1;
  const durationMs = result.duration_ms ?? null;
  const { cost, missing } = await sumRunCost(env, run.id);
  const costNote = missing > 0 ? ` (${missing} LLM calls had no cost data)` : "";

  if (exitCode === 124 || exitCode === 137) {
    await destroyQuietly(sandbox);
    return await finish(env, run.id, {
      status: "timeout",
      error: `run.sh hit the ${intVar(env, "RUN_TIMEOUT_SECONDS", 600)}s time limit.`,
      exitCode,
      durationMs,
      cost,
      logTail,
    });
  }

  let outputRaw: string | null = null;
  for (const path of ["/work/output.json", "/work/repo/output.json"]) {
    try {
      outputRaw = (await sandbox.readFile(path)).content;
      break;
    } catch {
      /* try next */
    }
  }
  await destroyQuietly(sandbox);

  if (outputRaw === null) {
    return await finish(env, run.id, {
      status: "failed",
      error:
        exitCode === 0
          ? "run.sh exited 0 but wrote no output.json (write it to $OUTPUT_PATH)."
          : `run.sh exited with code ${exitCode} and wrote no output.json.`,
      exitCode,
      durationMs,
      cost,
      logTail,
    });
  }

  const parsed = parseOutput(outputRaw);
  if ("parseError" in parsed) {
    return await finish(env, run.id, {
      status: "failed",
      error: parsed.parseError,
      exitCode,
      durationMs,
      cost,
      logTail,
    });
  }

  const manifest = await loadManifest(env, DATASET_FOR_KIND[run.kind]);
  const scores = grade(manifest, parsed.errors);

  return await finish(env, run.id, {
    status: "succeeded",
    error: costNote ? `Cost note:${costNote}` : null,
    exitCode,
    durationMs,
    cost,
    logTail,
    scores,
  });
}

async function readLogTail(sandbox: SandboxHandle): Promise<string | null> {
  try {
    const log = (await sandbox.readFile("/work/run.log")).content;
    return log.length > 4000 ? `…${log.slice(-4000)}` : log;
  } catch {
    return null;
  }
}

async function destroyQuietly(sandbox: SandboxHandle): Promise<void> {
  try {
    await sandbox.destroy();
  } catch (e) {
    console.log(`sandbox destroy failed: ${e}`);
  }
}

async function claim(env: Env, runId: number): Promise<boolean> {
  const res = await env.DB
    .prepare("UPDATE runs SET status = 'finalizing' WHERE id = ? AND status = 'running'")
    .bind(runId)
    .run();
  return (res.meta.changes ?? 0) === 1;
}

async function getRunFresh(env: Env, id: number): Promise<RunRow | null> {
  return await env.DB.prepare("SELECT * FROM runs WHERE id = ?").bind(id).first<RunRow>();
}

interface FinishFields {
  status: string;
  error?: string | null;
  exitCode?: number | null;
  durationMs?: number | null;
  cost?: number | null;
  logTail?: string | null;
  scores?: { reported: number; matched: number; precision: number; recall: number; f1: number };
}

async function finish(env: Env, runId: number, f: FinishFields): Promise<RunRow> {
  await env.DB
    .prepare(
      `UPDATE runs SET
         status = ?, error = ?, exit_code = ?, duration_ms = ?, cost_usd = ?, log_tail = ?,
         reported = ?, matched = ?, precision = ?, recall = ?, f1 = ?,
         finished_at = datetime('now')
       WHERE id = ?`,
    )
    .bind(
      f.status,
      f.error ?? null,
      f.exitCode ?? null,
      f.durationMs ?? null,
      f.cost ?? null,
      f.logTail ?? null,
      f.scores?.reported ?? null,
      f.scores?.matched ?? null,
      f.scores?.precision ?? null,
      f.scores?.recall ?? null,
      f.scores?.f1 ?? null,
      runId,
    )
    .run();
  return (await getRunFresh(env, runId)) as RunRow;
}
