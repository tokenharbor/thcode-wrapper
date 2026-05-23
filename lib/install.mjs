import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";

const OC_INSTALL_URL = "https://opencode.ai/install";
const LOCAL_INSTALL_DIR = path.join(homedir(), ".opencode", "bin");
const LOCAL_BIN = path.join(LOCAL_INSTALL_DIR, "opencode");

function which(cmd) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const first = (r.stdout || "").split(/\r?\n/).find((l) => l.trim());
  return first ? first.trim() : null;
}

export function opencodeBinaryPath() {
  return which("opencode") || (existsSync(LOCAL_BIN) ? LOCAL_BIN : "opencode");
}

export async function ensureOpencodeInstalled() {
  if (which("opencode")) return;
  if (existsSync(LOCAL_BIN)) return;

  if (process.platform === "win32") {
    console.error(`
thcode: opencode is not installed on PATH.

On Windows, install it manually with:
  powershell -c "irm opencode.ai/install.ps1 | iex"

Then re-run thcode.
`);
    process.exit(1);
  }

  console.log("\nthcode: opencode is not installed. Downloading from opencode.ai…\n");
  const result = spawnSync(
    "bash",
    ["-c", `curl -fsSL ${OC_INSTALL_URL} | bash`],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    console.error("\nthcode: opencode install failed. Try installing it manually:");
    console.error(`  curl -fsSL ${OC_INSTALL_URL} | bash`);
    process.exit(1);
  }

  if (!which("opencode") && !existsSync(LOCAL_BIN)) {
    console.error(`
thcode: opencode installed but its binary isn't on PATH yet.

Open a new shell, or add this to your shell rc:
  export PATH="$HOME/.opencode/bin:$PATH"

Then re-run thcode.
`);
    process.exit(1);
  }
}
