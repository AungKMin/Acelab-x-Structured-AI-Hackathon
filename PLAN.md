# Build plan — AEC QA/QC submission agent

Derived from `ultimate-what-to-do-hackathon.md` (strategy) and `system_prompt.md`
(the prompt + its integration contract). Scoring mechanics come from `src/grade.ts`,
which is the authority for every matching claim below.

## Status

| Piece | State | Verified by |
|---|---|---|
| `grade_output.py` — local grader, port of `src/grade.ts` | **done** | `python3 grade_output.py --demo` → `self-check ok` |
| `system_prompt.md` — prompt, slot contract, precedence + tiebreak rules | **drafted** | not yet exercised against a dataset |
| `agent.py` — runner: enumerate → map → fill slots → call → validate → write | not started | — |
| `run.sh` | still the sample baseline (`find_errors.py`) | — |
| value-diff candidate generator | not started | — |
| verifier / dedupe / output validator | not started | — |

## Assumptions

1. **Runtime filenames are not the local filenames.** The grader's `files.json`
   filter is `^[A-Za-z0-9._-]+$` — no spaces — so `1 - Drawings.pdf` cannot be a
   runtime name, and the practice set uses generic `schedule.pdf` / `spec.pdf`.
   Page count (7 / 3 / 2, unique per `documents.csv`) is the reliable mapping key;
   the name table in `system_prompt.md` is the fast path, token overlap the tiebreak.
2. **The whole corpus fits one prompt.** Pack `text` + `tables` + `pages.csv` +
   `page_entities.json` = 105 KB ≈ 26k tokens; runtime PDF text ≈ 11k tokens.
   Measured, not estimated. No chunking, no retrieval, no vector store.
3. **The hidden test set is probably these same documents with errors injected.**
   Digit-token diff of pypdf-extracted PDF text vs the pack: InteriorsSchedule **0**
   and MEPSchedule **0** tokens present in the PDF but absent from the pack (the
   3–4 reverse hits are `3""` CSV quote-doubling). Drawings: 38 PDF-only, all
   recognisable glue artifacts (`cpt-2cpt-3cpt-3`, `af2.1cd`). If this holds, the
   schedules have a **zero noise floor** — any unmatched runtime value is an
   injected error. Gated at runtime by measured overlap so it degrades quietly if
   the hidden set is different sheets.
4. `title_blocks.csv` / `symbols.csv` do not exist despite the pack README.
   Confirmed absent; `system_prompt.md` already forbids citing them.

## Decisions taken against the PRD

Keeping: reference-grounded detection, deterministic-vs-LLM split, adversarial
verification, dedupe, precision-aware abstention, the three-test-run protocol.

Dropping: the 28-module `src/` tree, the `models/` package, and the six-file
`reference/` preprocessing step. At 26k tokens the pack **is** the reference index;
distilling it adds a build step and a staleness bug for no capability. Files:
`agent.py`, `grade_output.py`, `system_prompt.md`, `run.sh`. Split only when one hurts.

## Milestones

**M0 · Ship-ability.** `!system_prompt.md` in `.gitignore` (the `*.md` rule would
strip the prompt from the tarball), `__pycache__/` ignored, `run.sh` → `python3 agent.py`.
→ *verify:* `git ls-files | grep system_prompt.md` is non-empty.

**M1 · Local grader.** Done.
→ *verified:* `python3 grade_output.py --demo`.

**M2 · Corpus loader + content mapping.** Per-page pypdf text; load pack `text/`,
`tables/*.csv`, `pages.csv`, `page_entities.json`; map runtime file → pack folder by
page count, tiebreak on token overlap; re-key `page_entities` to runtime names.
→ *verify:* copy the three PDFs to a temp dir as `a.pdf` / `b.pdf` / `c.pdf` — mapping
still resolves; a fourth unrelated PDF maps to nothing and falls back to raw text.

**M3 · Single-call detector.** Split `system_prompt.md` on the **last** `<<<PROMPT>>>`,
fill `<<SLOT>>`s with `str.replace`, assert no `<<` survives, one call, parse JSON.
`MODEL` a swappable constant — long context, strong, cheap enough for ~40k-token inputs.
→ *verify:* end-to-end on `examples/practice-dataset/`, scored with `grade_output.py`.
Needs a real OpenRouter key from the grader's Event tab.

**M4 · Deterministic value-diff candidates** (0 LLM calls). Bidirectional digit-token
diff, quotes collapsed, glue artifacts filtered. Direction asymmetry matters: a changed
value shows up in both directions, a deletion only as pack-only, and pack-only is where
the drawings' OCR noise lives. So **schedules: trust both directions; drawings:
runtime-only is deterministic, pack-only goes to the verifier and never auto-emits.**
→ *verify:* mutation fixture (`45 min`→`90 min`, `0.5 gpm`→`5.0 gpm`, delete a fixture
row) surfaces exactly those; clean documents stay under the measured noise floor.

**M5 · Verify, threshold, dedupe, validate.** Batched adversarial pass over candidates.
Dedupe key `(document, category, entity, attribute)`. Deterministic writer that **drops
any `document` not in the actual `$DATASET_DIR` listing** — the model will otherwise cite
`1_Drawings` or a local name, which `normDoc` silently scores as a false positive.
→ *verify:* on the fixtures, precision rises with recall flat; a hand-crafted
bad-document report is rejected.

**M6 · Budget + tarball dry-run.** Count calls, cap retries, log to stderr only, always
write `$OUTPUT_PATH`.
→ *verify:* calls ≤ 20, wall clock ≤ 3 min, and — the check nothing else catches —
download the real codeload tarball of the pushed repo, extract to a clean directory,
run it there, same output.

**M7 · Test runs.** 1 = calibrate (high P + low R → loosen candidates; the reverse →
tighten the verifier). 2 = fix only the dominant failure mode. 3 = dress rehearsal, freeze.

## Open

- **Mutation harness depth.** Text-layer injection (~30 min) covers everything downstream
  of extraction but cannot catch pypdf mangling a value *inside* the PDF — the
  `cpt-2cpt-3cpt-3` artifacts prove that failure mode is real. Real mutated PDFs via
  reportlab ≈ 2 h. Taking the cheap version; upgrade if a test run shows extraction-boundary misses.
- **The submission repo is public.** `PLAN.md` and `ultimate-what-to-do-hackathon.md` are
  readable by other teams once committed. `system_prompt.md` has to ship regardless.
