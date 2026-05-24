import { spawnSync } from "node:child_process";

// codewhale (DeepSeek-TUI) replaces opencode as the underlying TUI.
// We installed it via postinstall.mjs as a regular npm package; at
// thcode-launch we just need to find its `codewhale` bin and exec.

function which(cmd) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8" });
  if (r.status !== 0) return null;
  return (r.stdout || "").split(/\r?\n/).find((l) => l.trim())?.trim() ?? null;
}

export function codewhaleBinaryPath() {
  return which("codewhale") || "codewhale";
}

/**
 * No-op now that postinstall handles `npm i -g codewhale`. Kept as an
 * export so bin/thcode.mjs can call it as a safety net — if a user
 * disabled postinstall scripts the next thcode launch tries again.
 */
export async function ensureCodewhaleInstalled() {
  if (which("codewhale")) return;
  console.log("\nthcode: codewhale binary not found, installing…");
  const r = spawnSync("npm", ["i", "-g", "codewhale"], { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(
      "\nthcode: failed to install codewhale. Try manually:\n  npm i -g codewhale\n",
    );
    process.exit(1);
  }
}

// Optional refresher hook used by `thcode update`.
export async function refreshBranded() {
  console.log("\nUpdating codewhale to latest…");
  spawnSync("npm", ["i", "-g", "codewhale@latest"], { stdio: "inherit" });
}
