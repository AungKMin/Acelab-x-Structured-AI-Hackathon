import type { Sandbox } from "./sandbox";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  Sandbox: DurableObjectNamespace<Sandbox>;

  // Secrets
  OPENROUTER_API_KEY: string;
  ADMIN_TOKEN: string;
  // Optional (either name): enables live per-team key spend/limit display
  // and the admin disable-all / delete-all key buttons.
  OPENROUTER_PROVISIONING_KEY?: string;
  OPENROUTER_MANAGEMENT_KEY?: string;
  DEV_MODE?: string;

  // Vars (wrangler.jsonc)
  MAX_TEST_RUNS: string;
  MAX_FINAL_RUNS: string;
  RUN_TIMEOUT_SECONDS: string;
  MAX_CONCURRENT_RUNS: string;
  MAX_LLM_CALLS_PER_RUN: string;
  MAX_REPO_MB: string;
}

export type RunKind = "test" | "final";

export interface TeamRow {
  id: number;
  name: string;
  code_hash: string;
  created_at: string;
}

export interface RunRow {
  id: number;
  team_id: number;
  kind: RunKind;
  repo: string;
  status: string;
  poll_token: string;
  sandbox_id: string;
  sandbox_do_id: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  exit_code: number | null;
  reported: number | null;
  matched: number | null;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  cost_usd: number | null;
  llm_calls: number;
  error: string | null;
  log_tail: string | null;
}

export interface ManifestError {
  id?: string;
  document: string;
  category: string;
  page?: number;
  keywords?: string[];
  location?: string;
  description?: string;
}

export interface Manifest {
  errors: ManifestError[];
}

export interface ReportedError {
  id?: string;
  document?: string;
  category?: string;
  location?: string;
  description?: string;
}

/** Event info edited on /admin and shown to signed-in teams. */
export interface EventInfo {
  links?: { label: string; url: string }[];
  shared_key?: { label?: string; value?: string };
  structured_ai?: { docs_url?: string; base_url?: string; api_key?: string; notes?: string };
  notes?: string;
}

export interface KeyPoolRow {
  id: number;
  name: string;
  api_key: string;
  team_id: number | null;
}
