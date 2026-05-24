#!/usr/bin/env node
/**
 * postinstall — runs at `npm i -g thcode` time. Goal: zero further
 * user steps. After this script, `thcode` works end-to-end.
 *
 * What it does, in order:
 *   1. Detect platform + download branded thcode binary
 *   2. Install bun if missing (omo-slim's `install` subcommand
 *      shebangs `#!/usr/bin/env bun`)
 *   3. npm i -g oh-my-opencode-slim
 *   4. bunx oh-my-opencode-slim install   (registers it in
 *      opencode.jsonc so opencode loads the 6 agents on launch)
 *
 * Best-effort: any single step's failure is logged + swallowed. The
 * runtime ensureOpencodeInstalled + ensureOmoInstalled stay as
 * safety nets so a half-failing postinstall doesn't brick `thcode`.
 *
 * NPM_CONFIG_IGNORE_SCRIPTS=true bypass is honored.
 */
import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const THCODE_DIR = path.join(homedir(), ".thcode", "bin");
const THCODE_BIN = path.join(THCODE_DIR, "thcode-bin");
const BINARY_TAG_FILE = path.join(homedir(), ".thcode", "binary-tag");

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

async function downloadBranded() {
  const asset = brandedAssetName();
  if (!asset) {
    // Unsupported platform — runtime falls back to upstream opencode.
    return;
  }
  if (existsSync(THCODE_BIN) && existsSync(BINARY_TAG_FILE)) {
    // Already downloaded on a previous install — skip.
    return;
  }
  try {
    mkdirSync(THCODE_DIR, { recursive: true });
    const url = `https://github.com/tokenharbor/thcode/releases/latest/download/${asset}`;
    const tarPath = path.join(THCODE_DIR, asset);

    process.stderr.write(`\nthcode: prefetching binary (${asset})…\n  ${url}\n`);

    const curl = which("curl");
    if (curl) {
      const r = spawnSync(
        "curl",
        [
          "-fsSL",
          "--retry", "5",
          "--retry-delay", "2",
          "--retry-all-errors",
          "--connect-timeout", "20",
          "-o", tarPath,
          url,
        ],
        { stdio: "inherit" },
      );
      if (r.status !== 0) {
        process.stderr.write("thcode: prefetch failed (curl exit " + r.status + "). First `thcode` run will retry.\n");
        return;
      }
    } else {
      // Node fetch fallback — Windows often lacks curl
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) {
        process.stderr.write(`thcode: prefetch failed (HTTP ${res.status}). First \`thcode\` run will retry.\n`);
        return;
      }
      const { createWriteStream } = await import("node:fs");
      const { pipeline } = await import("node:stream/promises");
      const { Readable } = await import("node:stream");
      await pipeline(Readable.fromWeb(res.body), createWriteStream(tarPath));
    }

    const tar = spawnSync("tar", ["-xzf", tarPath, "-C", THCODE_DIR], { stdio: "inherit" });
    if (tar.status !== 0) {
      process.stderr.write("thcode: tar extract failed. First `thcode` run will retry.\n");
      return;
    }
    // Rename thcode → thcode-bin so the wrapper's bin name (thcode)
    // doesn't collide with the inner binary.
    const extracted = path.join(THCODE_DIR, "thcode");
    if (existsSync(extracted)) {
      const { renameSync, chmodSync } = await import("node:fs");
      if (existsSync(THCODE_BIN)) {
        spawnSync("rm", ["-f", THCODE_BIN]);
      }
      renameSync(extracted, THCODE_BIN);
      chmodSync(THCODE_BIN, 0o755);
    }
    // Stamp the release tag so the update checker has a baseline.
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
    process.stderr.write(`thcode: binary ready at ${THCODE_BIN} (${(statSync(THCODE_BIN).size / 1024 / 1024).toFixed(1)} MB)\n\n`);
  } catch (err) {
    process.stderr.write("thcode: prefetch error: " + (err?.message ?? err) + " — first launch will retry.\n");
  }
}

async function ensureBun() {
  if (which("bun")) return true;
  const bunHome = path.join(homedir(), ".bun", "bin");
  const bunPath = path.join(bunHome, "bun");
  if (existsSync(bunPath)) {
    process.env.PATH = `${bunHome}:${process.env.PATH ?? ""}`;
    return true;
  }
  if (process.platform === "win32") {
    process.stderr.write("thcode: bun isn't installed; omo-slim install will be skipped on Windows.\n");
    return false;
  }
  process.stderr.write("\nthcode: installing bun (required by omo-slim's install command)…\n");
  const r = spawnSync(
    "bash",
    ["-c", "curl -fsSL https://bun.sh/install | bash"],
    { stdio: "inherit" },
  );
  if (r.status !== 0 || !existsSync(bunPath)) {
    process.stderr.write("thcode: bun install failed; omo-slim plugin will not be set up.\n");
    return false;
  }
  process.env.PATH = `${bunHome}:${process.env.PATH ?? ""}`;
  return true;
}

async function installOmoSlim() {
  const haveOmo = which("oh-my-opencode-slim");
  if (!haveOmo) {
    process.stderr.write("\nthcode: installing omo-slim (oh-my-opencode-slim)…\n");
    const r = spawnSync(
      "npm",
      ["i", "-g", "oh-my-opencode-slim"],
      { stdio: "inherit" },
    );
    if (r.status !== 0) {
      process.stderr.write("thcode: omo-slim npm install failed; first thcode launch will retry.\n");
      return false;
    }
  }
  // Run the install subcommand. omo-slim's bin shebangs `#!/usr/bin/env bun`,
  // so this fails without bun in PATH (postinstall's ensureBun step
  // takes care of that).
  process.stderr.write("\nthcode: registering omo-slim with opencode…\n");
  const omoBin = which("oh-my-opencode-slim") ?? "oh-my-opencode-slim";
  const r = spawnSync(omoBin, ["install"], { stdio: "inherit" });
  if (r.status !== 0) {
    process.stderr.write("thcode: omo-slim install subcommand failed; first thcode launch will retry.\n");
    return false;
  }
  return true;
}

(async () => {
  await downloadBranded();
  try {
    const haveBun = await ensureBun();
    if (haveBun) await installOmoSlim();
  } catch (err) {
    process.stderr.write("thcode: bun/omo setup error: " + (err?.message ?? err) + " — first launch will retry.\n");
  }
})();
