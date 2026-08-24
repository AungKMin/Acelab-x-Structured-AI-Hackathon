import type { Env, RunRow, TeamRow } from "./types";

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Unambiguous alphabet: no 0/O, 1/I/L.
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function randomCode(groups = 2, groupLen = 4): string {
  const bytes = crypto.getRandomValues(new Uint8Array(groups * groupLen));
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]);
  const parts: string[] = [];
  for (let g = 0; g < groups; g++) {
    parts.push(chars.slice(g * groupLen, (g + 1) * groupLen).join(""));
  }
  return parts.join("-");
}

export function randomToken(bytes = 24): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function getTeamByName(db: D1Database, name: string): Promise<TeamRow | null> {
  return await db.prepare("SELECT * FROM teams WHERE name = ?").bind(name).first<TeamRow>();
}

export async function authTeam(db: D1Database, name: string, code: string): Promise<TeamRow | null> {
  const team = await getTeamByName(db, name);
  if (!team) return null;
  const hash = await sha256Hex(code.trim().toUpperCase());
  return hash === team.code_hash ? team : null;
}

export async function getRun(db: D1Database, id: number): Promise<RunRow | null> {
  return await db.prepare("SELECT * FROM runs WHERE id = ?").bind(id).first<RunRow>();
}

export async function getRunningRunByDoId(db: D1Database, doId: string): Promise<RunRow | null> {
  return await db
    .prepare("SELECT * FROM runs WHERE sandbox_do_id = ? AND status IN ('running', 'finalizing') LIMIT 1")
    .bind(doId)
    .first<RunRow>();
}

// Runs that count against the team's limit. infra_error runs are free.
export async function countedRuns(db: D1Database, teamId: number, kind: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM runs WHERE team_id = ? AND kind = ? AND status != 'infra_error'")
    .bind(teamId, kind)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function activeRunCount(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM runs WHERE status IN ('running', 'finalizing')")
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export function intVar(env: Env, key: keyof Env, fallback: number): number {
  const raw = env[key];
  const n = typeof raw === "string" ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}
