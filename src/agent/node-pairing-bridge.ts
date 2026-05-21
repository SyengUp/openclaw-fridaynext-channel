import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";

let cache: { listNodePairing: Function; approveNodePairing: Function } | null = null;

function resolveOpenClawDist(): string {
  // Resolve any known openclaw SDK module to find the dist directory.
  // This works cross-platform since the gateway's module loader
  // maps `openclaw/*` to the installed dist.
  const gatewayRequire = createRequire(import.meta.url);
  try {
    const corePath = gatewayRequire.resolve("openclaw/plugin-sdk/core");
    return dirname(dirname(corePath)); // dist/plugin-sdk/core.js → dist/
  } catch {
    // Fallback for when the plugin runs outside the gateway process.
    // Probe common install paths.
    for (const root of [
      join(process.env.APPDATA ?? "", "npm/node_modules/openclaw/dist"),    // Windows npm -g
      "/opt/homebrew/lib/node_modules/openclaw/dist",                        // macOS Homebrew
      "/home/linuxbrew/.linuxbrew/lib/node_modules/openclaw/dist",          // Linux Homebrew
      "/usr/local/lib/node_modules/openclaw/dist",                          // Unix npm -g
    ]) {
      try { readdirSync(root); return root; } catch {}
    }
    throw new Error("OpenClaw dist directory not found");
  }
}

export function loadNodePairingModule(): {
  listNodePairing: Function;
  approveNodePairing: Function;
} {
  if (cache) return cache;
  const dist = resolveOpenClawDist();
  const file = readdirSync(dist).find(
    (f) => f.startsWith("node-pairing-") && f.endsWith(".js") && !f.includes("authz"),
  );
  if (!file) throw new Error("node-pairing module not found in OpenClaw dist");
  cache = createRequire(join(dist, "_"))(`./${file.replace(/\.js$/, "")}`);
  return cache!;
}

/** Vitest-only: inject mock pairing functions. */
export function __setMockNodePairingForTests(mock: {
  listNodePairing: Function;
  approveNodePairing: Function;
}): void {
  cache = mock;
}
