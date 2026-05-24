import { existsSync, mkdirSync, chmodSync, statSync, createWriteStream } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const THCODE_HOME = path.join(homedir(), ".thcode");
const THCODE_BIN_DIR = path.join(THCODE_HOME, "bin");
const THCODE_BIN = path.join(THCODE_BIN_DIR, "thcode-bin");
const BINARY_TAG_FILE = path.join(THCODE_HOME, "binary-tag");

function which(cmd) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8" });
  if (r.status !== 0) return null;
  return (r.stdout || "").split(/\r?\n/).find((l) => l.trim())?.trim() ?? null;
}

function brandedAssetName() {
  if (process.platform === "darwin") {
    if (process.arch === "arm64") return "thcode-tui-darwin-arm64.tar.gz";
    if (process.arch === "x64") return "thcode-tui-darwin-x64.tar.gz";
  }
  if (process.platform === "linux") {
    if (process.arch === "x64") return "thcode-tui-linux-x64.tar.gz";
  }
  return null;
}

async function downloadBranded() {
  const asset = brandedAssetName();
  if (!asset) {
    console.error(`thcode: no prebuilt binary for ${process.platform}/${process.arch}. Build from source: https://github.com/tokenharbor/thcode-tui`);
    return false;
  }
  mkdirSync(THCODE_BIN_DIR, { recursive: true });
  const url = `https://github.com/tokenharbor/thcode-tui/releases/latest/download/${asset}`;
  const tarPath = path.join(THCODE_BIN_DIR, asset);
  console.log(`\nthcode: downloading branded binary…\n  ${url}\n`);
  const curl = which("curl");
  if (curl) {
    const r = spawnSync("curl", [
      "-fsSL", "--retry", "5", "--retry-delay", "2", "--retry-all-errors",
      "--connect-timeout", "20", "-o", tarPath, url,
    ], { stdio: "inherit" });
    if (r.status !== 0) {
      console.error(`thcode: download failed (curl exit ${r.status}).`);
      return false;
    }
  } else {
    try {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) { console.error(`thcode: download failed (HTTP ${res.status}).`); return false; }
      await pipeline(Readable.fromWeb(res.body), createWriteStream(tarPath));
    } catch (err) {
      console.error("thcode: fetch failed: " + (err?.message ?? err));
      return false;
    }
  }
  const tar = spawnSync("tar", ["-xzf", tarPath, "-C", THCODE_BIN_DIR], { stdio: "inherit" });
  if (tar.status !== 0) { console.error("thcode: tar extract failed."); return false; }
  // Tarball ships dispatcher (`thcode-bin`) + companion (`codewhale-tui`)
  // side-by-side. Dispatcher exec's the companion from its own dir, so
  // both must land in THCODE_BIN_DIR.
  const companion = path.join(THCODE_BIN_DIR, "codewhale-tui");
  if (!existsSync(THCODE_BIN) || !existsSync(companion)) {
    console.error(`thcode: tarball ${asset} did not contain expected binaries (thcode-bin + codewhale-tui).`);
    return false;
  }
  chmodSync(THCODE_BIN, 0o755);
  chmodSync(companion, 0o755);
  try {
    const r = await fetch("https://api.github.com/repos/tokenharbor/thcode-tui/releases/latest");
    if (r.ok) {
      const data = await r.json();
      if (data?.tag_name) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(BINARY_TAG_FILE, String(data.tag_name));
      }
    }
  } catch {}
  console.log(`thcode: binary ready at ${THCODE_BIN} (${(statSync(THCODE_BIN).size / 1024 / 1024).toFixed(1)} MB)\n`);
  return true;
}

export function codewhaleBinaryPath() {
  if (existsSync(THCODE_BIN)) return THCODE_BIN;
  // Fall back to anything named `thcode-bin` or `thcode` on PATH (e.g.,
  // a developer build placed there manually).
  return which("thcode-bin") || which("thcode") || THCODE_BIN;
}

export async function ensureCodewhaleInstalled() {
  // Locally-built dev binary is fine — only download if nothing exists.
  if (existsSync(THCODE_BIN)) return;
  console.log("\nthcode: binary not found at " + THCODE_BIN + ", attempting download…");
  const ok = await downloadBranded();
  if (!ok) {
    console.error("\nthcode: install failed. Build from source:");
    console.error("  git clone https://github.com/tokenharbor/thcode-crush ~/.thcode-dev/thcode-crush");
    console.error("  cd ~/.thcode-dev/thcode-crush && go build -o ~/.thcode/bin/thcode-bin .");
    process.exit(1);
  }
}

export async function refreshBranded() {
  if (existsSync(THCODE_BIN)) spawnSync("rm", ["-f", THCODE_BIN]);
  if (existsSync(BINARY_TAG_FILE)) spawnSync("rm", ["-f", BINARY_TAG_FILE]);
  await downloadBranded();
}
