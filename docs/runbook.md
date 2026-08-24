# Event-day runbook

## The admin page (/admin, unlocked with ADMIN_TOKEN)

Everything event-day lives there:

- **All runs** — final scores visible, void button per run.
- **Event info** — links, docs URL, a shared API key, and the
  Structured AI API section. Saved here, shown to signed-in teams on
  the Event tab.
- **Answer keys** — paste and save the test/validation answer key JSON.
  Saving overrides the deployed manifest.json at grade time with
  validation; no redeploy. Clear reverts to the bundled file.
- **Team OpenRouter keys** — paste team-keys.csv. Each signed-in team
  is auto-assigned the next free key and sees it on the Event tab with
  live spend and limit. The spend/limit columns need the
  `OPENROUTER_PROVISIONING_KEY` Worker secret:
  `npx wrangler secret put OPENROUTER_PROVISIONING_KEY`.

## Before doors open

1. Replace the stub datasets in `assets/datasets/test/` and
   `assets/datasets/validation/`. Update `files.json` and
   `manifest.json` in each. Keep individual files under ~10 MB.
2. Dry-run the scored set: run the sample submission against it and
   confirm the errors are findable and the manifest matches sane reports.
3. Confirm secrets: `wrangler secret list` shows `OPENROUTER_API_KEY`
   and `ADMIN_TOKEN`. Confirm `DEV_MODE` is NOT set.
4. Set a spend limit on the OpenRouter key from the OpenRouter dashboard.
5. Deploy: `npx wrangler deploy`. Load the page, claim a throwaway team,
   and run the sample submission end to end. Delete the throwaway team
   from `/admin.html`.

## During the event

Open `/admin.html` and keep it up. It shows all runs (final scores
included), blocked egress attempts, and teams.

Common situations:

| Situation | Action |
|-----------|--------|
| Team burned a run on our bug or an infra hiccup | Void the run on the admin page. Voided runs do not count against the limit. |
| Team lost its code | Delete the team on the admin page. The team claims the name again. Their old runs disappear from the leaderboard. |
| Team squats a name | Delete the team. |
| Run stuck in "Running" | The grader auto-fails it 5 minutes after the timeout. To force it, have the team poll (keep the page open) or void the run. |
| Blocked egress spam from one team | Talk to them. Blocked calls are logged with the run ID. |
| All slots busy | `MAX_CONCURRENT_RUNS` is 3. Raise it in wrangler.jsonc (also raise `max_instances`) and redeploy, or tell teams to retry. |

## Reveal final results

Final scores are visible only on `/admin.html` (sort by kind = final).
Announce them from there. Teams see "sealed" on their side.

## Knobs (wrangler.jsonc vars, redeploy to change)

| Var | Default | Meaning |
|-----|---------|---------|
| `MAX_TEST_RUNS` | 3 | Scored test runs per team |
| `MAX_FINAL_RUNS` | 1 | Final validation runs per team |
| `RUN_TIMEOUT_SECONDS` | 600 | Wall clock limit for `run.sh` |
| `MAX_CONCURRENT_RUNS` | 3 | Simultaneous sandboxes |
| `MAX_LLM_CALLS_PER_RUN` | 300 | OpenRouter calls per run |
| `MAX_REPO_MB` | 25 | Repo tarball size cap |

## Per-team OpenRouter keys

Hand-out keys for participants' local development. Needs
`OPENROUTER_PROVISIONING_KEY` in `.dev.vars`.

1. Dummy test first: `npm run keys -- smoke` (creates a $1 key, makes
   one tiny LLM call with it, confirms the spend registers, deletes it).
2. Provision: `npm run keys -- create 20` → `team-keys.csv` (gitignored).
   Keys cannot be re-read later; hand them out from the CSV.
3. Watch spend during the event: `npm run keys -- list`.
4. Cutoff (OpenRouter has no native key expiry): at the announced end
   time run `npm run keys -- disable-all`. To arm it in advance on a
   machine that stays awake (10:00 PM New York):

   ```bash
   nohup bash -c 'while [ "$(TZ=America/New_York date +%H%M)" -lt 2200 ]; do sleep 60; done; node scripts/openrouter-keys.mjs disable-all' > keys-cutoff.log 2>&1 &
   ```

5. After the event: `npm run keys -- delete-all`.

## Cost control

- Cost per run is measured from the OpenRouter generation API and shown
  per run. There is no hard per-run dollar cap; the call cap and the
  timeout bound it. The OpenRouter key spend limit is the backstop.
- Sandboxes are destroyed right after grading. Idle sandboxes sleep
  after 20 minutes at the latest.
