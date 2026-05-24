#!/usr/bin/env bash
# thcode installer — installs the npm wrapper directly from GitHub
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/tokenharbor/thcode-wrapper/main/install.sh | bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
DIM='\033[0;2m'
BOLD='\033[1m'
NC='\033[0m'

echo
echo -e "${BOLD}thcode${NC} — Token Harbor coding agent"
echo -e "${DIM}https://github.com/tokenharbor/thcode-wrapper${NC}"
echo

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo -e "${RED}Missing dependency:${NC} $1"
    echo "$2"
    exit 1
  fi
}

need node "Install Node.js 18+ first:  https://nodejs.org/  or  brew install node  or  apt install nodejs"
need npm  "npm comes with Node.js — re-install Node from https://nodejs.org/"

node_major=$(node -p "process.versions.node.split('.')[0]")
if [ "$node_major" -lt 18 ]; then
  echo -e "${RED}Node.js ${node_major} is too old.${NC} thcode needs Node 18 or newer."
  echo "  Update:  https://nodejs.org/"
  exit 1
fi

# Auto-switch to a home-dir npm prefix when /usr/local isn't writable
# without sudo. Avoids the whole class of EACCES / half-extract /
# spawn-sh-ENOENT errors from /usr/local/lib/node_modules ownership
# tangles. Idempotent: re-running just confirms the setting is right.
npm_prefix=$(npm config get prefix 2>/dev/null || echo "/usr/local")
nm_dir="${npm_prefix}/lib/node_modules"
if [ ! -w "${nm_dir}" ] 2>/dev/null && [ ! -w "${npm_prefix}/lib" ] 2>/dev/null; then
    home_prefix="${HOME}/.npm-global"
    echo -e "${DIM}${npm_prefix} not writable — switching npm prefix to ${home_prefix} to avoid sudo.${NC}"
    mkdir -p "${home_prefix}/bin"
    npm config set prefix "${home_prefix}" >/dev/null 2>&1 || true
    npm_prefix="${home_prefix}"
    # Add to PATH for the rest of this shell session and persist for
    # future shells. zsh + bash both honored.
    case ":$PATH:" in
      *":${home_prefix}/bin:"*) : ;;  # already there
      *) export PATH="${home_prefix}/bin:$PATH" ;;
    esac
    for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
        if [ -f "$rc" ] && ! grep -qsF ".npm-global/bin" "$rc"; then
            printf '\nexport PATH=%s/bin:$PATH\n' "${home_prefix}" >> "$rc"
        fi
    done
fi

# Clean up half-broken install dirs from previous failed attempts.
# npm doesn't re-extract over a partial install — it tries to spawn
# the postinstall script in-place and ENOENTs when the working dir
# is missing files. Re-running install while broken state lingers
# just re-hits the same error. One-shot cleanup makes the install
# self-healing.
thcode_install_dir="${npm_prefix}/lib/node_modules/thcode"
if [ -d "${thcode_install_dir}" ] && [ ! -f "${thcode_install_dir}/package.json" ]; then
    echo -e "${DIM}Cleaning up half-installed dir at ${thcode_install_dir}…${NC}"
    if [ -w "${npm_prefix}/lib/node_modules" ]; then
        rm -rf "${thcode_install_dir}"
    else
        echo -e "${RED}Cannot remove ${thcode_install_dir} — run this once then re-run install:${NC}"
        echo "  sudo rm -rf ${thcode_install_dir}"
        exit 1
    fi
fi
# Also clear npm cache entries for the package — broken tarballs
# from upstream dep churn (e.g. effect@4.0.0 missing src/dist in
# the 2026-05-24 publish) otherwise stay cached and re-fail.
npm cache clean --force >/dev/null 2>&1 || true

echo "Installing thcode globally via npm…"
echo

# Method: download the wrapper tarball directly + `npm i -g .` on
# the extracted dir. AVOIDS `npm i -g github:...` which is broken on
# Node 25 (npm's github-clone path spawn-sh-ENOENTs mid-install) and
# also pulls more reliably through corporate proxies that allow
# codeload.github.com but block the raw github clone protocol.
work_dir="${TMPDIR:-/tmp}/thcode-install-$$"
mkdir -p "${work_dir}"
trap "rm -rf '${work_dir}'" EXIT
tarball="${work_dir}/thcode-wrapper.tar.gz"

if ! curl -fsSL --retry 3 --retry-delay 2 \
        "https://codeload.github.com/tokenharbor/thcode-wrapper/tar.gz/refs/heads/main" \
        -o "${tarball}"; then
    echo -e "${RED}Failed to download wrapper tarball.${NC} Check your network or try again later."
    exit 1
fi

if ! tar -xzf "${tarball}" -C "${work_dir}"; then
    echo -e "${RED}Failed to extract wrapper tarball.${NC}"
    exit 1
fi

extracted_dir="${work_dir}/thcode-wrapper-main"
if [ ! -f "${extracted_dir}/package.json" ]; then
    echo -e "${RED}Extracted tarball is missing package.json.${NC}"
    exit 1
fi

if (cd "${extracted_dir}" && npm i -g .); then
  # Stamp the installed wrapper SHA so the in-process update checker
  # can later tell when GitHub is ahead of the user's local copy.
  if command -v curl >/dev/null 2>&1; then
    sha=$(curl -fsSL "https://api.github.com/repos/tokenharbor/thcode-wrapper/commits/main" 2>/dev/null \
          | grep -m1 '"sha"' \
          | head -1 \
          | sed -E 's/.*"sha": *"([^"]+)".*/\1/')
    if [ -n "${sha:-}" ]; then
      mkdir -p "$HOME/.thcode"
      printf '%s' "$sha" > "$HOME/.thcode/wrapper-sha"
    fi
  fi
  echo
  echo -e "${GREEN}Installed.${NC}  Try it:"
  echo
  echo "  thcode"
  echo
  echo "On first run, paste your thk_live_ key. Grab one at:"
  echo "  https://tokenharbor.ai/dashboard/api-keys"
  echo
else
  echo
  echo -e "${RED}Install failed.${NC}"
  echo "If it was a permission error, try:"
  echo "  sudo npm i -g github:tokenharbor/thcode-wrapper"
  echo "Or set npm to install in your home dir:"
  echo "  npm config set prefix ~/.npm-global && export PATH=~/.npm-global/bin:\$PATH"
  exit 1
fi
