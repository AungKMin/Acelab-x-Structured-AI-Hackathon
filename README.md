# Acelab × Structured AI — AEC Hackathon

On any construction project the drawings, specs, and schedules disagree
in small ways. A door spec'd at a 90-minute fire rating that's scheduled
at 60. A pipe slope off by a factor of eight. Someone either catches
these by reading everything twice, or nobody does.

**Tonight, your agent does the reading.** We give you a construction
document set with injected errors. You build an agent that finds them.
We run it, grade it, and rank you on accuracy — with cost and speed as
tiebreakers.

## Play

1. Open the grader: **https://hackathon.acelabusa.com**
2. Claim a team name. Save the secret code it gives you.
3. Check the **Event** tab for your team's OpenRouter API key and links.
4. Copy [`examples/sample-submission/`](examples/sample-submission/) —
   a working baseline. Develop locally against
   [`examples/practice-dataset/`](examples/practice-dataset/).
5. Push to a **public GitHub repo** with `run.sh` at the root.
6. Submit it on the grader. You get **3 test runs** against the scored
   set, then **1 final run** against a hidden validation set.

Your `run.sh` reads the documents from `$DATASET_DIR` — a folder of
**multiple PDF files**; enumerate it, do not hardcode names — calls any
model through OpenRouter with the `OPENROUTER_API_KEY` in its
environment, and writes findings to `$OUTPUT_PATH`
(schema: [`schema.json`](schema.json)).
Cite each file's exact name in the `document` field. The practice set
mirrors the real format.
The sandbox has no internet beyond OpenRouter and the package
registries. Score = F1 against the answer key: precision counts, so
spamming guesses hurts you.

---

Everything below is for organizers: the grader is one Cloudflare Worker
that serves this page, runs each submission in an isolated sandbox,
grades the output, and ranks the teams.

## How it works

1. A team claims a name on the page and gets a secret code.
2. The team submits a public GitHub repo. The repo has `run.sh` at its root.
3. The Worker spawns a Cloudflare Sandbox, downloads the repo tarball,
   copies the document set in, and executes `run.sh` with a timeout.
4. The submission reads `$DATASET_DIR`, calls OpenRouter with
   `$OPENROUTER_API_KEY`, and writes `$OUTPUT_PATH` (`output.json`).
5. The Worker grades `output.json` against the ground-truth manifest and
   posts precision, recall, F1, wall-clock time, and LLM cost.
6. The leaderboard ranks teams by best test-run F1. Cost, then time,
   break ties. Final-run scores stay sealed until the organizers reveal
   them on `/admin.html`.

## Security model

- The sandbox has no internet access by default (`enableInternet = false`,
  HTTPS interception on). One outbound handler in `src/sandbox.ts` is the
  full allowlist: `openrouter.ai`, `pypi.org`, `files.pythonhosted.org`,
  `registry.npmjs.org`, and `codeload.github.com`.
- Teams never hold the OpenRouter key. The outbound handler swaps their
  placeholder credential for the real key on requests to `openrouter.ai`.
- The handler records each generation ID. The grader reads the true cost
  from the OpenRouter generation API, so cost cannot be self-reported.
- Blocked egress attempts are logged and visible on the admin page.
- The datasets ship inside the Worker asset bundle, but the Worker
  refuses every request to `/datasets/*`. The ground-truth manifest never
  enters the sandbox.
- `assets/datasets/test/` and `assets/datasets/validation/` are
  gitignored so they never reach the public repo. `wrangler deploy`
  still uploads them because wrangler does not read `.gitignore`.

## Local development

Requirements: Node 20+, Docker running.

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in OPENROUTER_API_KEY and ADMIN_TOKEN
npm run db:local                 # apply schema.sql to the local D1
npm run dev                      # starts on http://localhost:8787
```

Smoke test with the sample submission (second terminal):

```bash
npm run sample:serve
```

Then open http://localhost:8787, claim a team, and submit
`http://host.docker.internal:8123/sample-submission.tar.gz` as the repo.
Direct tarball URLs work only with `DEV_MODE=1`.

## Deploy

```bash
npx wrangler d1 create aec-hackathon      # paste the ID into wrangler.jsonc
npm run db:remote
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put ADMIN_TOKEN
# Replace the stub datasets in assets/datasets/{test,validation}/ first.
npx wrangler deploy
```

Requires the Workers Paid plan (containers). Do not set `DEV_MODE` in
production.

## Repository map

| Path | Purpose |
|------|---------|
| `src/index.ts` | API routes and router |
| `src/sandbox.ts` | Sandbox class, egress allowlist, key injection |
| `src/runs.ts` | Run setup, in-sandbox script, grading pipeline |
| `src/grade.ts` | Manifest matching, precision/recall/F1 |
| `src/github.ts` | Repo input → codeload tarball URL |
| `assets/` | Web UI + datasets (datasets are never served) |
| `examples/sample-submission/` | Submission template teams copy |
| `examples/practice-dataset/` | Public practice set with manifest |
| `schema.json` | **Participant contract: the shape of output.json** |
| `schemas/manifest.schema.json` | Organizer contract: the answer key |
| `docs/runbook.md` | Event-day operations |
| `schema.sql` | Internal D1 database schema (not participant-facing) |

## Dataset format

Each dataset directory holds the documents, plus:

- `files.json` — array of document file names to copy into the sandbox.
- `manifest.json` — the answer key. Formal contract:
  `schemas/manifest.schema.json`. Each error has `id`, `document`
  (the file with the incorrect information), `category`, `description`,
  and optional `page` and `keywords`.
- The submission side of the contract is `schema.json`.

A reported error matches a manifest entry when the document and category
match, and the location or description contains the page number or one
of the keywords. Matching is one-to-one: duplicate reports lower
precision and do not raise recall.

Validate a dataset before you deploy it:

```bash
npm run validate:datasets
```

## Per-team OpenRouter keys (for participants' local dev)

The grader injects its own key inside the sandbox; these hand-out keys
are for teams to develop locally. Requires
`OPENROUTER_MANAGEMENT_KEY` in `.dev.vars` (create one at
openrouter.ai → Settings → Provisioning Keys).

```bash
npm run keys -- smoke          # dummy end-to-end test (~$0.001)
npm run keys -- create 20      # 20 keys, $10 each -> team-keys.csv
npm run keys -- list           # spend per key
npm run keys -- disable-all    # the "expiry": run at the cutoff time
npm run keys -- delete-all     # cleanup after the event
```

OpenRouter keys have spend limits but no native expiry — the cutoff is
`disable-all`, run at the announced end time.
