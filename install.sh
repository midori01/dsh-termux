#!/data/data/com.termux/files/usr/bin/bash
# One-command installer for DeepSeek Harness on Termux:
#   curl -fsSL https://raw.githubusercontent.com/midori01/dsh-termux/main/install.sh | bash
# Extra arguments go to `dsh-termux install`, e.g. `| bash -s -- --tag next`.
set -euo pipefail
REPO=midori01/dsh-termux
REF=${DSH_TERMUX_REF:-main}

here=""
[ -n "${BASH_SOURCE[0]-}" ] && [ -f "${BASH_SOURCE[0]}" ] && here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if [ -n "$here" ] && [ -f "$here/dsh-termux" ] && [ -d "$here/runtime" ]; then
  exec bash "$here/dsh-termux" install "$@"
fi

command -v curl >/dev/null && command -v tar >/dev/null || pkg install -y curl tar
tmp=$(mktemp -d "${TMPDIR:-/data/data/com.termux/files/usr/tmp}/dsh-termux.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
sha=$(curl -fsSL -H 'Accept: application/vnd.github.sha' "https://api.github.com/repos/$REPO/commits/$REF")
[[ $sha =~ ^[0-9a-f]{40}$ ]] || { echo "error: cannot resolve $REPO@$REF" >&2; exit 1; }
curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$sha" | tar -xz -C "$tmp" --strip-components=1
DSH_TERMUX_REV=$sha bash "$tmp/dsh-termux" install "$@"
