#!/usr/bin/env node
/**
 * postinstall — runs at `npm i -g thcode` time. One step:
 * install codewhale (DeepSeek-TUI rebrand) globally so the
 * `thcode` command can spawn it. Verbose output captured to
 * ~/.thcode/install.log so we keep the user's terminal clean.
 *
 * NPM_CONFIG_IGNORE_SCRIPTS=true bypass is honored.
 */
import { existsSync, mkdirSync, openSync, readFileSync, closeSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const THCODE_HOME = path.join(homedir(), ".thcode");
const LOG_FILE = path.join(THCODE_HOME, "install.log");
mkdirSync(THCODE_HOME, { recursive: true });

let logFd = (() => {
  try { return openSync(LOG_FILE, "a"); } catch { return null; }
})();
function closeLog() {
  if (logFd !== null) {
    try { closeSync(logFd); } catch {}
    logFd = null;
  }
}
function logHeader(msg) {
  if (logFd === null) return;
  try { writeSync(logFd, `\n--- ${msg} @ ${new Date().toISOString()} ---\n`); } catch {}
}
function tailLog(lines = 30) {
  try {
    const text = readFileSync(LOG_FILE, "utf8");
    const arr = text.split(/\r?\n/);
    return arr.slice(Math.max(0, arr.length - lines)).join("\n");
  } catch {
    return "(log unavailable)";
  }
}

function which(cmd) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8" });
  if (r.status !== 0) return null;
  return (r.stdout || "").split(/\r?\n/).find((l) => l.trim())?.trim() ?? null;
}

function runQuiet(cmd, args) {
  if (logFd === null) return spawnSync(cmd, args, { stdio: "ignore" });
  return spawnSync(cmd, args, { stdio: ["ignore", logFd, logFd] });
}

const TOTAL = 1;
const progress = (msg) => {
  process.stderr.write(`[1/${TOTAL}] ${msg}…\n`);
  logHeader(msg);
};
const ok = (msg) => process.stderr.write(`[1/${TOTAL}] ${msg} ✓\n`);
const fail = (msg, hint) => {
  process.stderr.write(`[1/${TOTAL}] ${msg} ✗\n`);
  if (hint) process.stderr.write(`     ${hint}\n`);
  process.stderr.write(`     See ${LOG_FILE} for details. Last 30 lines:\n`);
  for (const line of tailLog().split(/\r?\n/)) {
    process.stderr.write(`     ${line}\n`);
  }
};

(async () => {
  process.stderr.write("\nthcode setup\n");
  if (which("codewhale")) {
    ok("codewhale already installed");
  } else {
    progress("Installing codewhale (DeepSeek-TUI)");
    const r = runQuiet("npm", ["i", "-g", "codewhale"]);
    if (r.status !== 0) {
      fail("npm i -g codewhale failed", "First `thcode` run will retry.");
      closeLog();
      return;
    }
    ok("codewhale installed");
  }
  closeLog();
  process.stderr.write("\nDone. Run `thcode` to start.\n\n");
})();
