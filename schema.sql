-- D1 schema for the AEC Hackathon grader.
-- Apply locally:  npm run db:local
-- Apply remotely: npm run db:remote

CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  code_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  kind TEXT NOT NULL CHECK (kind IN ('test', 'final')),
  repo TEXT NOT NULL,
  -- running -> finalizing -> succeeded | failed | timeout | error | infra_error
  -- infra_error runs do not count against a team's run limit.
  status TEXT NOT NULL DEFAULT 'running',
  poll_token TEXT NOT NULL,
  sandbox_id TEXT NOT NULL,
  sandbox_do_id TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  duration_ms INTEGER,
  exit_code INTEGER,
  reported INTEGER,
  matched INTEGER,
  precision REAL,
  recall REAL,
  f1 REAL,
  cost_usd REAL,
  llm_calls INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  log_tail TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_team ON runs (team_id, kind);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs (status);
CREATE INDEX IF NOT EXISTS idx_runs_do_id ON runs (sandbox_do_id);

CREATE TABLE IF NOT EXISTS llm_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  gen_id TEXT UNIQUE,
  status_code INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_llm_calls_run ON llm_calls (run_id);

-- Runtime configuration edited from /admin: event info shown to teams,
-- and answer-key overrides (keys: event_info, manifest:test, manifest:validation).
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-team OpenRouter keys pasted from team-keys.csv on /admin.
-- A key is handed to one team the first time that team loads event info.
CREATE TABLE IF NOT EXISTS key_pool (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  api_key TEXT NOT NULL,
  team_id INTEGER REFERENCES teams(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS blocked_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER,
  host TEXT NOT NULL,
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
