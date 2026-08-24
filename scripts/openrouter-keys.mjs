#!/usr/bin/env node
// Provision per-team OpenRouter API keys for the event.
//
//   node scripts/openrouter-keys.mjs create 20 --limit 10   # 20 keys, $10 each -> team-keys.csv
//   node scripts/openrouter-keys.mjs list                   # names, spend, status
//   node scripts/openrouter-keys.mjs smoke                  # dummy end-to-end test (~$0.001)
//   node scripts/openrouter-keys.mjs disable-all            # "expiry": run at cutoff time
//   node scripts/openrouter-keys.mjs delete-all             # cleanup after the event
//
// OpenRouter keys have spend limits but no native expiry, so the cutoff
// is `disable-all`, run at the announced end time.
//
// Requires OPENROUTER_PROVISIONING_KEY (a Provisioning key from
// openrouter.ai/settings/provisioning-keys) in the environment or .dev.vars.
// Handed-out keys land in team-keys.csv (gitignored).

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const API = "https://openrouter.ai/api/v1";
const PREFIX = "aec-team";
const CSV_PATH = "team-keys.csv";

function provisioningKey() {
  for (const name of ["OPENROUTER_MANAGEMENT_KEY", "OPENROUTER_PROVISIONING_KEY"]) {
    if (process.env[name]) return process.env[name];
    if (existsSync(".dev.vars")) {
      const m = new RegExp(`^${name}=(.+)$`, "m").exec(readFileSync(".dev.vars", "utf8"));
      if (m) return m[1].trim();
    }
  }
  console.error("Set OPENROUTER_MANAGEMENT_KEY (env or .dev.vars). Create one at openrouter.ai/settings/provisioning-keys");
  process.exit(2);
}

async function api(method, path, body) {
  const resp = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${provisioningKey()}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`${method} ${path} -> ${resp.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

async function listOurs() {
  const out = [];
  for (let offset = 0; ; offset += 100) {
    const page = await api("GET", `/keys?include_disabled=true&offset=${offset}`);
    const rows = page.data ?? [];
    out.push(...rows.filter((k) => (k.name ?? k.label ?? "").startsWith(PREFIX)));
    if (rows.length < 100) break;
  }
  return out;
}

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : fallback;
}

const cmd = process.argv[2];

if (cmd === "create") {
  const count = parseInt(process.argv[3] ?? "0", 10);
  const limit = parseFloat(arg("--limit", "10"));
  if (!count || count < 1 || count > 100) {
    console.error("Usage: create <count 1-100> [--limit 10]");
    process.exit(2);
  }
  const existing = new Set((await listOurs()).map((k) => k.name ?? k.label));
  const lines = ["team_slot,api_key"];
  for (let i = 1; i <= count; i++) {
    const name = `${PREFIX}-${String(i).padStart(2, "0")}`;
    if (existing.has(name)) {
      console.log(`skip   ${name} (already exists — its key was shown only at creation)`);
      continue;
    }
    const resp = await api("POST", "/keys", { name, limit });
    const key = resp.key ?? resp.data?.key;
    if (!key) throw new Error(`No key in response for ${name}: ${JSON.stringify(resp).slice(0, 200)}`);
    lines.push(`${name},${key}`);
    console.log(`created ${name} ($${limit} limit)`);
  }
  writeFileSync(CSV_PATH, lines.join("\n") + "\n");
  console.log(`\nWrote ${lines.length - 1} key(s) to ${CSV_PATH} (gitignored). Hand these out; keys cannot be re-read later.`);
} else if (cmd === "list") {
  const keys = await listOurs();
  if (keys.length === 0) console.log(`No keys named ${PREFIX}-*.`);
  for (const k of keys) {
    const spend = typeof k.usage === "number" ? `$${k.usage.toFixed(4)}` : "?";
    console.log(`${(k.name ?? k.label).padEnd(14)} spend ${spend.padEnd(9)} limit $${k.limit ?? "-"}  ${k.disabled ? "DISABLED" : "active"}`);
  }
} else if (cmd === "disable-all" || cmd === "delete-all") {
  const keys = await listOurs();
  for (const k of keys) {
    if (cmd === "disable-all") {
      if (!k.disabled) {
        await api("PATCH", `/keys/${k.hash}`, { disabled: true });
        console.log(`disabled ${k.name ?? k.label}`);
      }
    } else {
      await api("DELETE", `/keys/${k.hash}`);
      console.log(`deleted ${k.name ?? k.label}`);
    }
  }
  console.log(`${cmd} done: ${keys.length} key(s).`);
} else if (cmd === "smoke") {
  // Dummy end-to-end test: create a $1 key, spend a fraction of a cent
  // with it, confirm the spend registers against the key, then delete it.
  const name = `${PREFIX}-smoke`;
  console.log(`creating ${name} with $1 limit…`);
  const created = await api("POST", "/keys", { name, limit: 1 });
  const key = created.key ?? created.data?.key;
  const hash = created.data?.hash ?? created.hash;
  try {
    console.log("calling openai/gpt-4o-mini with the new key…");
    const chat = await fetch(`${API}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: "Reply with the single word: pong" }],
      }),
    });
    const data = await chat.json();
    if (!chat.ok) throw new Error(JSON.stringify(data).slice(0, 300));
    console.log(`model replied: ${data.choices?.[0]?.message?.content?.trim()}`);
    await new Promise((r) => setTimeout(r, 4000)); // usage lags a few seconds
    const info = await api("GET", `/keys/${hash}`);
    console.log(`key spend recorded: $${info.data?.usage ?? "?"} of $1 limit`);
  } finally {
    await api("DELETE", `/keys/${hash}`);
    console.log(`deleted ${name}. Smoke test done.`);
  }
} else {
  console.error("Commands: create <count> [--limit N] | list | smoke | disable-all | delete-all");
  process.exit(2);
}
