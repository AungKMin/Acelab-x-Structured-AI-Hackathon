"""Sample submission for the AEC Hackathon.

Reads every supported document recursively from DATASET_DIR, extracts
content in a format appropriate to the file type, asks one LLM call to
find errors, and writes the findings to OUTPUT_PATH.

This is a baseline, not a good agent. It uses the standard library plus
pypdf (installed by run.sh) for PDF extraction.
"""

import csv
import html
import io
import json
import os
import re
import urllib.request

DATASET_DIR = os.environ.get("DATASET_DIR", "./dataset")
OUTPUT_PATH = os.environ.get("OUTPUT_PATH", "./output.json")
API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
MODEL = "openai/gpt-4o-mini"

SUPPORTED_EXTENSIONS = {".pdf", ".md", ".csv", ".html", ".htm"}

PROMPT = """You review construction documents. The documents below contain
deliberately injected errors: cross-document conflicts, code violations,
unit errors, and missing items.

Find the errors. Respond with ONLY a JSON object in this exact shape:

{"errors": [{"document": "<file path that contains the incorrect information>",
             "category": "cross-document-conflict|code-violation|unit-error|missing-item",
             "location": "<section or table where the error appears>",
             "description": "<one sentence: quote the wrong value and the correct value>"}]}

Important:
- Use the exact relative file path shown in the document headers.
- Compare information across ALL documents, not just within one file.
- For CSV files, pay attention to column names and row/record relationships.
- For HTML and Markdown, preserve headings and table structure when determining locations.
- For PDFs, use page numbers when useful in the location.
- Do not report unsupported file types or files that were not successfully read.

Documents:
"""


def read_pdf(path: str) -> str:
    """Extract PDF text while preserving page boundaries."""
    from pypdf import PdfReader  # installed by run.sh

    reader = PdfReader(path)
    pages = []

    for page_number, page in enumerate(reader.pages, start=1):
        text = page.extract_text() or ""
        pages.append(f"[Page {page_number}]\n{text}")

    return "\n\n".join(pages)


def read_markdown(path: str) -> str:
    """Read Markdown as UTF-8 while preserving its structure."""
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        text = f.read()

    # Keep Markdown intact: headings, tables, lists, code blocks, etc.
    return text


def read_csv_file(path: str) -> str:
    """Read CSV and render it as a readable table with row numbers."""
    with open(path, "r", encoding="utf-8-sig", errors="replace", newline="") as f:
        rows = list(csv.reader(f))

    if not rows:
        return ""

    # Render as a simple tabular representation rather than passing raw CSV.
    output = io.StringIO()

    headers = rows[0]
    output.write(" | ".join(headers))
    output.write("\n")
    output.write(" | ".join("---" for _ in headers))
    output.write("\n")

    for row_number, row in enumerate(rows[1:], start=2):
        # Make malformed/short rows explicit instead of silently losing data.
        if len(row) < len(headers):
            row = row + [""] * (len(headers) - len(row))
        elif len(row) > len(headers):
            row = row[:len(headers)]

        output.write(f"Row {row_number}: ")
        output.write(" | ".join(row))
        output.write("\n")

    return output.getvalue()


def read_html(path: str) -> str:
    """Extract useful text from HTML while preserving headings and tables.

    Uses only the standard library. Scripts/styles are discarded, and common
    HTML structure is converted into readable text.
    """
    from html.parser import HTMLParser

    class HTMLTextExtractor(HTMLParser):
        BLOCK_TAGS = {
            "address",
            "article",
            "aside",
            "blockquote",
            "br",
            "div",
            "dl",
            "dt",
            "dd",
            "fieldset",
            "figcaption",
            "figure",
            "footer",
            "form",
            "h1",
            "h2",
            "h3",
            "h4",
            "h5",
            "h6",
            "header",
            "hr",
            "li",
            "main",
            "nav",
            "ol",
            "p",
            "pre",
            "section",
            "table",
            "tbody",
            "td",
            "tfoot",
            "th",
            "thead",
            "tr",
            "ul",
        }

        SKIP_TAGS = {"script", "style", "noscript", "svg"}

        def __init__(self):
            super().__init__(convert_charrefs=True)
            self.parts = []
            self.skip_depth = 0

        def handle_starttag(self, tag, attrs):
            tag = tag.lower()

            if tag in self.SKIP_TAGS:
                self.skip_depth += 1
                return

            if self.skip_depth:
                return

            if tag in self.BLOCK_TAGS:
                self.parts.append("\n")

        def handle_endtag(self, tag):
            tag = tag.lower()

            if tag in self.SKIP_TAGS:
                if self.skip_depth:
                    self.skip_depth -= 1
                return

            if self.skip_depth:
                return

            if tag in self.BLOCK_TAGS:
                self.parts.append("\n")

        def handle_data(self, data):
            if not self.skip_depth:
                self.parts.append(data)

        def text(self):
            text = "".join(self.parts)
            text = html.unescape(text)

            # Normalize whitespace without destroying line structure.
            text = re.sub(r"[ \t]+", " ", text)
            text = re.sub(r"\n[ \t]+", "\n", text)
            text = re.sub(r"\n{3,}", "\n\n", text)

            return text.strip()

    with open(path, "r", encoding="utf-8", errors="replace") as f:
        source = f.read()

    parser = HTMLTextExtractor()
    parser.feed(source)
    parser.close()

    return parser.text()


def read_one(path: str) -> str:
    """Read a supported file using a format-appropriate extractor."""
    extension = os.path.splitext(path)[1].lower()

    if extension == ".pdf":
        return read_pdf(path)

    if extension == ".csv":
        return read_csv_file(path)

    if extension in {".html", ".htm"}:
        return read_html(path)

    if extension == ".md":
        return read_markdown(path)

    raise ValueError(f"unsupported file type: {extension}")


def read_documents() -> str:
    """Recursively read all supported documents under DATASET_DIR.

    File headers contain paths relative to DATASET_DIR so the LLM can return
    the exact document path in output.json.
    """
    parts = []

    for root, dirs, files in os.walk(DATASET_DIR):
        # Keep traversal deterministic.
        dirs.sort()
        files.sort()

        for name in files:
            path = os.path.join(root, name)
            extension = os.path.splitext(name)[1].lower()

            if extension not in SUPPORTED_EXTENSIONS:
                continue

            relative_path = os.path.relpath(path, DATASET_DIR)
            relative_path = relative_path.replace(os.sep, "/")

            try:
                content = read_one(path)

                if not content.strip():
                    print(f"skipping empty document: {relative_path}")
                    continue

                parts.append(
                    f"===== {relative_path} =====\n"
                    f"{content}"
                )

            except Exception as exc:  # noqa: BLE001
                # Skip unreadable files but continue processing the dataset.
                print(f"could not read {relative_path}: {exc}")

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

    if not docs:
        print(f"No supported documents found in {DATASET_DIR}")

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

