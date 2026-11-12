#!/bin/sh
# Build the downloadable release: release/opencode-m365-copilot-<version>.zip.
#
# Run it from a clean checkout, after `npm ci --ignore-scripts` and `npm test`. The zip
# holds, at the committed state:
#   - every tracked file (`git archive`: the source, tests, docs, lockfile and the
#     start scripts);
#   - dist/, built here, with no route off the machine where `unshare` allows it;
#   - node_modules/playwright and playwright-core, as `npm ci` installed them from the
#     lockfile. The gateway uses them only to open the sign-in window;
#   - BUILD-INFO.txt, and SHA256SUMS: a hash of every other file in the folder.
# Timestamps come from the commit and entries are sorted, so the same commit and
# toolchain give the same zip.
set -eu
cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain)" ]; then
  echo "The working tree has uncommitted changes; commit or stash them so the zip matches a commit." >&2
  exit 1
fi

version=$(node -p 'require("./package.json").version')
name="opencode-m365-copilot-$version"
commit=$(git rev-parse HEAD)
SOURCE_DATE_EPOCH=$(git log -1 --format=%ct HEAD)
export SOURCE_DATE_EPOCH

# The two shipped packages must be the versions the lockfile pins (npm ci checked
# their hashes when it installed them).
node -e '
const lock = require("./package-lock.json").packages;
for (const name of ["playwright", "playwright-core"]) {
  const pinned = lock["node_modules/" + name];
  const installed = require("./node_modules/" + name + "/package.json").version;
  if (!pinned || pinned.version !== installed) {
    console.error(name + " " + installed + " is not the locked version; run npm ci --ignore-scripts");
    process.exit(1);
  }
}'

# Build with no network where the platform allows it (a user namespace needs no root).
if command -v unshare >/dev/null 2>&1 && unshare -rn true 2>/dev/null; then
  unshare -rn sh -c 'npm run build >/dev/null 2>&1'
else
  npm run build >/dev/null 2>&1
fi

out=release
stage="$out/$name"
rm -rf "${stage:?}" "$out/$name.zip" "$out/$name.zip.sha256"
mkdir -p "$stage/node_modules"

git archive --format=tar HEAD | tar -x -C "$stage"
cp -R dist "$stage/dist"
cp -R node_modules/playwright node_modules/playwright-core "$stage/node_modules/"

cat > "$stage/BUILD-INFO.txt" <<EOF
opencode-m365-copilot $version
commit:        $commit
built with:    Node $(node --version)
dist/:         built from this commit's source and package-lock.json
node_modules/: playwright and playwright-core only, as locked in package-lock.json

To check every file against SHA256SUMS (macOS, Linux):
  shasum -a 256 -c SHA256SUMS
EOF

chmod -R u=rwX,go=rX "$stage"
chmod 755 "$stage/start.sh" "$stage/scripts/release.sh"
(cd "$stage" && find . -type f ! -name SHA256SUMS -print | LC_ALL=C sort | sed 's|^\./||' | while IFS= read -r file; do
  sha256sum "$file"
done > SHA256SUMS)
find "$stage" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +

(cd "$out" && find "$name" -print | LC_ALL=C sort | TZ=UTC zip -X -D -q -@ "$name.zip")
(cd "$out" && sha256sum "$name.zip" > "$name.zip.sha256")

echo "$out/$name.zip"
cat "$out/$name.zip.sha256"
