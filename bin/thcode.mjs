#!/usr/bin/env node
/**
 * thcode — Token Harbor coding agent
 *
 * Tiny wrapper that runs codewhale (formerly DeepSeek-TUI) with
 * TH gateway configured as the default provider. First run opens
 * a browser to authenticate and writes ~/.deepseek/config.toml.
 *
 * Source: https://github.com/tokenharbor/thcode-wrapper
 * License: MIT
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { codewhaleBinaryPath, ensureCodewhaleInstalled, refreshBranded } from "../lib/install.mjs";
import { hasTHProvider, runOnboarding } from "../lib/onboard.mjs";
import { checkForUpdateAsync, runUpdate } from "../lib/update.mjs";

const VERSION = "0.2.1-beta.2";

if (process.argv.includes("--version") && process.argv.length === 3) {
  console.log(`thcode ${VERSION}`);
  process.exit(0);
}

if (process.argv.includes("--help") && process.argv.length === 3) {
  console.log(`thcode ${VERSION} — Token Harbor coding agent

Usage:
  thcode               Start a coding session in the current directory
  thcode update        Upgrade wrapper + codewhale to latest
  thcode reset         Re-run browser login (re-issue API key)
  thcode --version     Print thcode version
  thcode --help        This help

Any other args are forwarded to codewhale. Run \`thcode -- --help\` for codewhale's own help.

Defaults set by thcode:
  base_url  https://tokenharbor.ai/v1
  model     tokenharbor-smart-thinking
  provider  openai-compatible

Get a free thk_live key at https://tokenharbor.ai/dashboard
`);
  process.exit(0);
}

if (process.argv[2] === "update") {
  await runUpdate({ binaryRefresher: refreshBranded });
  process.exit(0);
}

if (process.argv[2] === "reset") {
  const cfg = path.join(homedir(), ".deepseek", "config.toml");
  if (existsSync(cfg)) {
    writeFileSync(`${cfg}.thcode-bak`, readFileSync(cfg, "utf8"));
  }
  console.log("thcode: previous config backed up to ~/.deepseek/config.toml.thcode-bak. Re-running onboarding…\n");
}

const needsOnboard = process.argv[2] === "reset" || !hasTHProvider();

if (needsOnboard) {
  await runOnboarding();
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
