import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { spawn } from "node:child_process";

const TH_BASE = process.env.THCODE_BASE || "https://tokenharbor.ai";
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

const BANNER = `
  ┌─────────────────────────────────────────────────┐
  │  thcode — Token Harbor coding agent             │
  │  Powered by opencode + TH smart-router          │
  └─────────────────────────────────────────────────┘
`;

function tryOpenInBrowser(url) {
  const cmd =
    process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "start"
    : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
    return true;
  } catch {
    return false;
  }
}

async function initSession() {
  const r = await fetch(`${TH_BASE}/api/cli/auth/init`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_label: "thcode" }),
  });
  if (!r.ok) throw new Error(`init failed: HTTP ${r.status}`);
  return r.json();
}

async function poll(pollUrl) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastStatus = "";
  while (Date.now() < deadline) {
    let body;
    try {
      const r = await fetch(pollUrl);
      body = await r.json();
    } catch {
      await new Promise((s) => setTimeout(s, POLL_INTERVAL_MS));
      continue;
    }
    if (body.status === "approved" && body.key) return body.key;
    if (body.status === "expired" || body.status === "denied" || body.status === "not_found") {
      throw new Error(`Login ${body.status}.`);
    }
    if (body.status !== lastStatus) {
      lastStatus = body.status;
    }
    await new Promise((s) => setTimeout(s, POLL_INTERVAL_MS));
  }
  throw new Error("Login timed out after 5 minutes. Run thcode again.");
}

export async function runOnboarding({ configDir, dataDir, configFile, authFile }) {
  process.stdout.write(BANNER);
  console.log("First-run setup. Starting browser login…\n");

  const { session_id, auth_url, poll_url } = await initSession();

  console.log("Open this URL to sign in (the browser should open automatically):");
  console.log(`\n  ${auth_url}\n`);
  tryOpenInBrowser(auth_url);
  console.log(`Waiting for approval (session ${session_id.slice(0, 8)}…)`);

  const key = await poll(poll_url);

  mkdirSync(configDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  let auth = {};
  if (existsSync(authFile)) {
    try { auth = JSON.parse(readFileSync(authFile, "utf8")); } catch { auth = {}; }
  }
  auth.tokenharbor = { type: "api", key };
  writeFileSync(authFile, JSON.stringify(auth, null, 2), { mode: 0o600 });
  try { chmodSync(authFile, 0o600); } catch {}

  // Fetch the user's actual model list from the gateway so /connect +
  // model picker show every model their key can hit (smart-router
  // brands AND direct alibaba/* / deepseek/* / kimi/* / glm/* aliases).
  // Without a populated `models` map opencode treats the provider as
  // empty and skips it from the picker entirely.
  let modelsMap = {
    "tokenharbor-smart-thinking": { name: "Token Harbor — Smart Thinking" },
    "tokenharbor-smart-mini": { name: "Token Harbor — Smart Mini" },
    "tokenharbor-smart-fast": { name: "Token Harbor — Smart Fast" },
  };
  try {
    const mr = await fetch(`${TH_BASE}/v1/models`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (mr.ok) {
      const body = await mr.json();
      const data = Array.isArray(body?.data) ? body.data : [];
      const fetched = {};
      for (const m of data) {
        if (m?.id && typeof m.id === "string") {
          fetched[m.id] = { name: m.id };
        }
      }
      if (Object.keys(fetched).length > 0) modelsMap = fetched;
    }
  } catch {}
  const providerBlock = {
    tokenharbor: {
      name: "Token Harbor",
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: `${TH_BASE}/v1` },
      models: modelsMap,
    },
  };

  let existingCfg = {};
  if (existsSync(configFile)) {
    try {
      const txt = readFileSync(configFile, "utf8").replace(/\/\/.*$/gm, "");
      existingCfg = JSON.parse(txt);
    } catch { existingCfg = {}; }
  }
  existingCfg.provider = { ...(existingCfg.provider || {}), ...providerBlock };
  existingCfg.model = "tokenharbor/tokenharbor-smart-thinking";
  existingCfg.small_model = "tokenharbor/tokenharbor-smart-fast";
  // Lock to TH only — hides Opencode Zen and every other built-in
  // provider from /connect, /models, and the boot picker.
  existingCfg.enabled_providers = ["tokenharbor"];
  writeFileSync(configFile, JSON.stringify(existingCfg, null, 2));

  console.log("\nLogged in.");
  console.log("  Auth saved to    " + authFile);
  console.log("  Config saved to  " + configFile);
  console.log("\nLaunching opencode…\n");
}

// Always called from bin/thcode.mjs on startup — independent of
// the auth-flow onboarding so users who set up before omo support
// landed still get omo installed automatically on their next launch.
export async function ensureOmoInstalled() {
  const omoConfigDir = `${process.env.HOME}/.config/opencode`;
  const omoConfigFile = `${omoConfigDir}/oh-my-opencode-slim.json`;
  if (existsSync(omoConfigFile)) return; // already on disk → refresher cron handles updates
  try {
    await installOmoAndFetchRouting();
  } catch (err) {
    console.log(
      "\nthcode: omo-slim install skipped (" + (err?.message ?? err) + "). " +
      "Run `bunx oh-my-opencode-slim@latest install` later if you want it.\n",
    );
  }
}

async function installOmoAndFetchRouting() {
  const { spawnSync } = await import("node:child_process");
  console.log("\nInstalling omo-slim (Token Harbor preset)…");
  // Try bunx (preferred — fast, no install step needed), fall through
  // to npx (universal, ships with npm). BOTH execute the package's
  // `install` subcommand which is what writes the plugin entry into
  // ~/.config/opencode/opencode.jsonc. Just `npm i -g` alone leaves
  // opencode unaware of the plugin, which is the bug Season hit on
  // 2026-05-24 (bunx failed, npm fallback didn't run install).
  const tryRunner = (cmd, args) => {
    try {
      const r = spawnSync(cmd, args, { stdio: "inherit" });
      return r.status === 0;
    } catch {
      return false;
    }
  };
  let ok = tryRunner("bunx", ["oh-my-opencode-slim@latest", "install"]);
  if (!ok) ok = tryRunner("npx", ["--yes", "oh-my-opencode-slim@latest", "install"]);
  if (!ok) {
    // Final fallback: global install then invoke directly. Some
    // environments block npx from auto-installing.
    const npmRes = spawnSync(
      "npm",
      ["i", "-g", "oh-my-opencode-slim"],
      { stdio: "inherit" },
    );
    if (npmRes.status !== 0) {
      throw new Error("bunx, npx, and npm-install all failed");
    }
    ok = tryRunner("oh-my-opencode-slim", ["install"]);
    if (!ok) throw new Error("omo-slim post-install command failed");
  }

  // Pull the Token Harbor preset from the gateway and write it as
  // the active config. Overwrites omo-slim's default openai preset.
  const omoConfigDir = `${process.env.HOME}/.config/opencode`;
  const omoConfigFile = `${omoConfigDir}/oh-my-opencode-slim.json`;
  try {
    const res = await fetch(`${TH_BASE}/api/thcode/routing`);
    if (!res.ok) {
      console.log("thcode: couldn't fetch routing preset (HTTP " + res.status + "), omo-slim will use its built-in default.");
      return;
    }
    const preset = await res.json();
    const fs = await import("node:fs");
    fs.mkdirSync(omoConfigDir, { recursive: true });
    fs.writeFileSync(omoConfigFile, JSON.stringify(preset, null, 2));
    console.log("thcode: omo routing written to " + omoConfigFile);
  } catch (err) {
    console.log("thcode: routing fetch failed: " + (err?.message ?? err));
  }
}
