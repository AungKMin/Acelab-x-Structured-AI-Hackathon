#!/bin/bash
# Pack the sample submission into a tarball and serve it on port 8123.
# The local sandbox reaches it at:
#   http://host.docker.internal:8123/sample-submission.tar.gz
# Submit that URL as the "repo" in the UI (DEV_MODE=1 only).
set -euo pipefail
cd "$(dirname "$0")/.."

OUT_DIR=$(mktemp -d)
tar -czf "$OUT_DIR/sample-submission.tar.gz" -C examples sample-submission
echo "Tarball ready. Serving on http://localhost:8123/"
echo "Submit this as the repo URL: http://host.docker.internal:8123/sample-submission.tar.gz"
cd "$OUT_DIR"
python3 -m http.server 8123
