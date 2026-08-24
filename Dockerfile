# Sandbox image for submission runs.
# The tag must match the installed @cloudflare/sandbox package version.
FROM docker.io/cloudflare/sandbox:0.12.7

# The base image ships Node 22 and Bun but no Python. Add Python 3 plus
# common LLM client libraries so runs start fast. Teams can install more
# in run.sh (pypi.org and registry.npmjs.org are allowed).
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip python3-venv \
  && rm -rf /var/lib/apt/lists/* \
  && pip3 install --no-cache-dir openai httpx requests pypdf

# Required for local development port exposure.
EXPOSE 8080
