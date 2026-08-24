"""Sample submission for the AEC Hackathon.

Reads every document in DATASET_DIR, asks one LLM call to find errors,
and writes the findings to OUTPUT_PATH in the required schema.

This is a baseline, not a good agent. It uses only the standard
library so it runs with zero installs.
"""

import json
import os
import re
import urllib.request

DATASET_DIR = os.environ.get("DATASET_DIR", "./dataset")
OUTPUT_PATH = os.environ.get("OUTPUT_PATH", "./output.json")
API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
MODEL = "openai/gpt-4o-mini"

PROMPT = """You review construction documents. The documents below contain
deliberately injected errors: cross-document conflicts, code violations,
unit errors, and missing items.

Find the errors. Respond with ONLY a JSON object in this exact shape:

{"errors": [{"document": "<file name that contains the incorrect information>",
             "category": "cross-document-conflict|code-violation|unit-error|missing-item",
             "location": "<section or table where the error appears>",
             "description": "<one sentence: quote the wrong value and the correct value>"}]}

Documents:
"""


def read_one(path: str) -> str:
    """Extract text from a PDF; fall back to plain-text reading."""
    if path.lower().endswith(".pdf"):
        from pypdf import PdfReader  # installed by run.sh

        return "\n".join(page.extract_text() or "" for page in PdfReader(path).pages)
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        return f.read()


def read_documents() -> str:
    # The dataset is a folder of MULTIPLE files. Never hardcode names:
    # cite each file's exact name in output.json's "document" field.
    parts = []
    for name in sorted(os.listdir(DATASET_DIR)):
        path = os.path.join(DATASET_DIR, name)
        if not os.path.isfile(path):
            continue
        try:
            parts.append(f"===== {name} =====\n{read_one(path)}")
        except Exception as exc:  # noqa: BLE001 - skip unreadable files, keep going
            print(f"could not read {name}: {exc}")
    return "\n\n".join(parts)


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
    docs = read_documents()
    errors = []
    try:
        errors = extract_errors(call_llm(PROMPT + docs))
        print(f"LLM reported {len(errors)} errors")
    except Exception as exc:  # noqa: BLE001 - always write an output file
        print(f"LLM call failed: {exc}")

    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump({"errors": errors}, f, indent=2)
    print(f"Wrote {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
