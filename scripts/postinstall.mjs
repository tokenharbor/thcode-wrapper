#!/usr/bin/env node
/**
 * postinstall — runs at `npm i -g thcode` time. Goal: zero further
 * user steps. After this script, `thcode` works end-to-end.
 *
 * Output style: single-line progress per step. Verbose third-party
 * output (bun installer ASCII art, omo-slim's 9-step log, skills
 * installer banners) is captured to ~/.thcode/install.log and only
 * shown on failure.
 *
 * Steps:
 *   1. Download branded thcode binary
 *   2. Install bun if missing
 *   3. npm i -g oh-my-opencode-slim
 *   4. oh-my-opencode-slim install
 *
 * NPM_CONFIG_IGNORE_SCRIPTS=true bypass is honored.
 */
import { existsSync, mkdirSync, openSync, readFileSync, statSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const THCODE_HOME = path.join(homedir(), ".thcode");
const THCODE_DIR = path.join(THCODE_HOME, "bin");
const THCODE_BIN = path.join(THCODE_DIR, "thcode-bin");
const BINARY_TAG_FILE = path.join(THCODE_HOME, "binary-tag");
const LOG_FILE = path.join(THCODE_HOME, "install.log");

mkdirSync(THCODE_HOME, { recursive: true });

// Open log fd that every step appends to. tail of this is shown on
// any step failure so the user can diagnose without us having to
// pipe through every third-party tool's stdout.
let logFd = (() => {
  try {
    return openSync(LOG_FILE, "a");
  } catch {
    return null;
  }
})();
function closeLog() {
  if (logFd !== null) {
    try { closeSync(logFd); } catch {}
    logFd = null;
  }
}
function logHeader(step, total, msg) {
  const stamp = `\n--- [${step}/${total}] ${msg} @ ${new Date().toISOString()} ---\n`;
  if (logFd !== null) {
    try {
      const { writeSync } = require("node:fs");
      writeSync(logFd, stamp);
    } catch {}
  }
}
function tailLog(lines = 60) {
  try {
    const text = readFileSync(LOG_FILE, "utf8");
    const arr = text.split(/\r?\n/);
    return arr.slice(Math.max(0, arr.length - lines)).join("\n");
  } catch {
    return "(log unavailable)";
  }
}

const TOTAL = 4;
const progress = (n, msg) => {
  process.stderr.write(`[${n}/${TOTAL}] ${msg}…\n`);
  logHeader(n, TOTAL, msg);
};
const ok = (n, msg) => {
  process.stderr.write(`[${n}/${TOTAL}] ${msg} ✓\n`);
};
const fail = (n, msg, hint) => {
  process.stderr.write(`[${n}/${TOTAL}] ${msg} ✗\n`);
  if (hint) process.stderr.write(`     ${hint}\n`);
  process.stderr.write(`     See ${LOG_FILE} for details (last 60 lines):\n`);
  for (const line of tailLog().split(/\r?\n/).slice(-30)) {
    process.stderr.write(`     ${line}\n`);
  }
};

function runQuiet(cmd, args) {
  if (logFd === null) {
    return spawnSync(cmd, args, { stdio: "ignore" });
  }
  return spawnSync(cmd, args, {
    stdio: ["ignore", logFd, logFd],
  });
}
function runQuietBash(script) {
  if (logFd === null) {
    return spawnSync("bash", ["-c", script], { stdio: "ignore" });
  }
  return spawnSync("bash", ["-c", script], {
    stdio: ["ignore", logFd, logFd],
  });
}

function brandedAssetName() {
  if (process.platform === "darwin") {
    if (process.arch === "arm64") return "thcode-darwin-arm64.tar.gz";
    if (process.arch === "x64") return "thcode-darwin-x64.tar.gz";
  }
  if (process.platform === "linux") {
    if (process.arch === "x64") return "thcode-linux-x64.tar.gz";
  }
  return null;
}

function which(cmd) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8" });
  if (r.status !== 0) return null;
  return (r.stdout || "").split(/\r?\n/).find((l) => l.trim())?.trim() ?? null;
}

async function step1_downloadBranded() {
  const asset = brandedAssetName();
  if (!asset) {
    process.stderr.write(`[1/${TOTAL}] Unsupported platform — runtime will fall back to upstream opencode\n`);
    return;
  }
  if (existsSync(THCODE_BIN) && existsSync(BINARY_TAG_FILE)) {
    process.stderr.write(`[1/${TOTAL}] Branded binary already on disk ✓\n`);
    return;
  }
  progress(1, `Downloading thcode binary (${asset})`);
  try {
    mkdirSync(THCODE_DIR, { recursive: true });
    const url = `https://github.com/tokenharbor/thcode/releases/latest/download/${asset}`;
    const tarPath = path.join(THCODE_DIR, asset);
    const curl = which("curl");
    if (curl) {
      const r = runQuiet("curl", [
        "-fsSL",
        "--retry", "5",
        "--retry-delay", "2",
        "--retry-all-errors",
        "--connect-timeout", "20",
        "-o", tarPath,
        url,
      ]);
      if (r.status !== 0) {
        fail(1, "Download failed", "First `thcode` run will retry over the network.");
        return;
      }
    } else {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) {
        fail(1, `Download failed (HTTP ${res.status})`, "First `thcode` run will retry.");
        return;
      }
      const { createWriteStream } = await import("node:fs");
      const { pipeline } = await import("node:stream/promises");
      const { Readable } = await import("node:stream");
      await pipeline(Readable.fromWeb(res.body), createWriteStream(tarPath));
    }
    const tar = runQuiet("tar", ["-xzf", tarPath, "-C", THCODE_DIR]);
    if (tar.status !== 0) {
      fail(1, "Extract failed", "First `thcode` run will retry.");
      return;
    }
    const extracted = path.join(THCODE_DIR, "thcode");
    if (existsSync(extracted)) {
      const { renameSync, chmodSync } = await import("node:fs");
      if (existsSync(THCODE_BIN)) {
        runQuiet("rm", ["-f", THCODE_BIN]);
      }
      renameSync(extracted, THCODE_BIN);
      chmodSync(THCODE_BIN, 0o755);
    }
    try {
      const r = await fetch("https://api.github.com/repos/tokenharbor/thcode/releases/latest");
      if (r.ok) {
        const data = await r.json();
        if (data?.tag_name) {
          const { writeFileSync } = await import("node:fs");
          writeFileSync(BINARY_TAG_FILE, String(data.tag_name));
        }
      }
    } catch {}
    ok(1, `thcode binary ready (${(statSync(THCODE_BIN).size / 1024 / 1024).toFixed(1)} MB)`);
  } catch (err) {
    fail(1, "Download error: " + (err?.message ?? err), "First `thcode` run will retry.");
  }
}

async function step2_ensureBun() {
  if (which("bun")) {
    ok(2, "bun already installed");
    return true;
  }
  const bunHome = path.join(homedir(), ".bun", "bin");
  const bunPath = path.join(bunHome, "bun");
  if (existsSync(bunPath)) {
    process.env.PATH = `${bunHome}:${process.env.PATH ?? ""}`;
    ok(2, "bun already installed");
    return true;
  }
  if (process.platform === "win32") {
    fail(2, "bun isn't installed", "Windows: install bun from https://bun.sh, then run `thcode reset`.");
    return false;
  }
  progress(2, "Installing bun (required by omo-slim)");
  const r = runQuietBash("curl -fsSL https://bun.sh/install | bash");
  if (r.status !== 0 || !existsSync(bunPath)) {
    fail(2, "bun install failed", "omo-slim plugin will be skipped. Re-run later with `thcode reset`.");
    return false;
  }
  process.env.PATH = `${bunHome}:${process.env.PATH ?? ""}`;
  ok(2, "bun installed");
  return true;
}

async function step3_installOmoSlim() {
  if (which("oh-my-opencode-slim")) {
    ok(3, "oh-my-opencode-slim already installed");
    return true;
  }
  progress(3, "Installing oh-my-opencode-slim");
  const r = runQuiet("npm", ["i", "-g", "oh-my-opencode-slim"]);
  if (r.status !== 0) {
    fail(3, "npm i -g oh-my-opencode-slim failed", "First `thcode` run will retry.");
    return false;
  }
  ok(3, "oh-my-opencode-slim installed");
  return true;
}

async function step4_registerOmo() {
  progress(4, "Configuring agents (orchestrator / oracle / designer / explorer / librarian / fixer)");
  const omoBin = which("oh-my-opencode-slim") ?? "oh-my-opencode-slim";
  const r = runQuiet(omoBin, ["install"]);
  if (r.status !== 0) {
    fail(4, "omo-slim install subcommand failed", "First `thcode` run will retry.");
    return false;
  }
  ok(4, "agents configured");
  return true;
}

(async () => {
  process.stderr.write("\nthcode setup\n");
  await step1_downloadBranded();
  let haveBun = false;
  try {
    haveBun = await step2_ensureBun();
  } catch (err) {
    fail(2, "bun setup error: " + (err?.message ?? err), "First `thcode` run will retry.");
  }
  if (haveBun) {
    try {
      const okOmo = await step3_installOmoSlim();
      if (okOmo) await step4_registerOmo();
    } catch (err) {
      fail(3, "omo setup error: " + (err?.message ?? err), "First `thcode` run will retry.");
    }
  }
  closeLog();
  process.stderr.write("\nDone. Run `thcode` to start.\n\n");
})();
