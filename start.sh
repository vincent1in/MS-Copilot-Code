#!/bin/sh
# Start the gateway and open its page (macOS, Linux): `sh start.sh`.
# The same as `node dist/cli.mjs start`; add --no-open to print the page's link instead.
set -eu
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22 or later is needed, and none was found. Install it from nodejs.org, then run this again." >&2
  exit 1
fi
major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt 22 ]; then
  echo "Node.js 22 or later is needed; this computer has $(node --version)." >&2
  exit 1
fi
if [ ! -f dist/cli.mjs ]; then
  echo "dist/ is missing. In a source checkout, build it first: npm ci --ignore-scripts && npm run build" >&2
  exit 1
fi

exec node dist/cli.mjs start "$@"
