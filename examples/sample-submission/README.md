# Sample submission

This is the submission template. Copy it, make it smart, push it to a
public GitHub repo, and submit the repo on the grader page.

## The contract

- The grader clones your repo into a sandbox and runs `run.sh` at the
  repo root.
- Read the document set from `$DATASET_DIR`: a folder of **multiple PDF
  files**. Enumerate the directory; never hardcode file names. The
  file names are the IDs you cite in your output.
- Write your findings to `$OUTPUT_PATH` as JSON:

```json
{
  "errors": [
    {
      "document": "plumbing-spec.pdf",
      "category": "cross-document-conflict",
      "location": "section 22 30 00",
      "description": "Spec lists WH-1 at 50 gallons; the schedule lists 80 gallons."
    }
  ]
}
```

- `document` is the file that contains the **incorrect** information.
- Categories: `cross-document-conflict`, `code-violation`, `unit-error`,
  `missing-item`.
- Call LLMs through `https://openrouter.ai/api/v1` with the
  `OPENROUTER_API_KEY` from the environment. Any model works.

## Test locally

```bash
export OPENROUTER_API_KEY=sk-or-...   # your own key for local tests
export DATASET_DIR=../practice-dataset
export OUTPUT_PATH=./output.json
bash run.sh
```

Grade yourself against `../practice-dataset/manifest.json`.
