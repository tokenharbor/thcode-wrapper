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
    // `owned_by` from /v1/models is the upstream VENDOR id (e.g.
    // "alicloud-intl-us"), not a display name — using it makes every
    // alicloud-routed model show up identically in the picker. Use the
    // model id itself with light prettification.
    const prettify = (id) =>
      id
        .replace(/^tokenharbor-/, "Token Harbor ")
        .replace(/-/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
    return data.data.map((m) => ({
      id: m.id,
      name: prettify(m.id),
      // /v1/models returns m.pricing.{input,output}_usd_per_1m — pipe
      // it straight into Crush's cost-tracking fields. Without this,
      // the TUI's session-cost footer is forever $0.00 even when the
      // admin dashboard shows the real spend.
      cost_per_1m_in: m.pricing?.input_usd_per_1m ?? 0,
      cost_per_1m_out: m.pricing?.output_usd_per_1m ?? 0,
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

function buildThcodeConfig(apiKey, models) {
  // Pick sensible large/small defaults so Crush doesn't fall back to
  // a "<provider-id>-virtual" placeholder model when no selection has
  // been persisted yet. Prefer the thinking brand for "large" reasoning
  // tasks and the fast brand for "small" routine calls.
  const findId = (substr) => models.find((m) => m.id.includes(substr))?.id;
  const largeId = findId("smart-thinking") || findId("thinking") || models[0]?.id;
  const smallId = findId("smart-fast") || findId("fast") || models[0]?.id;
  return {
    $schema: "https://github.com/tokenharbor/thcode-crush/raw/main/schema.json",
    providers: {
      tokenharbor: {
        id: "tokenharbor",
        name: "Token Harbor",
        type: "openai-compat",
        base_url: `${TH_BASE}/v1`,
        api_key: apiKey,
        models,
        // Prepended to every system prompt. Upstream Crush's agent
        // prompts are English-only — match the user's language so a
        // Chinese question doesn't get an English answer. Also tell
        // the model how Crush displays tool output so it doesn't
        // misread a "(N lines hidden)" UI banner as a request
        // truncation signal.
        system_prompt_prefix:
          "Always reply in the language of the user's most recent message. " +
          "If the user writes in Chinese (中文 / 简体 / 繁體), reply in Chinese. " +
          "If the user writes in another language, reply in that language. " +
          "Do not switch languages mid-conversation unless the user does.\n\n" +
          "The Crush TUI may collapse long tool results for the user's display " +
          "(e.g. '(191 lines hidden) [click or space to expand]'). This is a " +
          "UI-only compression — the full tool output is already in your " +
          "context window. Never interpret it as truncation of the user's " +
          "message or as missing data; never ask the user to 're-send the full " +
          "request' just because a tool result was visually shortened.",
      },
    },
    models: {
      large: { provider: "tokenharbor", model: largeId },
      small: { provider: "tokenharbor", model: smallId },
    },
    options: {
      // Lock the binary to TH-only. Catwalk fetch is bypassed so the
      // picker never advertises Anthropic/OpenAI/etc., and the bundled
      // provider catalog is dropped entirely. Moved here from
      // CRUSH_DISABLE_* env vars so the policy is visible in the
      // config file the user might inspect.
      disable_default_providers: true,
      disable_provider_auto_update: true,
      // Token Harbor doesn't ship telemetry.
      disable_metrics: true,
      // Auto-summarize is INDUSTRY STANDARD (Claude Code, OpenCode both
      // do it) — keep it enabled as the long-conversation safety valve.
      // The earlier symptom (turn-3 losing turn-1/2 context) was caused
      // by a single noisy ls dump saturating context, not by long
      // legitimate conversation. With tools.ls capped below, ls can't
      // dump >~6K tokens, so summarize won't fire prematurely.
      disable_auto_summarize: false,
      // Don't inject "Generated with thcode" trailers into user's git
      // commits — that's their call, not ours.
      attribution: {
        trailer_style: "none",
        generated_with: false,
      },
    },
    tools: {
      // ls hard cap so one noisy dump can't blast context. Depth 2 is
      // a shallow overview; agent should glob/grep for drill-down.
      // max_items 200 keeps the worst-case output at ~6K tokens.
      ls: {
        max_depth: 2,
        max_items: 200,
      },
      // grep default is 5s — too short for any non-trivial codebase.
      // Crush's `time.Duration` JSON shape is integer nanoseconds, NOT
      // a "30s" string (no custom UnmarshalJSON in upstream config.go).
      // 30 * 1e9 ns = 30 seconds.
      grep: {
        timeout: 30_000_000_000,
      },
    },
  };
}

async function writeThcodeConfig(apiKey) {
  mkdirSync(THCODE_CONFIG_DIR, { recursive: true });
  const models = await fetchModelCatalog(apiKey);
  const config = buildThcodeConfig(apiKey, models);
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

/**
 * Re-fetch /v1/models and update the provider's models[] in place,
 * preserving everything else. Best-effort: silently keeps the existing
 * catalog on network failure. Also re-pins the api_key + base_url to
 * the current TH defaults, and rewrites the models.{large,small}
 * selection so new model rolls are picked up automatically.
 *
 * The Token Harbor distribution allows ONLY the `tokenharbor` provider —
 * any other providers in the config are silently dropped on refresh, so
 * users can't escape the brand by hand-editing the file.
 */
export async function refreshFromGateway() {
  if (!existsSync(THCODE_CONFIG_FILE)) return;
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(THCODE_CONFIG_FILE, "utf8"));
  } catch {
    return; // corrupt config — leave alone, runOnboarding will rewrite it
  }
  const apiKey = cfg?.providers?.tokenharbor?.api_key;
  if (typeof apiKey !== "string" || !apiKey.startsWith("thk_live_")) return;
  let models;
  try {
    models = await fetchModelCatalog(apiKey);
  } catch {
    return;
  }
  if (!Array.isArray(models) || models.length === 0) return;

  // Rebuild from scratch using the canonical TH shape — this also
  // strips any non-`tokenharbor` providers the user may have
  // hand-added (Anthropic, OpenAI, etc.). Then merge back any
  // user-preserved subtrees we want to keep (e.g. lsp, mcp, hooks).
  const fresh = buildThcodeConfig(apiKey, models);
  const next = {
    ...fresh,
    // Preserve user-editable subtrees that aren't security-sensitive.
    ...(cfg.lsp ? { lsp: cfg.lsp } : {}),
    ...(cfg.mcp ? { mcp: cfg.mcp } : {}),
    ...(cfg.hooks ? { hooks: cfg.hooks } : {}),
    ...(cfg.permissions ? { permissions: cfg.permissions } : {}),
  };
  writeFileSync(THCODE_CONFIG_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  try { chmodSync(THCODE_CONFIG_FILE, 0o600); } catch {}
}
