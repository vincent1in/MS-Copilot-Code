#!/bin/sh
# Install or update the opencode-m365-copilot gateway from this repository's latest
# GitHub release, on macOS or Linux.
#
#   curl -fsSL https://github.com/vincent1in/MS-Copilot-Code/releases/latest/download/install.sh | sh
#
# What it does, in order:
#   1. Downloads two files from the latest release on github.com (GitHub hands the
#      download to its file host, release-assets.githubusercontent.com):
#      opencode-m365-copilot.zip and opencode-m365-copilot.zip.sha256.
#   2. Checks the zip against that SHA-256, then every file in it against its own
#      SHA256SUMS list. It stops on any mismatch and installs nothing.
#   3. Puts the gateway in ~/.local/share/opencode-m365-copilot, replacing an older
#      copy there. Your settings and sign-in are kept: they live in
#      ~/.config/opencode-copilot, not in this folder.
#   4. Starts the gateway's page, unless you ran it with --no-start.
#
# It downloads nothing else, runs no installer and needs no npm. It does not change
# OpenCode's config: the page's Connect OpenCode button does that when you press it.
#
# Options (after `sh -s --` when piped):
#   --no-start   install only
#   --dir PATH   install somewhere else (or set M365_GATEWAY_DIR)
#   --zip PATH   install a zip you already downloaded, checked against PATH.sha256
#                beside it; nothing is downloaded
set -eu

REPO="vincent1in/MS-Copilot-Code"
NAME="opencode-m365-copilot"
BASE="https://github.com/$REPO/releases/latest/download"

say() { printf '%s\n' "$*"; }
fail() {
  printf 'install: %s\n' "$*" >&2
  exit 1
}

download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --proto '=https' --tlsv1.2 -o "$2" "$1"
  else
    wget -q --https-only -O "$2" "$1"
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# Check every file in the current folder against SHA256SUMS; print only what failed.
check_sums() {
  if command -v sha256sum >/dev/null 2>&1; then
    report=$(sha256sum -c SHA256SUMS 2>&1) && return 0
  else
    report=$(shasum -a 256 -c SHA256SUMS 2>&1) && return 0
  fi
  printf '%s\n' "$report" | grep -v ': OK$' >&2
  return 1
}

main() {
  start=yes
  zip=""
  dest="${M365_GATEWAY_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/$NAME}"
  while [ $# -gt 0 ]; do
    case "$1" in
      --no-start) start=no ;;
      --dir)
        [ $# -ge 2 ] || fail "--dir needs a folder"
        dest="$2"
        shift
        ;;
      --zip)
        [ $# -ge 2 ] || fail "--zip needs a file"
        zip="$2"
        shift
        ;;
      *) fail "unknown option: $1" ;;
    esac
    shift
  done

  [ -n "$zip" ] || command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || fail "needs curl or wget"
  command -v unzip >/dev/null 2>&1 || fail "needs unzip"
  command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || fail "needs sha256sum or shasum"
  if command -v node >/dev/null 2>&1; then
    major=$(node -p 'parseInt(process.versions.node)')
    [ "$major" -ge 22 ] || say "Note: the gateway needs Node.js 22 or later, and this is $(node --version)."
  else
    say "Note: the gateway needs Node.js 22 or later, which isn't installed. Installing anyway."
    start=no
  fi

  tmp=$(mktemp -d "${TMPDIR:-/tmp}/$NAME.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT INT TERM

  if [ -n "$zip" ]; then
    [ -f "$zip" ] && [ -f "$zip.sha256" ] || fail "--zip needs the zip, and its .sha256 file beside it"
    say "Installing $zip, checked against $zip.sha256. Nothing is downloaded."
    cp "$zip" "$tmp/$NAME.zip"
    cp "$zip.sha256" "$tmp/$NAME.zip.sha256"
  else
    say "Downloading the latest release from github.com/$REPO:"
    say "  $NAME.zip"
    download "$BASE/$NAME.zip" "$tmp/$NAME.zip" || fail "could not download $BASE/$NAME.zip"
    say "  $NAME.zip.sha256"
    download "$BASE/$NAME.zip.sha256" "$tmp/$NAME.zip.sha256" || fail "could not download $BASE/$NAME.zip.sha256"
  fi

  expected=$(cut -d' ' -f1 "$tmp/$NAME.zip.sha256" | tr 'A-F' 'a-f')
  actual=$(sha256_of "$tmp/$NAME.zip")
  [ -n "$expected" ] && [ "$expected" = "$actual" ] || fail "the zip's SHA-256 is $actual, not the published $expected. Nothing was installed."
  say "Checked the zip: SHA-256 $actual"

  mkdir "$tmp/unzipped"
  unzip -q "$tmp/$NAME.zip" -d "$tmp/unzipped"
  folder=""
  for candidate in "$tmp/unzipped/$NAME"-*; do
    [ -d "$candidate" ] && folder="$candidate"
  done
  [ -n "$folder" ] && [ -f "$folder/dist/cli.mjs" ] && [ -f "$folder/SHA256SUMS" ] || fail "the zip doesn't hold the gateway's folder. Nothing was installed."
  (cd "$folder" && check_sums) || fail "a file in the zip doesn't match its SHA256SUMS entry. Nothing was installed."
  version=$(sed -n '1s/^[^ ]* //p' "$folder/BUILD-INFO.txt")
  say "Checked every file in it against SHA256SUMS: version $version"

  mkdir -p "$(dirname "$dest")"
  if [ -e "$dest" ]; then
    [ -f "$dest/BUILD-INFO.txt" ] || [ -f "$dest/dist/cli.mjs" ] || fail "$dest exists and isn't a copy of the gateway; choose another folder with --dir."
    rm -rf "$dest.previous"
    mv "$dest" "$dest.previous"
    mv "$folder" "$dest"
    rm -rf "$dest.previous"
    say "Updated the gateway in $dest to $version."
    say "If OpenCode is running, restart it to load the new version."
  else
    mv "$folder" "$dest"
    say "Installed the gateway in $dest."
  fi

  rm -rf "$tmp"
  trap - EXIT INT TERM
  if [ "$start" = yes ]; then
    say ""
    say "Starting the gateway's page. Stop it with Ctrl+C; start it again with:"
    say "  node \"$dest/dist/cli.mjs\" start"
    exec node "$dest/dist/cli.mjs" start
  fi
  say "Start the gateway's page with: node \"$dest/dist/cli.mjs\" start"
}

main "$@"
