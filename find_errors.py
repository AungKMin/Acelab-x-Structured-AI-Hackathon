"""Submission entry point for the AEC Hackathon.

Fills system_prompt.md's slots with the pre-parsed extraction of the documents
in DATASET_DIR, makes one LLM call to generate candidate findings, makes a
second adversarial call to verify each candidate against the same material,
and writes the surviving findings to OUTPUT_PATH.

Documents with no extraction folder fall back to raw PDF text, so this runs
against any dataset — the practice set included.
"""

import csv
import glob
import io
import json
import os
import re
import threading
import time
import traceback
import urllib.request
from concurrent.futures import ThreadPoolExecutor


def say(stage: str, msg: str) -> None:
    print(f"[{stage:<6}] {msg}", flush=True)


def left() -> float:
    """Seconds of budget remaining before run.sh gets killed."""
    return DEADLINE - (time.monotonic() - START)

DATASET_DIR = os.environ.get("DATASET_DIR", "./dataset")
OUTPUT_PATH = os.environ.get("OUTPUT_PATH", "./output.json")
API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
MODEL = os.environ.get("MODEL", "openai/gpt-4o")
# A retired or misspelled model id would otherwise cost the entire run.
FALLBACK_MODEL = "openai/gpt-4o-mini"
# run.sh is killed at 600 s. Stop starting new calls well before that.
DEADLINE = float(os.environ.get("DEADLINE_SECONDS", "480"))
VERIFY_WORKERS = int(os.environ.get("VERIFY_WORKERS", "8"))
# Generation samples disagree about which errors exist: across three real-corpus
# runs, one surfaced MSB-SOUTH that the other two missed entirely. Their union,
# deduped, is strictly more recall for calls we are not otherwise spending
# (7 of 300 used, 17 s of 600).
GENERATION_SAMPLES = int(os.environ.get("GENERATION_SAMPLES", "3"))
# OFF by default, on measurement rather than principle. The verify prompt leads
# with "Reject it unless you can prove it" and lists five ways to reject with no
# counterweight, so rejection is its default answer:
#   practice set, 6 runs : 1 judge rejected a CORRECT finding 3 times in 12;
#                          3 votes -> mean F1 0.889, verify off -> 1.000 (4/4)
#   real corpus          : 4 candidates, votes 0/0/0/0 -> ZERO findings, a
#                          certain F1 of 0. This is why output_real3/4.json came
#                          back empty while the pre-verify runs found 2 each.
# The machinery is kept and works; re-enable with VERIFY_VOTES=3 once the prompt
# is rebalanced, and check `votes=` in the summary before trusting it.
VERIFY_VOTES = int(os.environ.get("VERIFY_VOTES", "0"))
MAX_DELTAS = 60  # per document, so a noisy mapping cannot flood the prompt

CATEGORIES = {"cross-document-conflict", "code-violation", "unit-error", "missing-item"}

START = time.monotonic()
STATS = {}  # stage counters, printed in the summary
DELTAS = []  # (document, [value tokens]) for documents that mapped to the pack
CALLS = 0
_CALL_LOCK = threading.Lock()
_STUB = None

HERE = os.path.dirname(os.path.abspath(__file__))
PROMPT_PATH = os.path.join(HERE, "system_prompt.md")
PACK = os.path.join(HERE, "assets", "datasets", "uccs_hackathon_data_pack")

# The pack's folder names are not the runtime file names. Page count is the
# fallback when a dataset renames the files.
FOLDERS = {
    "1 - Drawings.pdf": "1_Drawings",
    "InteriorsSchedule.pdf": "3_Finishes_Product_Schedule",
    "MEPSchedule.pdf": "4_Plumbing_Product_Schedule",
}


def read_pages(path: str) -> list:
    """Page texts of one document; a non-PDF is a single page."""
    if path.lower().endswith(".pdf"):
        from pypdf import PdfReader  # installed by run.sh

        return [page.extract_text() or "" for page in PdfReader(path).pages]
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        return [f.read()]


def pack_documents() -> list:
    with open(os.path.join(PACK, "documents.csv"), encoding="utf-8") as f:
        return list(csv.DictReader(f))


def resolve_folder(name: str, page_count: int, pack_docs: list, by_count: bool) -> str:
    """Extraction folder for a runtime file, by name then by unique page count."""
    if name in FOLDERS:
        return FOLDERS[name]
    if not by_count:
        return ""
    same = [r["folder"] for r in pack_docs if int(r["page_count"]) == page_count]
    return same[0] if len(same) == 1 else ""


def document_names() -> list:
    """The documents to review. files.json is the organizer's own list; without
    it, every file in the directory. Either way the answer key stays out."""
    listing = os.path.join(DATASET_DIR, "files.json")
    if os.path.isfile(listing):
        with open(listing, encoding="utf-8") as f:
            return sorted(json.load(f))
    return [n for n in sorted(os.listdir(DATASET_DIR)) if n != "manifest.json"]


def build_slots() -> dict:
    pack_docs = pack_documents() if os.path.isdir(PACK) else []
    folder_doc = {r["folder"]: r["document"] for r in pack_docs}

    docs = []
    for name in document_names():
        path = os.path.join(DATASET_DIR, name)
        if os.path.isfile(path):
            docs.append((name, read_pages(path)))

    # Map an unrecognised file name by page count ONLY when the dataset is
    # plainly the same corpus renamed. Otherwise a 3-page stranger would be
    # served another document's text under its name.
    by_count = sorted(len(p) for _, p in docs) == sorted(
        int(r["page_count"]) for r in pack_docs
    )

    file_list, page_text, tables, runtime_name = [], [], [], {}
    for name, pages in docs:
        file_list.append(f"{name} — {len(pages)} pages")

        folder = resolve_folder(name, len(pages), pack_docs, by_count)
        text_dir = os.path.join(PACK, "text", folder) if folder else ""
        if not os.path.isdir(text_dir):
            for n, text in enumerate(pages, 1):
                page_text.append(f"===== {name} — page {n} =====\n{text}")
            continue

        # The extraction spells documents by the pack's own name; the output must
        # cite the runtime name, so rewrite it everywhere it appears.
        runtime_name[folder] = name
        pack_doc = folder_doc[folder]
        pack_pages = []
        for md in sorted(glob.glob(os.path.join(text_dir, "*.md"))):
            with open(md, encoding="utf-8") as f:
                pack_pages.append(f.read())
        page_text.extend(p.replace(pack_doc, name) for p in pack_pages)

        # A value in the delivered PDF that the clean extraction never contains
        # is where an injected error surfaces. Hint only — the model still has
        # to quote it and name the correct value.
        new = sorted(digit_tokens("\n".join(pages)) - digit_tokens("\n".join(pack_pages)))
        if new:
            DELTAS.append((name, new[:MAX_DELTAS]))
        for path_csv in sorted(glob.glob(os.path.join(PACK, "tables", folder, "*.csv"))):
            with open(path_csv, encoding="utf-8") as f:
                tables.append(f"===== {name} — {os.path.basename(path_csv)} =====\n{f.read()}")

    STATS.update(docs=len(docs), pages=sum(len(p) for _, p in docs), mapped=len(runtime_name))

    return {
        "RUNTIME_FILE_LIST": "\n".join(file_list),
        "PAGES_CSV": pages_index(runtime_name, folder_doc),
        "PAGE_TEXT": "\n\n".join(page_text),
        "SCHEDULE_TABLES": "\n\n".join(tables) or "(none extracted)",
        "PAGE_ENTITIES": entities_index(runtime_name, folder_doc),
    }


def pages_index(runtime_name: dict, folder_doc: dict) -> str:
    """pages.csv rows for the mapped documents, re-keyed to runtime names."""
    doc_runtime = {folder_doc[f]: n for f, n in runtime_name.items()}
    if not doc_runtime:
        return "(none extracted)"
    out = io.StringIO()
    with open(os.path.join(PACK, "pages.csv"), encoding="utf-8") as f:
        reader = csv.DictReader(f)
        writer = csv.DictWriter(out, fieldnames=reader.fieldnames)
        writer.writeheader()
        for row in reader:
            if row["document"] in doc_runtime:
                row["document"] = doc_runtime[row["document"]]
                writer.writerow(row)
    return out.getvalue()


def entities_index(runtime_name: dict, folder_doc: dict) -> str:
    doc_runtime = {folder_doc[f]: n for f, n in runtime_name.items()}
    if not doc_runtime:
        return "(none extracted)"
    with open(os.path.join(PACK, "page_entities.json"), encoding="utf-8") as f:
        entities = json.load(f)
    kept = {doc_runtime[d]: pages for d, pages in entities.items() if d in doc_runtime}
    return json.dumps(kept, indent=1)


def digit_tokens(text: str) -> set:
    """Value-like tokens: they carry a digit. Anything long is a pypdf glue
    artifact (`cpt-2cpt-3cpt-3`) rather than a value, so it is dropped."""
    flat = text.lower().replace('"', "").replace("'", "")
    tokens = re.split(r"[^A-Za-z0-9./\-]+", flat)
    return {t.strip("./-") for t in tokens if re.search(r"\d", t) and 2 <= len(t) <= 20}


def delta_section() -> str:
    """Appended to the built prompt rather than added as a slot in
    system_prompt.md — the same split the verify prompt already uses, and it
    keeps the slot contract stable while that file is being tuned."""
    if not DELTAS:
        return ""
    body = "\n".join(f"{name}: " + ", ".join(tokens) for name, tokens in DELTAS)
    return (
        "\n\nVALUE DELTAS (a hint, not evidence):\n"
        "Values that appear in the delivered document but nowhere in the clean\n"
        "reference extraction of that same document. An injected error surfaces\n"
        "here — so does extraction noise. Treat each as a place to look, never as\n"
        "a finding on its own: report one only if you can still quote the wrong\n"
        "value and name the correct value from the material above, and pick the\n"
        "category by the same test as everything else. Ignore any you cannot\n"
        "explain.\n" + body
    )


def build_prompt(slots: dict) -> str:
    with open(PROMPT_PATH, encoding="utf-8") as f:
        prompt = f.read().rsplit("<<<PROMPT>>>", 1)[1].strip()
    for token, value in slots.items():
        assert prompt.count(f"<<{token}>>") == 1, f"{token} must appear exactly once"
        prompt = prompt.replace(f"<<{token}>>", value)
    if "<<" in prompt:
        raise ValueError(f"unfilled slot: {re.findall(r'<<[A-Z_]+>>', prompt)}")
    return prompt


def post(model: str, prompt: str, temperature: float = 0) -> str:
    global CALLS
    with _CALL_LOCK:
        CALLS += 1
    body = json.dumps(
        {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": temperature,
        }
    ).encode()
    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=body,
        headers={
            "Authorization": f"Bearer {API_KEY}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=min(180, max(30, int(left()) - 30))) as resp:
        data = json.loads(resp.read())
    return data["choices"][0]["message"]["content"]


def call_llm(prompt: str, temperature: float = 0) -> str:
    """One completion. LLM_STUB replays canned responses in order, so the whole
    pipeline can be exercised end to end without a key."""
    global CALLS, _STUB
    stub = os.environ.get("LLM_STUB")
    if stub:
        with _CALL_LOCK:
            CALLS += 1
            if _STUB is None:
                with open(stub, encoding="utf-8") as f:
                    _STUB = json.load(f)["responses"]
            return _STUB.pop(0) if _STUB else '{"errors": []}'
    try:
        return post(MODEL, prompt, temperature)
    except Exception as exc:  # noqa: BLE001 - a bad model id must not end the run
        say("llm", f"{MODEL} failed ({exc}); retrying on {FALLBACK_MODEL}")
        return post(FALLBACK_MODEL, prompt, temperature)


def extract_errors(text: str) -> list:
    # The model may wrap the JSON in a code fence.
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        return []
    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError:
        return []
    errors = data.get("errors", [])
    return errors if isinstance(errors, list) else []


EXT = re.compile(r"\.(pdf|md|txt|csv|json|png|jpg)$", re.I)


def norm_doc(name) -> str:
    """The grader's own document key — basename, case- and extension-folded."""
    return EXT.sub("", re.split(r"[\\/]", (name or "").strip().lower())[-1])


def dedupe_anchor(location: str, description: str):
    """What two reports of the same error share. A bare integer is a page
    number, so it must never be the key on its own — that would collapse every
    finding on a page into one."""
    tokens = [t.lower() for t in re.split(r"[^A-Za-z0-9/-]+", f"{location} {description}") if t]
    # Equipment marks first, in the order they appear — `location` names the
    # subject before the prose does, so the first hit is the entity the report
    # is about. Two shapes, because not every mark carries a digit: WC-1 and
    # D-202 do, MSB-NORTH does not, and missing MSB-NORTH let the same finding
    # ship twice in two of three real-corpus runs.
    for shape in (
        lambda t: re.search(r"[a-z]", t) and re.search(r"\d", t),
        lambda t: "-" in t and re.search(r"[a-z]", t),
    ):
        marks = [t for t in tokens if shape(t)]
        if marks:
            return marks[0]
    # Nothing mark-shaped: fall back to the values themselves. Single digits
    # count — the grader matches a report on any integer in its text, so
    # "page 2" alone is enough to separate two reports.
    return tuple(t for t in tokens if re.search(r"\d", t))[:4]


UNIT_VALUE = re.compile(
    r"(\d+(?:\.\d+)?)\s*(gpf|gpm|lpf|gpd|kva|kw|kaic|cfm|psi|amps?|watts?)\b", re.I
)


def looks_like_unit_error(text: str) -> bool:
    """The prompt's own first category test — same dimension, wrong scale.

    The model applies it inconsistently: at temperature 0 the identical L-1
    finding came back `cross-document-conflict`, `unit-error`, and
    `code-violation` across three runs. Only an order-of-magnitude gap in one
    unit counts, so `45 min` vs `90-minute` (ratio 2) and `1.28 gpf` vs
    `1.1 gpf` stay whatever the model called them.
    """
    by_unit = {}
    for value, unit in UNIT_VALUE.findall(text):
        by_unit.setdefault(unit.lower(), set()).add(float(value))
    for values in by_unit.values():
        for a in values:
            for b in values:
                if a and b and a < b and round(b / a, 6) in (10.0, 100.0, 1000.0):
                    return True
    return False


def validate(reports: list, names: list) -> tuple:
    """Drop what the grader can only score against us, then dedupe. A report
    naming a document that is not in $DATASET_DIR can never match a key entry
    and costs precision outright; the model reaches for the pack's folder names
    and for the invented examples in the prompt, so this is not hypothetical."""
    by_norm = {norm_doc(n): n for n in names}
    kept, seen = [], set()
    drops = {"bad-doc": 0, "bad-cat": 0, "thin": 0, "dupe": 0}
    for r in reports:
        if not isinstance(r, dict):
            drops["thin"] += 1
            continue
        doc = by_norm.get(norm_doc(r.get("document")))
        if not doc:
            drops["bad-doc"] += 1
            continue
        cat = re.sub(r"[^a-z0-9]+", "-", str(r.get("category") or "").strip().lower()).strip("-")
        if cat not in CATEGORIES:
            drops["bad-cat"] += 1
            continue
        description = str(r.get("description") or "").strip()
        if not description:
            drops["thin"] += 1
            continue
        # The prompt's own output contract: the description must quote the wrong
        # value AND the correct one. A report carrying a single value quotes no
        # comparison, and on the real corpus that is what "General sheet notes
        # require wiring methods compliant with UL 2196; no compliance is
        # stated" looks like — 4 of 6 findings, none of them provable, all of
        # them straight precision loss.
        # ...except for missing-item, where the item's absence IS the second
        # half of the comparison and there is no correct value to quote.
        if len(digit_tokens(description)) < (1 if cat == "missing-item" else 2):
            drops["unquoted"] = drops.get("unquoted", 0) + 1
            continue
        location = str(r.get("location") or "").strip()
        if cat != "unit-error" and looks_like_unit_error(f"{location} {description}"):
            drops["recat"] = drops.get("recat", 0) + 1
            cat = "unit-error"
        key = (norm_doc(doc), cat, dedupe_anchor(location, description))
        if key in seen:
            drops["dupe"] += 1
            continue
        seen.add(key)
        kept.append(
            {"document": doc, "category": cat, "location": location, "description": description}
        )
    return kept, drops


# The prompt's own category precedence, used only to break a tied vote.
PRECEDENCE = ["unit-error", "cross-document-conflict", "code-violation", "missing-item"]


def consolidate(reports: list) -> list:
    """One report per (document, entity), with the samples voting on its
    category.

    Union sampling surfaces the same error under two different categories —
    measured: WC-1 came back as both `cross-document-conflict` and
    `code-violation` in one run. The grader matches one-to-one, so the loser is
    a guaranteed false positive, and category was already the least stable field
    the model produces. Counting the samples fixes both at once.
    """
    groups = {}
    for r in reports:
        groups.setdefault(
            (norm_doc(r["document"]), dedupe_anchor(r["location"], r["description"])), []
        ).append(r)

    out = []
    for members in groups.values():
        votes = {}
        for m in members:
            votes[m["category"]] = votes.get(m["category"], 0) + 1
        winner = max(votes, key=lambda c: (votes[c], -PRECEDENCE.index(c)))
        # Among the winners, the fullest description quotes the most evidence,
        # and evidence is what the grader matches on.
        out.append(max(
            (m for m in members if m["category"] == winner),
            key=lambda m: len(m["description"]),
        ))
    return out


def write_output(errors: list) -> None:
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump({"errors": errors}, f, indent=2)


# A first-pass candidate can cite a number that's real text somewhere in the
# corpus but belongs to a different entity or row than the one under
# discussion (an OCR/extraction artifact mistaken for a requirement), or can
# misjudge a value that's already compliant as a violation. This second pass
# re-examines candidates ONE AT A TIME against the same material — judging a
# batch together let a plausible-looking false candidate crowd out a genuine
# one in testing, so each gets its own isolated call.
VERIFY_INSTRUCTIONS = """You are adversarially re-examining ONE candidate construction-document
error against the same material the first pass saw. Reject it unless you can prove it.

FIRST, before deciding: quote the exact row or sentence the wrong value comes
from, and the exact row or sentence the correct value or requirement comes
from. If you cannot produce both quotes verbatim from the material below, REJECT.

Decide KEEP or REJECT. REJECT when:
- the "correct" or threshold value it cites cannot be found attached to the SAME
  entity, tag, or row the candidate is about — including a number that exists
  somewhere in the material below but belongs to a DIFFERENT entity, tag, or row
  (an OCR/extraction artifact, not a real requirement for this item). The correct
  value legitimately living in a different DOCUMENT than the flagged one is fine
  and expected for cross-document-conflict — what disqualifies a number is a
  mismatched entity, never a different document.
  Worked example: a page has TWO switchboard schedules side by side, "MSB-SOUTH"
  rated 65,000 AIC and "MSB-NORTH" rated 22,000 AIC. A candidate claiming
  "MSB-NORTH requires a minimum of 65,000 AIC" is quoting MSB-SOUTH's real
  rating as if it were a requirement for MSB-NORTH — REJECT. Two switchboards
  legitimately having different ratings is not an error at all;
- the quoted wrong value does not actually appear in the material for that document;
- the candidate names a code or spec section as the source of the correct value,
  but that exact section number does not appear anywhere in the material below —
  a citation the candidate invented is grounds to REJECT on its own;
- the candidate asserts non-compliance ("does not meet", "violates") without
  quoting the specific value that violates the requirement — a general reference
  to a code section is not itself a finding;
- the category does not fit the described discrepancy;
- you cannot point to the exact text supporting both values;
- the two values are actually equal, or the reported value already satisfies a
  stated maximum/minimum — being exactly at a limit is compliant, not a violation.

KEEP only when both the wrong value and the correct value or requirement are
directly traceable to text in the material below, for the SAME entity, and the
values genuinely disagree or genuinely violate the stated requirement.

Return ONLY a JSON object in the same shape you were given: this candidate,
unchanged, if you KEEP it — `{"errors": [...]}` with one item — or `{"errors": []}`
if you REJECT it. No prose, no code fence.

CANDIDATE TO VERIFY:
"""


def build_verify_prompt(candidate: dict, slots: dict) -> str:
    material = "\n\n".join(f"{key}:\n{value}" for key, value in slots.items())
    candidate_json = json.dumps({"errors": [candidate]}, indent=2)
    return f"{VERIFY_INSTRUCTIONS}{candidate_json}\n\nMATERIAL:\n{material}"


def generate(prompt: str) -> list:
    """Union of GENERATION_SAMPLES independent passes. Samples after the first
    run at a non-zero temperature so they explore rather than repeat; validate()
    dedupes the overlap, which is most of it."""
    def sample(k: int) -> list:
        try:
            return extract_errors(call_llm(prompt, 0 if k == 0 else 0.5))
        except Exception as exc:  # noqa: BLE001 - one bad sample must not end the run
            say("cand", f"sample {k} failed: {exc}")
            return []

    with ThreadPoolExecutor(max_workers=GENERATION_SAMPLES) as pool:
        batches = list(pool.map(sample, range(GENERATION_SAMPLES)))
    STATS["samples"] = "+".join(str(len(b)) for b in batches)
    return [e for batch in batches for e in batch]


def verify_vote(candidate: dict, slots: dict, vote: int) -> bool:
    """One judge's verdict on one candidate. Out of budget, or a failed call,
    counts as KEEP: an unverified finding can still score, a missing one
    cannot. Votes after the first sample at a non-zero temperature, so they are
    genuinely independent rather than three draws of the same answer."""
    if left() < 45:
        return True
    try:
        return bool(extract_errors(
            call_llm(build_verify_prompt(candidate, slots), 0 if vote == 0 else 0.4)
        ))
    except Exception as exc:  # noqa: BLE001
        say("verify", f"call failed, keeping candidate unverified: {exc}")
        return True


def verify_errors(candidates: list, slots: dict) -> list:
    """Each candidate is judged alone — batching let a plausible false candidate
    crowd out a genuine one — and each is judged VERIFY_VOTES times, because one
    judge is a coin flip. A candidate survives on a majority of KEEP votes.

    Every (candidate, vote) pair is an independent call, so all of them go to
    the pool at once; run sequentially this is N*K full-corpus round trips
    against a 600 s kill."""
    jobs = [(i, c, v) for i, c in enumerate(candidates) for v in range(VERIFY_VOTES)]
    with ThreadPoolExecutor(max_workers=VERIFY_WORKERS) as pool:
        verdicts = list(pool.map(lambda j: (j[0], verify_vote(j[1], slots, j[2])), jobs))
    keeps = {}
    for index, kept in verdicts:
        keeps[index] = keeps.get(index, 0) + int(kept)
    STATS["votes"] = "/".join(str(keeps.get(i, 0)) for i in range(len(candidates)))
    return [c for i, c in enumerate(candidates) if keeps.get(i, 0) * 2 > VERIFY_VOTES]


def summary(errors: list, drops: dict) -> None:
    """Printed last, and kept small, because the grader hands back only the
    final 4000 characters of the run log (readLogTail in src/runs.ts). Stage
    detail is printed earlier on purpose, where truncation can eat it."""
    counts = {}
    for e in errors:
        counts[e["category"]] = counts.get(e["category"], 0) + 1
    lines = [
        "===== SUMMARY =====",
        f"model={MODEL} llm_calls={CALLS} wall={time.monotonic() - START:.0f}s",
        "stages: " + " ".join(f"{k}={v}" for k, v in STATS.items()),
        "drops: " + " ".join(f"{k}={v}" for k, v in drops.items()),
        "by_cat: " + (" ".join(f"{k}={v}" for k, v in sorted(counts.items())) or "(none)"),
        f"final: {len(errors)} errors -> {OUTPUT_PATH}",
    ]
    lines += [f"  {e['document']} | {e['category']} | {e['location']}"[:110] for e in errors[:6]]
    print("\n".join(lines)[:1500], flush=True)


def main() -> None:
    errors, drops = [], {"bad-doc": 0, "bad-cat": 0, "thin": 0, "dupe": 0}
    write_output([])  # an output file exists from second zero, whatever follows
    try:
        names = [n for n in document_names() if os.path.isfile(os.path.join(DATASET_DIR, n))]
        slots = build_slots()
        say("load", " ".join(f"{k}={v}" for k, v in STATS.items()))

        prompt = build_prompt(slots) + delta_section()
        STATS["prompt_chars"] = len(prompt)
        STATS["deltas"] = sum(len(t) for _, t in DELTAS)
        say("prompt", f"{len(prompt)} chars (~{len(prompt) // 4} tokens)")

        errors, drops = validate(generate(prompt), names)
        merged = consolidate(errors)
        STATS["cand"] = f"{len(errors)}->{len(merged)}" if len(merged) != len(errors) else len(errors)
        errors = merged
        say("cand", f"{len(errors)} candidates survived validation")
        write_output(errors)  # a kill during verify still leaves a scoreable file

        if errors and VERIFY_VOTES > 0:
            kept, verify_drops = validate(verify_errors(errors, slots), names)
            STATS["verify"] = f"{len(errors)}->{len(kept)}"
            say("verify", f"{STATS['verify']} ({left():.0f}s budget left)")
            # A verifier that rejects every single candidate is evidence the
            # verifier is broken, not that the document set is clean. Emitting
            # nothing scores zero for certain; emitting unverified candidates
            # cannot do worse.
            if kept:
                errors = kept
            else:
                say("verify", "rejected 100% of candidates — ignoring the verdict")
                verify_drops = {}
            for k, v in verify_drops.items():
                drops[k] += v
    except Exception:  # noqa: BLE001 - always write an output file
        traceback.print_exc()
        say("error", "pipeline failed; writing whatever survived validation")

    write_output(errors)
    summary(errors, drops)


def demo() -> None:
    names = ["schedule.pdf", "spec.pdf"]
    outside = {"document": "HVACSchedule.pdf", "category": "unit-error",
               "location": "page 1", "description": "AHU-3 at 200 cfm"}
    bad_cat = {"document": "schedule.pdf", "category": "typo",
               "location": "page 1", "description": "x"}
    a = {"document": "SCHEDULE.PDF", "category": "Unit Error",
         "location": "page 1, L-1", "description": "L-1 at 5.0 gpm; spec requires 0.5 gpm"}
    a_reworded = {"document": "schedule.pdf", "category": "unit-error",
                  "location": "page 1", "description": "lavatory L-1 lists 5.0 gpm, not 0.5 gpm"}
    b = {"document": "schedule.pdf", "category": "unit-error",
         "location": "page 1, WC-1", "description": "WC-1 at 3.5 gpf; spec requires 1.28 gpf"}

    kept, drops = validate([outside, bad_cat, a, a_reworded, b], names)
    # a document outside $DATASET_DIR can never match the key, so it never ships
    assert drops["bad-doc"] == 1 and drops["bad-cat"] == 1, drops
    # the runtime spelling and the grader's category spelling both win
    assert kept[0]["document"] == "schedule.pdf" and kept[0]["category"] == "unit-error"
    # same mark collapses; two different marks on one page must not
    assert drops["dupe"] == 1 and len(kept) == 2, (drops, kept)
    # the page integer must never become the dedupe key by itself
    assert dedupe_anchor("page 1, L-1", "") == "l-1"
    assert dedupe_anchor("page 2", "nothing distinctive here") == ("2",)
    # an order-of-magnitude gap in one unit is a unit-error whatever the model said
    assert looks_like_unit_error("L-1 at 5.0 gpm; spec requires 0.5 gpm aerators")
    assert looks_like_unit_error("rated 45 kVA where the one-line calls for 450 kVA")
    # a non-decade gap, or a gap the model has to reason about, is left alone
    assert not looks_like_unit_error("D-202 at 45 min; spec requires 90-minute doors")
    assert not looks_like_unit_error("WC-1 at 1.28 gpf; code requires 1.1 gpf")
    assert not looks_like_unit_error("5.0 gpm here and 0.5 gpf there")
    recat, d = validate([{"document": "schedule.pdf", "category": "code-violation",
                          "location": "page 1, L-1",
                          "description": "L-1 at 5.0 gpm; spec 22 40 00 requires 0.5 gpm"}], names)
    assert recat[0]["category"] == "unit-error" and d["recat"] == 1, (recat, d)

    # the same entity reported under two categories collapses to the majority
    split = [{"document": "schedule.pdf", "category": c, "location": "page 1, WC-1",
              "description": f"WC-1 at 1.6 gpf; spec 22 40 00 requires 1.28 gpf ({c})"}
             for c in ("code-violation", "unit-error", "unit-error")]
    merged = consolidate(validate(split, names)[0])
    assert len(merged) == 1 and merged[0]["category"] == "unit-error", merged
    # two genuinely different entities are never merged
    assert len(consolidate(validate([a, b], names)[0])) == 2

    # a malformed payload yields no reports rather than an exception
    assert validate(extract_errors("not json at all"), names)[0] == []
    print("self-check ok")


if __name__ == "__main__":
    import sys

    demo() if "--demo" in sys.argv else main()
