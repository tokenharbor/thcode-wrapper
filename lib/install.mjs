import { existsSync, mkdirSync, chmodSync, createWriteStream, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { recordInstalledBinaryTag } from "./update.mjs";

const OC_INSTALL_URL = "https://opencode.ai/install";
const THCODE_RELEASE_TAG = "latest"; // GH always-latest endpoint
const LOCAL_INSTALL_DIR = path.join(homedir(), ".opencode", "bin");
const LOCAL_BIN = path.join(LOCAL_INSTALL_DIR, "opencode");
const THCODE_DIR = path.join(homedir(), ".thcode", "bin");
const THCODE_BIN = path.join(THCODE_DIR, "thcode-bin");
const BINARY_TAG_FILE = path.join(homedir(), ".thcode", "binary-tag");

function which(cmd) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const first = (r.stdout || "").split(/\r?\n/).find((l) => l.trim());
  return first ? first.trim() : null;
}

// Map (platform, arch) → release asset name. Built by the matrix
// workflow in tokenharbor/thcode/.github/workflows/build-thcode.yml.
// Add a new entry here whenever the workflow ships a new platform.
function brandedAssetName() {
  if (process.platform === "darwin") {
    if (process.arch === "arm64") return "thcode-darwin-arm64.tar.gz";
    if (process.arch === "x64") return "thcode-darwin-x64.tar.gz";
  }
  if (process.platform === "linux") {
    if (process.arch === "x64") return "thcode-linux-x64.tar.gz";
  }
  return null; // unsupported (linux-arm64, windows, …) → fall through to upstream
}

async function fetchLatestReleaseTag() {
  try {
    const r = await fetch(`https://api.github.com/repos/tokenharbor/thcode/releases/latest`, {
      headers: { "user-agent": "thcode-wrapper", accept: "application/vnd.github+json" },
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data?.tag_name ?? null;
  } catch {
    return null;
  }
}

async function downloadAndExtractThcode() {
  const asset = brandedAssetName();
  if (!asset) return false;
  const url = `https://github.com/tokenharbor/thcode/releases/${THCODE_RELEASE_TAG}/download/${asset}`;
  mkdirSync(THCODE_DIR, { recursive: true });
  const tarPath = path.join(THCODE_DIR, asset);
  console.log(`\nthcode: downloading branded binary…\n  ${url}\n`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    console.error(`thcode: download failed (HTTP ${res.status}). Falling back to upstream opencode.`);
    return false;
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tarPath));
  const tar = spawnSync("tar", ["-xzf", tarPath, "-C", THCODE_DIR], { stdio: "inherit" });
  if (tar.status !== 0) {
    console.error("thcode: extraction failed.");
    return false;
  }
  const extracted = path.join(THCODE_DIR, "thcode");
  if (!existsSync(extracted)) {
    console.error(`thcode: binary not found inside ${asset}.`);
    return false;
  }
  // Rename to thcode-bin so the user-facing command from the wrapper
  // (./bin/thcode.mjs) is unambiguous: thcode = wrapper, thcode-bin = the binary.
  if (existsSync(THCODE_BIN)) {
    spawnSync("rm", ["-f", THCODE_BIN]);
  }
  spawnSync("mv", [extracted, THCODE_BIN]);
  chmodSync(THCODE_BIN, 0o755);
  // Record which release tag this binary came from so the update
  // checker can compare against the latest release later.
  const latestTag = await fetchLatestReleaseTag();
  if (latestTag) recordInstalledBinaryTag(latestTag);
  console.log(`thcode: binary ready at ${THCODE_BIN} (${(statSync(THCODE_BIN).size / 1024 / 1024).toFixed(1)} MB)${latestTag ? `, tag ${latestTag}` : ""}\n`);
  return true;
}

/**
 * Force a fresh download of the branded binary, ignoring whatever's
 * already on disk. Used by `thcode update`.
 */
export async function refreshBranded() {
  if (!brandedAssetName()) {
    console.log("thcode: no branded binary for this platform yet — nothing to refresh.");
    return;
  }
  if (existsSync(THCODE_BIN)) spawnSync("rm", ["-f", THCODE_BIN]);
  await downloadAndExtractThcode();
}

export function opencodeBinaryPath() {
  if (existsSync(THCODE_BIN)) return THCODE_BIN;
  return which("opencode") || (existsSync(LOCAL_BIN) ? LOCAL_BIN : "opencode");
}

export async function ensureOpencodeInstalled() {
  // 1. Branded thcode binary already present AND its release tag is
  //    stamped? Then we trust it — update checker will handle upgrades.
  //    Missing tag stamp = legacy install from a wrapper version that
  //    didn't track binary tags. Force a fresh download so we can stamp
  //    it + pick up any newer release the user is silently behind on.
  if (existsSync(THCODE_BIN) && existsSync(BINARY_TAG_FILE)) return;

  // 2. On supported mac arches, try to grab the branded binary from
  //    github.com/tokenharbor/thcode releases.
  if (brandedAssetName()) {
    const ok = await downloadAndExtractThcode();
    if (ok) return;
  }

  // 3. Fallback to upstream opencode (other platforms or download failed).
  if (which("opencode")) return;
  if (existsSync(LOCAL_BIN)) return;

  if (process.platform === "win32") {
    console.error(`
thcode: branded binary not yet available for Windows.

Install upstream opencode manually:
  powershell -c "irm opencode.ai/install.ps1 | iex"

Then re-run thcode.
`);
    process.exit(1);
  }

  console.log("\nthcode: branded binary not available for this platform — installing upstream opencode…\n");
  const result = spawnSync(
    "bash",
    ["-c", `curl -fsSL ${OC_INSTALL_URL} | bash`],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    console.error("\nthcode: opencode install failed. Try manually:");
    console.error(`  curl -fsSL ${OC_INSTALL_URL} | bash`);
    process.exit(1);
  }
}
