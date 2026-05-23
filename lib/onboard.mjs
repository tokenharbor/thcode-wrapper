import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import readline from "node:readline";
import { spawn } from "node:child_process";

const BANNER = `
  ┌─────────────────────────────────────────────────┐
  │  thcode — Token Harbor coding agent             │
  │  Powered by opencode + TH smart-router          │
  └─────────────────────────────────────────────────┘
`;

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (a) => {
      rl.close();
      resolve(a.trim());
    });
  });
}

function tryOpenInBrowser(url) {
  const cmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "start"
    : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
    return true;
  } catch {
    return false;
  }
}

export async function runOnboarding({ configDir, dataDir, configFile, authFile }) {
  process.stdout.write(BANNER);
  console.log("Welcome — first-run setup (10 seconds).\n");
  console.log("Get a free thk_live_ API key at:");
  console.log("  https://tokenharbor.ai/dashboard/api-keys");
  console.log("(opening the page in your browser…)\n");
  tryOpenInBrowser("https://tokenharbor.ai/dashboard/api-keys");

  let key = "";
  for (let i = 0; i < 3; i++) {
    key = await prompt("Paste your thk_live_ key: ");
    if (key.startsWith("thk_live_") && key.length > 20) break;
    if (!key) {
      console.log("\nSkipped — you can re-run with `thcode reset` to try again later.");
      process.exit(0);
    }
    console.log("That doesn't look like a thk_live_ key. Try again.");
    key = "";
  }
  if (!key) {
    console.log("\nGave up after 3 tries. Run `thcode reset` once you have the key.");
    process.exit(1);
  }

  mkdirSync(configDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  let auth = {};
  if (existsSync(authFile)) {
    try { auth = JSON.parse(readFileSync(authFile, "utf8")); } catch { auth = {}; }
  }
  auth.tokenharbor = { type: "api", key };
  writeFileSync(authFile, JSON.stringify(auth, null, 2), { mode: 0o600 });
  try { chmodSync(authFile, 0o600); } catch {}

  const providerBlock = {
    tokenharbor: {
      name: "Token Harbor",
      npm: "@ai-sdk/openai-compatible",
      options: {
        baseURL: "https://tokenharbor.ai/v1",
      },
      models: {
        "tokenharbor-smart-thinking": { name: "Token Harbor — Smart Thinking" },
        "tokenharbor-smart-mini": { name: "Token Harbor — Smart Mini" },
        "tokenharbor-smart-fast": { name: "Token Harbor — Smart Fast" },
      },
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
  writeFileSync(configFile, JSON.stringify(existingCfg, null, 2));

  console.log("\nSaved.");
  console.log(`  Auth:   ${authFile}`);
  console.log(`  Config: ${configFile}`);
  console.log("\nLaunching opencode…\n");
}
