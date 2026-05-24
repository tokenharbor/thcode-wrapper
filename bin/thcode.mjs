#!/usr/bin/env node
/**
 * thcode — Token Harbor coding agent
 *
 * Tiny wrapper that runs the thcode binary (a brand fork of
 * charmbracelet/crush, at github.com/tokenharbor/thcode-crush)
 * pre-configured with the Token Harbor gateway. First run opens a
 * browser to authenticate, pulls the live /v1/models catalog, and
 * writes ~/.config/thcode/thcode.json.
 *
 * Source: https://github.com/tokenharbor/thcode-wrapper
 * License: MIT
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { codewhaleBinaryPath, ensureCodewhaleInstalled, refreshBranded } from "../lib/install.mjs";
import { hasTHProvider, refreshFromGateway, runOnboarding } from "../lib/onboard.mjs";
import { checkForUpdateAsync, runUpdate } from "../lib/update.mjs";

const VERSION = "0.3.0-beta.1";

if (process.argv.includes("--version") && process.argv.length === 3) {
  console.log(`thcode ${VERSION}`);
  process.exit(0);
}

if (process.argv.includes("--help") && process.argv.length === 3) {
  console.log(`thcode ${VERSION} — Token Harbor coding agent

Usage:
  thcode               Start a coding session in the current directory
  thcode update        Upgrade wrapper + thcode binary to latest
  thcode reset         Re-run browser login (re-issue API key)
  thcode --version     Print thcode version
  thcode --help        This help

Any other args are forwarded to the thcode binary. Run \`thcode -- --help\` for the binary's own help.

Defaults set by thcode:
  base_url  https://tokenharbor.ai/v1
  provider  Token Harbor (openai-compat)
  config    ~/.config/thcode/thcode.json (rewritten on first run)

Get a free thk_live key at https://tokenharbor.ai/dashboard
`);
  process.exit(0);
}

if (process.argv[2] === "update") {
  await runUpdate({ binaryRefresher: refreshBranded });
  process.exit(0);
}

if (process.argv[2] === "reset") {
  const cfg = path.join(homedir(), ".config", "thcode", "thcode.json");
  if (existsSync(cfg)) {
    writeFileSync(`${cfg}.bak`, readFileSync(cfg, "utf8"));
  }
  console.log(`thcode: previous config backed up to ${cfg}.bak. Re-running onboarding…\n`);
}

const needsOnboard = process.argv[2] === "reset" || !hasTHProvider();

if (needsOnboard) {
  await runOnboarding();
} else {
  // Silently refresh the model catalog every launch so new TH models
  // appear in the picker without requiring `thcode reset`. Also enforces
  // single-provider lockdown — strips any non-TH providers the user
  // hand-added. Best-effort: keeps existing config on network failure.
  await refreshFromGateway();
}

await ensureCodewhaleInstalled();

// Update check runs while codewhale boots. Stash the result for
// the on-exit notice (TUI usually clears the pre-launch message).
let pendingUpdateNotice = null;
const updateCheckPromise = checkForUpdateAsync({ quiet: true })
  .then((res) => {
    if (res && (res.wrapperUpdate || res.binaryUpdate)) {
      const reasons = [];
      if (res.wrapperUpdate) {
        reasons.push(`wrapper ${res.currentWrapperSha?.slice(0, 7) ?? "?"} → ${res.latestWrapperSha}`);
      }
      if (res.binaryUpdate) {
        reasons.push(`codewhale ${res.currentBinaryTag ?? "?"} → ${res.latestBinaryTag}`);
      }
      pendingUpdateNotice =
        `\n  thcode update available: ${reasons.join(", ")}\n` +
        `  Exit, then run:  thcode update\n`;
    }
  })
  .catch(() => {});

const args = process.argv[2] === "reset" ? process.argv.slice(3) : process.argv.slice(2);
// Provider lockdown is enforced via options.disable_default_providers
// and options.disable_provider_auto_update in the config (see
// lib/onboard.mjs buildThcodeConfig). Env vars no longer needed.
const child = spawn(codewhaleBinaryPath(), args, {
  stdio: "inherit",
  env: process.env,
});

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => child.kill(sig));
}

child.on("exit", async (code, signal) => {
  await updateCheckPromise;
  if (pendingUpdateNotice) {
    process.stderr.write(pendingUpdateNotice);
    process.stderr.write("\n  Applying update now…\n");
    try {
      await runUpdate({ binaryRefresher: refreshBranded });
    } catch (err) {
      process.stderr.write(`\n  Update failed: ${err?.message ?? err}\n`);
      process.stderr.write(`  Try manually: thcode update\n`);
    }
  }
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
