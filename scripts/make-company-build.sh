#!/bin/bash
# Builds the company-internal variant of the iOS Coverage for GitLab extension.
#
# The open-source extension keeps all GitLab hosts optional (one-time grant via the
# toolbar icon). The company build bakes the company GitLab host and Coverage server
# into manifest.json so anyone who installs it sees coverage immediately after
# opening an MR link - no configuration and no clicks.
#
# Usage:
#   IOSCOVERAGE_GITLAB_ORIGIN=https://git.example.com \
#   IOSCOVERAGE_SERVER_ORIGIN=http://coverage.intra.example.com:8765 \
#   ./scripts/make-company-build.sh
#
# Output: dist/company/ (load this directory in chrome://extensions as unpacked).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist/company"

GITLAB_ORIGIN="${IOSCOVERAGE_GITLAB_ORIGIN:-}"
SERVER_ORIGIN="${IOSCOVERAGE_SERVER_ORIGIN:-}"
if [[ -z "$GITLAB_ORIGIN" || -z "$SERVER_ORIGIN" ]]; then
  echo "error: set IOSCOVERAGE_GITLAB_ORIGIN and IOSCOVERAGE_SERVER_ORIGIN" >&2
  exit 1
fi

GITLAB_ORIGIN="$(python3 - "$GITLAB_ORIGIN" <<'PY'
import sys
from urllib.parse import urlparse
url = urlparse(sys.argv[1])
if (
    url.scheme != "https"
    or url.netloc != url.hostname
    or url.path not in ("", "/")
    or url.query or url.fragment
):
    raise SystemExit("GitLab origin must be an exact HTTPS origin without a port or path")
sys.stdout.write(sys.argv[1].rstrip("/"))
PY
)"
SERVER_ORIGIN="$(python3 - "$SERVER_ORIGIN" <<'PY'
import sys
from urllib.parse import urlparse
url = urlparse(sys.argv[1])
if (
    url.scheme not in ("http", "https")
    or url.username or url.password
    or url.path not in ("", "/")
    or url.query or url.fragment
):
    raise SystemExit("server origin must be an exact http/https origin without path, query, or credentials")
sys.stdout.write(sys.argv[1].rstrip("/"))
PY
)"

rm -rf "$OUT"
mkdir -p "$OUT"

cp -R "$ROOT/src" "$OUT/src"
cp "$ROOT/manifest.json" "$OUT/manifest.json"

python3 - "$OUT/manifest.json" "$GITLAB_ORIGIN" "$SERVER_ORIGIN" <<'PY'
import json
import sys

manifest_path, gitlab_origin, server_origin = sys.argv[1:4]
manifest = json.load(open(manifest_path, encoding="utf-8"))

manifest["host_permissions"] = [
    gitlab_origin + "/*",
    server_origin + "/*",
]
manifest["content_scripts"] = [{
    "matches": [gitlab_origin + "/*"],
    "js": [
        "src/shared/contracts.js",
        "src/content/gitlab-url.js",
        "src/content/gitlab-dom-adapter.js",
        "src/content/coverage-renderer.js",
        "src/content/entry.js",
    ],
    "css": ["src/content/styles.css"],
    "run_at": "document_idle",
}]

with open(manifest_path, "w", encoding="utf-8") as handle:
    json.dump(manifest, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
PY

cp "$ROOT/LICENSE" "$OUT/LICENSE"
echo "Company build created at $OUT"
echo "  GitLab origin: $GITLAB_ORIGIN"
echo "  Coverage server origin: $SERVER_ORIGIN"
echo "Load $OUT as an unpacked extension in chrome://extensions."
