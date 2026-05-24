#!/usr/bin/env node
/**
 * postinstall — runs at `npm i -g thcode` time. Downloads the
 * Token Harbor branded thcode-tui binary (our deep fork of
 * DeepSeek-TUI / CodeWhale) into ~/.thcode/bin/thcode-bin.
 *
 * Verbose log captured to ~/.thcode/install.log so the user's
 * terminal stays clean. On failure we dump the log tail.
 */
import { existsSync, mkdirSync, openSync, readFileSync, closeSync, writeSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const THCODE_HOME = path.join(homedir(), ".thcode");
const THCODE_BIN_DIR = path.join(THCODE_HOME, "bin");
const THCODE_BIN = path.join(THCODE_BIN_DIR, "thcode-bin");
const BINARY_TAG_FILE = path.join(THCODE_HOME, "binary-tag");
const LOG_FILE = path.join(THCODE_HOME, "install.log");
mkdirSync(THCODE_HOME, { recursive: true });
mkdirSync(THCODE_BIN_DIR, { recursive: true });

let logFd = (() => { try { return openSync(LOG_FILE, "a"); } catch { return null; } })();
const log = (msg) => { if (logFd === null) return; try { writeSync(logFd, msg); } catch {} };
function closeLog() { if (logFd !== null) { try { closeSync(logFd); } catch {} logFd = null; } }
function tailLog(n = 30) {
  try {
    const arr = readFileSync(LOG_FILE, "utf8").split(/\r?\n/);
    return arr.slice(Math.max(0, arr.length - n)).join("\n");
  } catch { return "(log unavailable)"; }
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

function brandedAssetName() {
  // Asset names produced by the thcode-crush build workflow.
  if (process.platform === "darwin") {
    if (process.arch === "arm64") return "thcode-darwin-arm64.tar.gz";
    if (process.arch === "x64") return "thcode-darwin-x64.tar.gz";
  }
  if (process.platform === "linux") {
    if (process.arch === "x64") return "thcode-linux-x64.tar.gz";
    if (process.arch === "arm64") return "thcode-linux-arm64.tar.gz";
  }
  return null;
}

const progress = (msg) => process.stderr.write(`[1/1] ${msg}…\n`);
const ok = (msg) => process.stderr.write(`[1/1] ${msg} ✓\n`);
const fail = (msg, hint) => {
  process.stderr.write(`[1/1] ${msg} ✗\n`);
  if (hint) process.stderr.write(`     ${hint}\n`);
  process.stderr.write(`     See ${LOG_FILE} for details. Tail:\n`);
  for (const line of tailLog().split(/\r?\n/)) process.stderr.write(`     ${line}\n`);
};

(async () => {
  process.stderr.write("\nthcode setup\n");
  const asset = brandedAssetName();
  if (!asset) {
    process.stderr.write(`[1/1] No prebuilt binary for ${process.platform}/${process.arch} — first thcode run will print install hint.\n`);
    closeLog();
    return;
  }
  if (existsSync(THCODE_BIN)) {
    ok("Binary already on disk — preserving local copy");
    closeLog();
    return;
  }
  log(`\n--- postinstall download @ ${new Date().toISOString()} ---\n`);
  const url = `https://github.com/tokenharbor/thcode-crush/releases/latest/download/${asset}`;
  const tarPath = path.join(THCODE_BIN_DIR, asset);

  progress(`Downloading thcode-tui (${asset})`);
  const curl = which("curl");
  let downloaded = false;
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
    downloaded = r.status === 0;
  } else {
    try {
      const res = await fetch(url, { redirect: "follow" });
      if (res.ok) {
        const { createWriteStream } = await import("node:fs");
        const { pipeline } = await import("node:stream/promises");
        const { Readable } = await import("node:stream");
        await pipeline(Readable.fromWeb(res.body), createWriteStream(tarPath));
        downloaded = true;
      }
    } catch (err) {
      log(`fetch error: ${err?.message ?? err}\n`);
    }
  }
  if (!downloaded) {
    fail("Download failed", "First `thcode` run will retry.");
    closeLog();
    return;
  }

  const tar = runQuiet("tar", ["-xzf", tarPath, "-C", THCODE_BIN_DIR]);
  if (tar.status !== 0) {
    fail("Tar extract failed", "First `thcode` run will retry.");
    closeLog();
    return;
  }
  // thcode-crush is a single Go binary; tarball contains just `thcode`
  // (renamed to `thcode-bin` on disk so the wrapper command name
  // `thcode` stays clean of conflicts on PATH).
  const { chmodSync, renameSync } = await import("node:fs");
  const extracted = path.join(THCODE_BIN_DIR, "thcode");
  if (existsSync(extracted)) {
    if (existsSync(THCODE_BIN)) spawnSync("rm", ["-f", THCODE_BIN]);
    renameSync(extracted, THCODE_BIN);
  }
  if (!existsSync(THCODE_BIN)) {
    fail("Tarball missing expected `thcode` binary", "");
    closeLog();
    return;
  }
  chmodSync(THCODE_BIN, 0o755);
  try {
    const r = await fetch("https://api.github.com/repos/tokenharbor/thcode-crush/releases/latest");
    if (r.ok) {
      const data = await r.json();
      if (data?.tag_name) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(BINARY_TAG_FILE, String(data.tag_name));
      }
    }
  } catch {}
  ok(`Binary ready (${(statSync(THCODE_BIN).size / 1024 / 1024).toFixed(1)} MB)`);
  closeLog();
  process.stderr.write("\nDone. Run `thcode` to start.\n\n");
})();
