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

  // Don't hard-code a `models` map — without it, opencode fetches
  // /v1/models from the gateway and surfaces every model the user's
  // key can hit, including the three smart-router brands AND the
  // direct alibaba/* / deepseek/* / kimi/* / glm/* aliases.
  const providerBlock = {
    tokenharbor: {
      name: "Token Harbor",
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: `${TH_BASE}/v1` },
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
