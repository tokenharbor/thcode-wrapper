import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const TH_BASE = process.env.THCODE_BASE || "https://tokenharbor.ai";
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

const BANNER = `
  ┌─────────────────────────────────────────────────┐
  │  thcode — Token Harbor coding agent             │
  │  Every model, one key, no markup.               │
  └─────────────────────────────────────────────────┘
`;

// thcode (forked from charmbracelet/crush) reads its config from
// ~/.config/thcode/thcode.json — see internal/config/config.go:appName.
const THCODE_CONFIG_DIR = path.join(homedir(), ".config", "thcode");
const THCODE_CONFIG_FILE = path.join(THCODE_CONFIG_DIR, "thcode.json");

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
    if (body.status !== lastStatus) lastStatus = body.status;
    await new Promise((s) => setTimeout(s, POLL_INTERVAL_MS));
  }
  throw new Error("Login timed out after 5 minutes. Run thcode again.");
}

async function fetchModelCatalog(apiKey) {
  // Pull the live /v1/models catalog so the picker shows every model
  // the user can route to. Falls back to the 2 TH brand pools on
  // network failure.
  try {
    const r = await fetch(`${TH_BASE}/v1/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (!Array.isArray(data?.data) || data.data.length === 0) {
      throw new Error("empty catalog");
    }
    return data.data.map((m) => ({
      id: m.id,
      name: m.owned_by || m.id,
      cost_per_1m_in: 0,
      cost_per_1m_out: 0,
      cost_per_1m_in_cached: 0,
      cost_per_1m_out_cached: 0,
      context_window: 128000,
      default_max_tokens: 8192,
      can_reason: /thinking|reason/i.test(m.id),
      supports_attachments: false,
    }));
  } catch (err) {
    console.warn(`thcode: /v1/models fetch failed (${err?.message ?? err}); using fallback 2-brand list.`);
    return [
      {
        id: "tokenharbor-smart-fast",
        name: "Token Harbor Smart · Fast",
        cost_per_1m_in: 0, cost_per_1m_out: 0,
        cost_per_1m_in_cached: 0, cost_per_1m_out_cached: 0,
        context_window: 128000, default_max_tokens: 8192,
        can_reason: false, supports_attachments: false,
      },
      {
        id: "tokenharbor-smart-thinking",
        name: "Token Harbor Smart · Thinking",
        cost_per_1m_in: 0, cost_per_1m_out: 0,
        cost_per_1m_in_cached: 0, cost_per_1m_out_cached: 0,
        context_window: 128000, default_max_tokens: 8192,
        can_reason: true, supports_attachments: false,
      },
    ];
  }
}

async function writeThcodeConfig(apiKey) {
  mkdirSync(THCODE_CONFIG_DIR, { recursive: true });
  const models = await fetchModelCatalog(apiKey);
  const config = {
    $schema: "https://github.com/tokenharbor/thcode-crush/raw/main/schema.json",
    providers: {
      tokenharbor: {
        id: "tokenharbor",
        name: "Token Harbor",
        type: "openai-compat",
        base_url: `${TH_BASE}/v1`,
        api_key: apiKey,
        models,
      },
    },
  };
  writeFileSync(THCODE_CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
  try { chmodSync(THCODE_CONFIG_FILE, 0o600); } catch {}
  return models.length;
}

export async function runOnboarding() {
  if (hasTHProvider()) {
    return; // valid config already on disk — skip login.
  }

  process.stdout.write(BANNER);
  console.log("First-run setup. Starting browser login…\n");

  const { session_id, auth_url, poll_url } = await initSession();

  console.log("Open this URL to sign in (the browser should open automatically):");
  console.log(`\n  ${auth_url}\n`);
  tryOpenInBrowser(auth_url);
  console.log(`Waiting for approval (session ${session_id.slice(0, 8)}…)`);

  const key = await poll(poll_url);
  const modelCount = await writeThcodeConfig(key);

  console.log("\nLogged in.");
  console.log(`  Config saved to  ${THCODE_CONFIG_FILE}`);
  console.log(`  Models loaded    ${modelCount}`);
  console.log("\nLaunching thcode…\n");
}

export function hasTHProvider() {
  if (!existsSync(THCODE_CONFIG_FILE)) return false;
  try {
    const cfg = JSON.parse(readFileSync(THCODE_CONFIG_FILE, "utf8"));
    const provider = cfg?.providers?.tokenharbor;
    return Boolean(
      provider &&
      provider.type === "openai-compat" &&
      typeof provider.api_key === "string" &&
      provider.api_key.startsWith("thk_live_") &&
      Array.isArray(provider.models) &&
      provider.models.length > 0
    );
  } catch {
    return false;
  }
}
