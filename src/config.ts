import type { Env, EventInfo, KeyPoolRow, Manifest } from "./types";

// ---------------------------------------------------------------------------
// Config storage (D1 `config` table)
// ---------------------------------------------------------------------------

export async function getConfig<T>(env: Env, key: string): Promise<T | null> {
  const row = await env.DB.prepare("SELECT value FROM config WHERE key = ?").bind(key).first<{ value: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export async function setConfig(env: Env, key: string, value: unknown): Promise<void> {
  await env.DB
    .prepare(
      `INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(key, JSON.stringify(value))
    .run();
}

export async function deleteConfig(env: Env, key: string): Promise<void> {
  await env.DB.prepare("DELETE FROM config WHERE key = ?").bind(key).run();
}

export function getEventInfo(env: Env): Promise<EventInfo | null> {
  return getConfig<EventInfo>(env, "event_info");
}

// ---------------------------------------------------------------------------
// Answer-key (manifest) validation — mirrors schemas/manifest.schema.json
// ---------------------------------------------------------------------------

const CATEGORIES = new Set(["cross-document-conflict", "code-violation", "unit-error", "missing-item"]);

export function validateManifest(data: unknown): { manifest?: Manifest; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (typeof data !== "object" || data === null || !Array.isArray((data as Manifest).errors)) {
    return { errors: ['The answer key must be an object with an "errors" array.'], warnings };
  }
  const list = (data as Manifest).errors;
  if (list.length === 0) errors.push("The errors array is empty.");
  const ids = new Set<string>();
  list.forEach((e, i) => {
    const where = `error ${i + 1}${e?.id ? ` (${e.id})` : ""}`;
    if (typeof e !== "object" || e === null) return errors.push(`${where} is not an object.`);
    for (const field of ["id", "document", "category", "description"] as const) {
      if (typeof e[field] !== "string" || !e[field]?.trim()) errors.push(`${where}: "${field}" is required.`);
    }
    if (e.id) {
      if (ids.has(e.id)) errors.push(`${where}: duplicate id.`);
      ids.add(e.id);
    }
    if (e.category && !CATEGORIES.has(e.category)) {
      errors.push(`${where}: category "${e.category}" must be one of: ${[...CATEGORIES].join(", ")}.`);
    }
    if (e.page !== undefined && (!Number.isInteger(e.page) || (e.page as number) < 1)) {
      errors.push(`${where}: page must be a positive integer.`);
    }
    const hasKeywords = Array.isArray(e.keywords) && e.keywords.length > 0;
    if (e.keywords !== undefined && !hasKeywords) errors.push(`${where}: keywords must be a non-empty array of strings.`);
    if (hasKeywords && (e.keywords as unknown[]).some((k) => typeof k !== "string" || !(k as string).trim())) {
      errors.push(`${where}: every keyword must be a non-empty string.`);
    }
    if (e.page === undefined && !hasKeywords) {
      warnings.push(`${where}: no page and no keywords — any report with the right document+category will match it.`);
    }
  });
  return errors.length === 0 ? { manifest: data as Manifest, errors, warnings } : { errors, warnings };
}

// ---------------------------------------------------------------------------
// Per-team OpenRouter key pool
// ---------------------------------------------------------------------------

/** Upsert keys from pasted CSV lines "name,api_key". Never touches assigned rows' names. */
export async function importKeyPool(env: Env, csv: string): Promise<{ imported: number; skipped: string[] }> {
  const skipped: string[] = [];
  let imported = 0;
  for (const raw of csv.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^team_slot\s*,/i.test(line)) continue;
    const comma = line.indexOf(",");
    const name = comma > 0 ? line.slice(0, comma).trim() : "";
    const key = comma > 0 ? line.slice(comma + 1).trim() : "";
    if (!name || !key.startsWith("sk-or-")) {
      skipped.push(line.slice(0, 40));
      continue;
    }
    await env.DB
      .prepare(
        `INSERT INTO key_pool (name, api_key) VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET api_key = excluded.api_key`,
      )
      .bind(name, key)
      .run();
    imported++;
  }
  return { imported, skipped };
}

/** The team's assigned key, assigning the next free pool key on first call. */
export async function assignedKeyForTeam(env: Env, teamId: number): Promise<KeyPoolRow | null> {
  const mine = await env.DB.prepare("SELECT * FROM key_pool WHERE team_id = ? LIMIT 1").bind(teamId).first<KeyPoolRow>();
  if (mine) return mine;
  const free = await env.DB
    .prepare("SELECT id FROM key_pool WHERE team_id IS NULL ORDER BY id LIMIT 1")
    .first<{ id: number }>();
  if (!free) return null;
  const claimed = await env.DB
    .prepare("UPDATE key_pool SET team_id = ? WHERE id = ? AND team_id IS NULL")
    .bind(teamId, free.id)
    .run();
  if ((claimed.meta.changes ?? 0) !== 1) return assignedKeyForTeam(env, teamId); // lost a race; retry
  return await env.DB.prepare("SELECT * FROM key_pool WHERE id = ?").bind(free.id).first<KeyPoolRow>();
}

export interface KeyStats {
  usage: number | null;
  limit: number | null;
  disabled: boolean | null;
}

export const TEAM_KEY_PREFIX = "aec-team";

export function managementToken(env: Env): string | null {
  return env.OPENROUTER_MANAGEMENT_KEY ?? env.OPENROUTER_PROVISIONING_KEY ?? null;
}

interface RemoteKey {
  name: string;
  hash: string;
  usage: number | null;
  limit: number | null;
  disabled: boolean | null;
}

/** All keys on the OpenRouter account, via the management (provisioning) API. */
async function listRemoteKeys(env: Env): Promise<RemoteKey[]> {
  const token = managementToken(env);
  if (!token) return [];
  const out: RemoteKey[] = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const resp = await fetch(`https://openrouter.ai/api/v1/keys?include_disabled=true&offset=${offset}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!resp.ok) break;
    const page = (await resp.json()) as {
      data?: { name?: string; label?: string; hash?: string; usage?: number; limit?: number; disabled?: boolean }[];
    };
    const rows = page.data ?? [];
    for (const k of rows) {
      const name = k.name ?? k.label;
      if (name && k.hash) {
        out.push({
          name,
          hash: k.hash,
          usage: typeof k.usage === "number" ? k.usage : null,
          limit: typeof k.limit === "number" ? k.limit : null,
          disabled: typeof k.disabled === "boolean" ? k.disabled : null,
        });
      }
    }
    if (rows.length < 100) break;
  }
  return out;
}

/** Live spend/limit per key name. Empty map when no management key is set. */
export async function fetchKeyStats(env: Env): Promise<Map<string, KeyStats>> {
  const stats = new Map<string, KeyStats>();
  try {
    for (const k of await listRemoteKeys(env)) {
      stats.set(k.name, { usage: k.usage, limit: k.limit, disabled: k.disabled });
    }
  } catch (e) {
    console.log(`key stats fetch failed: ${e}`);
  }
  return stats;
}

/**
 * Disable (cutoff, reversible on OpenRouter) or delete (permanent) every
 * aec-team-* key on the OpenRouter account. Delete also empties the pool.
 */
export async function bulkTeamKeys(env: Env, action: "disable" | "delete"): Promise<{ count: number }> {
  const token = managementToken(env);
  if (!token) throw new Error("The OPENROUTER_MANAGEMENT_KEY Worker secret is not set.");
  const keys = (await listRemoteKeys(env)).filter((k) => k.name.startsWith(TEAM_KEY_PREFIX));
  let count = 0;
  for (const k of keys) {
    const resp =
      action === "disable"
        ? k.disabled
          ? null
          : await fetch(`https://openrouter.ai/api/v1/keys/${k.hash}`, {
              method: "PATCH",
              headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
              body: JSON.stringify({ disabled: true }),
            })
        : await fetch(`https://openrouter.ai/api/v1/keys/${k.hash}`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${token}` },
          });
    if (resp === null || resp.ok) count++;
    else console.log(`bulk ${action} failed for ${k.name}: ${resp.status}`);
  }
  if (action === "delete") {
    await env.DB.prepare("DELETE FROM key_pool").run();
  }
  return { count };
}
