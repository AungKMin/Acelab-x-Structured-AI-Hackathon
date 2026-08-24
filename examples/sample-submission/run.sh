#!/bin/bash
# Entry point. The grader executes this file at the repo root.
#
# Environment provided by the runner:
#   DATASET_DIR         - directory with the document set (read-only use)
#   OUTPUT_PATH         - where to write output.json
#   OPENROUTER_API_KEY  - credential for https://openrouter.ai/api/v1
#
# Install extra dependencies here if you need them, for example:
#   pip install my-package
set -e
pip3 install --quiet pypdf
python3 find_errors.py
