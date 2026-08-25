#!/bin/bash
# Entry point. The grader executes this file at the repo root.
#
# Environment provided by the runner:
#   DATASET_DIR         - directory with the document set (read-only use)
#   OUTPUT_PATH         - where to write output.json
#   OPENROUTER_API_KEY  - credential for https://openrouter.ai/api/v1
#
# No `set -e`: every exit path here must still reach find_errors.py, which
# writes an output file before it does anything else. A run that ends with no
# file scores zero, and that is a worse outcome than any partial result.
#
# pypdf ships in the sandbox image (see Dockerfile), so the install is only a
# safety net for a different image — and its failure must not stop the run.
python3 -c 'import pypdf' 2>/dev/null || pip3 install --quiet pypdf || true

python3 find_errors.py
