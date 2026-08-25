"""Submission entry point for the AEC Hackathon.

Fills system_prompt.md's slots with the pre-parsed extraction of the documents
in DATASET_DIR, makes one LLM call, and writes the findings to OUTPUT_PATH.

Documents with no extraction folder fall back to raw PDF text, so this runs
against any dataset — the practice set included.
"""

import csv
import glob
import io
import json
import os
import re
import urllib.request

DATASET_DIR = os.environ.get("DATASET_DIR", "./dataset")
OUTPUT_PATH = os.environ.get("OUTPUT_PATH", "./output.json")
API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
MODEL = "openai/gpt-4o-mini"

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
        for md in sorted(glob.glob(os.path.join(text_dir, "*.md"))):
            with open(md, encoding="utf-8") as f:
                page_text.append(f.read().replace(pack_doc, name))
        for path_csv in sorted(glob.glob(os.path.join(PACK, "tables", folder, "*.csv"))):
            with open(path_csv, encoding="utf-8") as f:
                tables.append(f"===== {name} — {os.path.basename(path_csv)} =====\n{f.read()}")

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


def build_prompt() -> str:
    with open(PROMPT_PATH, encoding="utf-8") as f:
        prompt = f.read().rsplit("<<<PROMPT>>>", 1)[1].strip()
    for token, value in build_slots().items():
        assert prompt.count(f"<<{token}>>") == 1, f"{token} must appear exactly once"
        prompt = prompt.replace(f"<<{token}>>", value)
    if "<<" in prompt:
        raise ValueError(f"unfilled slot: {re.findall(r'<<[A-Z_]+>>', prompt)}")
    return prompt


def call_llm(prompt: str) -> str:
    body = json.dumps(
        {
            "model": MODEL,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0,
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
    with urllib.request.urlopen(req, timeout=180) as resp:
        data = json.loads(resp.read())
    return data["choices"][0]["message"]["content"]


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


def main() -> None:
    errors = []
    try:
        prompt = build_prompt()
        print(f"prompt built: {len(prompt)} chars")
        errors = extract_errors(call_llm(prompt))
        print(f"LLM reported {len(errors)} errors")
    except Exception as exc:  # noqa: BLE001 - always write an output file
        print(f"run failed: {exc}")

    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump({"errors": errors}, f, indent=2)
    print(f"Wrote {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
