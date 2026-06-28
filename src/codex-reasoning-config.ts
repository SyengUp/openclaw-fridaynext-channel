// Ensures the Codex app-server backend emits reasoning *summary* text so Friday can stream it.
//
// Background: OpenAI models authenticated via ChatGPT/OAuth run through OpenClaw's Codex
// app-server backend. That backend sends `reasoning_effort` per turn but never requests a
// reasoning summary, and OpenClaw exposes no `openclaw.json` lever for it. Without a summary the
// model's reasoning stays encrypted (`encrypted_content`) and no reasoning text reaches the
// channel — so the Friday app shows no streaming "thinking" for Codex models.
//
// The only switch that makes Codex return summary text is the Codex CLI's own
// `model_reasoning_summary` key in `~/.openclaw/agents/<id>/agent/codex-home/config.toml`.
// We keep the fix on the plugin side by asserting that key on activation (idempotently, for every
// agent that has a codex-home), so it survives OpenClaw rewrites of that file across restarts.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_KEY = "model_reasoning_summary";
// "detailed" is the value verified end-to-end (reasoning streamed to the app). Codex also accepts
// "auto"/"concise"; tune here if the summaries feel too verbose.
const SUMMARY_VALUE = "detailed";

function resolveOpenClawHome(): string {
  const env = process.env.OPENCLAW_HOME?.trim();
  return env && env.length > 0 ? env : join(homedir(), ".openclaw");
}

/**
 * True if a top-level `model_reasoning_summary` key already exists. TOML scoping matters: a key is
 * only top-level (and thus honored by Codex) if it appears before the first `[section]` header, so
 * we stop scanning at the first table header.
 */
export function hasTopLevelSummaryKey(content: string): boolean {
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) break;
    if (new RegExp(`^${CONFIG_KEY}\\s*=`).test(line)) return true;
  }
  return false;
}

function ensureKeyInCodexHome(codexHome: string): "added" | "present" | "skip" {
  const configPath = join(codexHome, "config.toml");
  const header = `${CONFIG_KEY} = "${SUMMARY_VALUE}"\n`;
  if (!existsSync(configPath)) {
    writeFileSync(configPath, header, "utf8");
    return "added";
  }
  const content = readFileSync(configPath, "utf8");
  if (hasTopLevelSummaryKey(content)) return "present";
  // Prepend so the key stays top-level even if the file starts with a `[section]` table.
  writeFileSync(configPath, `${header}\n${content}`, "utf8");
  return "added";
}

/**
 * Best-effort: ensure every agent's Codex config requests a reasoning summary. Never throws —
 * activation must not fail because of a config write. `log` receives a one-line summary per change.
 */
export function ensureCodexReasoningSummary(log: (msg: string) => void): void {
  try {
    const agentsDir = join(resolveOpenClawHome(), "agents");
    if (!existsSync(agentsDir)) return;
    for (const agentId of readdirSync(agentsDir)) {
      const codexHome = join(agentsDir, agentId, "agent", "codex-home");
      // Only touch agents Codex has actually initialized (codex-home exists). New agents are
      // picked up on the next activation/restart.
      if (!existsSync(codexHome)) continue;
      try {
        mkdirSync(codexHome, { recursive: true });
        const result = ensureKeyInCodexHome(codexHome);
        if (result === "added") {
          log(`codex reasoning summary enabled (agent=${agentId})`);
        }
      } catch (err) {
        log(`codex reasoning summary write failed (agent=${agentId}): ${String(err)}`);
      }
    }
  } catch (err) {
    log(`codex reasoning summary ensure failed: ${String(err)}`);
  }
}
