import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const TH_BASE = process.env.THCODE_BASE || "https://tokenharbor.ai";
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

const BANNER = `
  ┌─────────────────────────────────────────────────┐
  │  THcoder — Token Harbor coding agent            │
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
  const findId = (...needles) => {
    for (const n of needles) {
      const m = models.find((x) => x.id === n) || models.find((x) => x.id.includes(n));
      if (m) return m.id;
    }
    return models[0]?.id;
  };
  // TH Orchestra is the default for both large and small — the gateway
  // classifies each request internally and dispatches to the right
  // role pool. Falls back to a legacy smart brand if orchestra isn't
  // available (admin disabled it), and finally to whichever model
  // comes first in the catalog.
  const largeId = findId("th-orchestra", "tokenharbor-smart-thinking", "thinking");
  const smallId = findId("th-orchestra", "tokenharbor-smart-fast", "fast");
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
        // Prepended to every system prompt. Short + forceful — long
        // multi-paragraph prefixes get diluted by the agent's own
        // (much longer) system prompt downstream.
        system_prompt_prefix: [
          "LANGUAGE: Reply in the SAME language as the user's most recent message. Chinese in → Chinese out. Never switch unless the user does.",
          "PATHS: If the user names a directory (e.g. 'TDI directory', 'TDI目录'), use that name AS-IS in your tool call. If you don't know its full path, run glob '**/TDI/*' or find — DO NOT list the user's home and visually scan for it (you may not see all entries). Never tell the user their message was 'unclear' or 'truncated' just because you couldn't immediately locate a named directory; locate it.",
          "INTERPRETATION: Tool results NEVER say 'your message was truncated'. If a tool returned partial output, run a more specific tool call. Never project tool-result limitations onto the user's prompt.",
        ].join("\n\n"),
      },
    },
    models: {
      large: { provider: "tokenharbor", model: largeId },
      small: { provider: "tokenharbor", model: smallId },
    },
    // Role routing is now handled server-side by the gateway when
    // `models.large = th-orchestra` — the gateway classifies each
    // request as planner / coder / reviewer / fetcher / summarizer and
    // picks the right upstream from the role's candidate pool
    // (admin-configurable in /admin/config/smart-routing).
    //
    // The client-side classifier in the thcode binary is retained as
    // FALLBACK: when the user explicitly picks a direct-vendor model
    // (e.g. /model deepseek-v4-pro), the binary still classifies turns
    // and applies role prompt addenda. With TH Orchestra selected, the
    // client-side classifier sees `Roles` map is empty (this block) so
    // it's a no-op — the gateway handles everything.
    //
    // To opt back into client-side per-role model overrides, fill in
    // this block with concrete provider/model pairs.
    // roles: { planner: {...}, coder: {...}, ... }
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
        // Home-dir listings have a lot of hidden dotfiles. Cap of 200
        // dropped `Documents/` past the visible window for one user,
        // and the agent then claimed "user's message was truncated"
        // instead of finding the named subdirectory. 1000 (Crush's
        // upstream default) is the sweet spot: enough to surface every
        // top-level subdir on a normal home, still bounded enough that
        // a single ls won't blast a 128K context.
        max_depth: 2,
        max_items: 1000,
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
