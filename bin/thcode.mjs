#!/usr/bin/env node
/**
 * thcode — Token Harbor coding agent
 *
 * Tiny wrapper that runs `opencode` (https://github.com/anomalyco/opencode)
 * with TH gateway configured as the default provider. On first run, asks
 * the user for their thk_live_ API key and writes opencode config so the
 * key, baseURL, and default model are all set.
 *
 * Source: https://github.com/tokenharbor/thcode-wrapper
 * License: MIT
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { ensureOpencodeInstalled, opencodeBinaryPath, refreshBranded } from "../lib/install.mjs";
import { runOnboarding } from "../lib/onboard.mjs";
import { checkForUpdateAsync, runUpdate } from "../lib/update.mjs";

const VERSION = "0.1.0-beta.1";

function xdg(name, fallback) {
  return process.env[name] || path.join(homedir(), fallback);
}

const CONFIG_DIR = path.join(xdg("XDG_CONFIG_HOME", ".config"), "opencode");
const DATA_DIR = path.join(xdg("XDG_DATA_HOME", ".local/share"), "opencode");
const CONFIG_FILE = path.join(CONFIG_DIR, "opencode.jsonc");
const AUTH_FILE = path.join(DATA_DIR, "auth.json");

if (process.argv.includes("--version") && process.argv.length === 3) {
  console.log(`thcode ${VERSION}`);
  process.exit(0);
}

if (process.argv.includes("--help") && process.argv.length === 3) {
  console.log(`thcode ${VERSION} — Token Harbor coding agent

Usage:
  thcode               Start a coding session in the current directory
  thcode update        Upgrade wrapper + branded binary to the latest
  thcode reset         Re-run onboarding (re-enter your thk_live key)
  thcode --version     Print thcode version
  thcode --help        This help

Any other args are forwarded to opencode. Run \`thcode -- --help\` for opencode's own help.

Defaults set by thcode:
  baseURL  https://tokenharbor.ai/v1
  model    tokenharbor-smart-thinking

Get a free thk_live key at https://tokenharbor.ai/dashboard

thcode checks for updates once per 24h and prints a notice in your terminal
when a newer version is available. Use \`thcode update\` to apply it.
`);
  process.exit(0);
}

if (process.argv[2] === "update") {
  await runUpdate({ binaryRefresher: refreshBranded });
  process.exit(0);
}

if (process.argv[2] === "reset") {
  for (const p of [CONFIG_FILE, AUTH_FILE]) {
    if (existsSync(p)) {
      const copy = readFileSync(p, "utf8");
      writeFileSync(`${p}.thcode-bak`, copy);
    }
  }
  console.log("thcode: previous config backed up (.thcode-bak). Re-running onboarding…\n");
}

const needsOnboard = process.argv[2] === "reset" || !hasTHProvider();

if (needsOnboard) {
  await runOnboarding({ configDir: CONFIG_DIR, dataDir: DATA_DIR, configFile: CONFIG_FILE, authFile: AUTH_FILE });
}

await ensureOpencodeInstalled();

// Fire-and-forget update check (24h cooldown). Non-blocking — finishes
// while opencode boots up, prints a one-line notice to stderr if a
// newer wrapper or binary is available.
void checkForUpdateAsync().catch(() => {});

// Forward the user's args verbatim — model + provider defaults live
// in ~/.config/opencode/opencode.jsonc, so we don't inject --model
// here (doing so caused opencode to fall through to its help screen
// instead of starting the TUI when invoked with no positional).
const args = process.argv[2] === "reset" ? process.argv.slice(3) : process.argv.slice(2);
const child = spawn(opencodeBinaryPath(), args, {
  stdio: "inherit",
  env: process.env,
});

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => child.kill(sig));
}

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});

function hasTHProvider() {
  if (!existsSync(AUTH_FILE) || !existsSync(CONFIG_FILE)) return false;
  try {
    const auth = JSON.parse(readFileSync(AUTH_FILE, "utf8"));
    if (!auth || !auth.tokenharbor || auth.tokenharbor.type !== "api") return false;
    const cfg = readFileSync(CONFIG_FILE, "utf8");
    return cfg.includes("\"tokenharbor\"") || cfg.includes("tokenharbor.ai/v1");
  } catch {
    return false;
  }
}
