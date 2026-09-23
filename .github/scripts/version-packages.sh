#!/usr/bin/env bash
set -euo pipefail

pnpm changeset version
uv version --project python --frozen "$(node -p 'require("./python/package.json").version')"
