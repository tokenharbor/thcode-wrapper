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

echo "Installing thcode globally via npm (from github:tokenharbor/thcode-wrapper)…"
echo

if npm i -g github:tokenharbor/thcode-wrapper; then
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
