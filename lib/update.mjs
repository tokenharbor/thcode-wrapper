import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const WRAPPER_REPO = "tokenharbor/thcode-wrapper";
// thcode-crush (Charm Crush brand fork) is the current binary repo.
// Earlier bases (`tokenharbor/thcode` opencode fork, `tokenharbor/thcode-tui`
// codewhale fork) are deprecated.
const BINARY_REPO = "tokenharbor/thcode-crush";
const STATE_DIR = path.join(homedir(), ".thcode");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const INSTALLED_WRAPPER_SHA = path.join(STATE_DIR, "wrapper-sha");
const INSTALLED_BINARY_TAG = path.join(STATE_DIR, "binary-tag");
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

function loadState() {
  if (!existsSync(STATE_FILE)) return {};
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}

function saveState(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function recordInstalledWrapperSha(sha) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(INSTALLED_WRAPPER_SHA, sha);
}

export function recordInstalledBinaryTag(tag) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(INSTALLED_BINARY_TAG, tag);
}

function readLocal(file) {
  if (!existsSync(file)) return null;
  try { return readFileSync(file, "utf8").trim(); } catch { return null; }
}

async function fetchJson(url, timeoutMs = 4000) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(url, {
      headers: { "user-agent": "thcode-wrapper", accept: "application/vnd.github+json" },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/**
 * Fire-and-forget update check. Non-blocking — caller can ignore the
 * returned promise. Prints a one-line notice to stderr if either the
 * wrapper or binary has a newer version available. Honors a 24h cooldown.
 *
 * Returns { wrapperUpdate, binaryUpdate, currentWrapperSha, latestWrapperSha,
 *           currentBinaryTag, latestBinaryTag } or null on skip/error.
 */
export async function checkForUpdateAsync({ force = false, quiet = false } = {}) {
  const state = loadState();
  const now = Date.now();
  if (!force && state.lastChecked && now - state.lastChecked < CHECK_INTERVAL_MS) {
    return null;
  }

  const [wrapperData, releaseData] = await Promise.all([
    fetchJson(`https://api.github.com/repos/${WRAPPER_REPO}/commits/main`),
    fetchJson(`https://api.github.com/repos/${BINARY_REPO}/releases/latest`),
  ]);

  const currentWrapperSha = readLocal(INSTALLED_WRAPPER_SHA);
  const latestWrapperSha = wrapperData?.sha?.slice(0, 7) ?? null;
  const currentBinaryTag = readLocal(INSTALLED_BINARY_TAG);
  const latestBinaryTag = releaseData?.tag_name ?? null;

  const wrapperUpdate =
    latestWrapperSha && currentWrapperSha && latestWrapperSha !== currentWrapperSha.slice(0, 7);
  const binaryUpdate =
    latestBinaryTag && currentBinaryTag && latestBinaryTag !== currentBinaryTag;

  state.lastChecked = now;
  state.latestWrapperSha = latestWrapperSha;
  state.latestBinaryTag = latestBinaryTag;
  saveState(state);

  if (!quiet && (wrapperUpdate || binaryUpdate)) {
    const reasons = [];
    if (wrapperUpdate) reasons.push(`wrapper (${currentWrapperSha?.slice(0, 7)} → ${latestWrapperSha})`);
    if (binaryUpdate) reasons.push(`binary (${currentBinaryTag} → ${latestBinaryTag})`);
    process.stderr.write(
      `\n  thcode update available: ${reasons.join(", ")}\n` +
      `  Run \`thcode update\` to upgrade.\n\n`,
    );
  }

  return { wrapperUpdate, binaryUpdate, currentWrapperSha, latestWrapperSha, currentBinaryTag, latestBinaryTag };
}

/**
 * Synchronous update — re-installs the wrapper via tarball download
 * (Node 25's `npm i -g github:...` hits ENOTDIR on some setups) and
 * re-downloads the branded binary. Invoked by `thcode update` and
 * by the on-exit auto-apply path.
 */
export async function runUpdate({ binaryRefresher }) {
  console.log("Updating thcode wrapper from GitHub…");
  const tmpdir = path.join(STATE_DIR, "tmp-update");
  spawnSync("rm", ["-rf", tmpdir], { stdio: "ignore" });
  mkdirSync(tmpdir, { recursive: true });
  const tarPath = path.join(tmpdir, "wrapper.tar.gz");
  const url = `https://codeload.github.com/${WRAPPER_REPO}/tar.gz/refs/heads/main`;

  const curl = spawnSync("curl", [
    "-fsSL", "--retry", "5", "--retry-delay", "2", "--retry-all-errors",
    "--connect-timeout", "20", "-o", tarPath, url,
  ], { stdio: "inherit" });
  if (curl.status !== 0) {
    console.error("\nWrapper update failed (download). Try manually:");
    console.error(`  curl -fsSL ${url} -o /tmp/thcode-wrapper.tar.gz && tar -xzf /tmp/thcode-wrapper.tar.gz -C /tmp && cd /tmp/thcode-wrapper-main && npm i -g .`);
    process.exit(1);
  }

  const untar = spawnSync("tar", ["-xzf", tarPath, "-C", tmpdir], { stdio: "inherit" });
  if (untar.status !== 0) {
    console.error("\nWrapper update failed (extract).");
    process.exit(1);
  }
  // codeload extracts to <repo>-<branch>; e.g. thcode-wrapper-main
  const srcDir = path.join(tmpdir, `${WRAPPER_REPO.split("/")[1]}-main`);
  if (!existsSync(srcDir)) {
    console.error(`\nWrapper update failed: expected ${srcDir} after extract.`);
    process.exit(1);
  }
  const npmRes = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["i", "-g", "."],
    { cwd: srcDir, stdio: "inherit" },
  );
  if (npmRes.status !== 0) {
    console.error("\nWrapper update failed (npm install).");
    process.exit(1);
  }

  // Record the new wrapper SHA so the next startup doesn't keep nagging.
  const wrapperData = await fetchJson(`https://api.github.com/repos/${WRAPPER_REPO}/commits/main`);
  if (wrapperData?.sha) recordInstalledWrapperSha(wrapperData.sha);

  console.log("\nRefreshing thcode binary…");
  // Caller passes the refresher because the install logic lives in install.mjs.
  if (binaryRefresher) {
    try {
      await binaryRefresher({ force: true });
    } catch (err) {
      console.error("Binary refresh failed:", err?.message ?? err);
    }
  }

  spawnSync("rm", ["-rf", tmpdir], { stdio: "ignore" });
  console.log("\nthcode updated. Re-launch with `thcode` to use the new version.");
}
