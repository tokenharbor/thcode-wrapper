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

# Clean up half-broken install dirs from previous failed attempts.
# npm doesn't re-extract over a partial install — it tries to spawn
# the postinstall script in-place and ENOENTs when the working dir
# is missing files. Re-running install while broken state lingers
# just re-hits the same error. One-shot cleanup makes the install
# self-healing.
npm_prefix=$(npm config get prefix 2>/dev/null || echo "/usr/local")
thcode_install_dir="${npm_prefix}/lib/node_modules/thcode"
if [ -d "${thcode_install_dir}" ] && [ ! -f "${thcode_install_dir}/package.json" ]; then
    echo -e "${DIM}Cleaning up half-installed dir at ${thcode_install_dir}…${NC}"
    if [ -w "${npm_prefix}/lib/node_modules" ]; then
        rm -rf "${thcode_install_dir}"
    else
        sudo rm -rf "${thcode_install_dir}"
    fi
fi
# Also clear npm cache entries for the package — broken tarballs
# from upstream dep churn (e.g. effect@4.0.0 missing src/dist in
# the 2026-05-24 publish) otherwise stay cached and re-fail.
npm cache clean --force >/dev/null 2>&1 || true

echo "Installing thcode globally via npm (from github:tokenharbor/thcode-wrapper)…"
echo

if npm i -g github:tokenharbor/thcode-wrapper; then
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
