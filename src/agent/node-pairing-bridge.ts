import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

let cache: { listNodePairing: Function; approveNodePairing: Function } | null = null;

function resolveOpenClawDist(): string {
  // Walk up from the gateway-resolved SDK module to find the dist directory.
  // import.meta.resolve is available in Node 20.6+.
  try {
    const corePath = fileURLToPath(import.meta.resolve("openclaw/plugin-sdk/core"));
    return dirname(dirname(corePath)); // dist/plugin-sdk/core.js → dist/
  } catch {
    for (const root of [
      join(process.env.APPDATA ?? "", "npm/node_modules/openclaw/dist"),
      "/opt/homebrew/lib/node_modules/openclaw/dist",
      "/home/linuxbrew/.linuxbrew/lib/node_modules/openclaw/dist",
      "/usr/local/lib/node_modules/openclaw/dist",
    ]) {
      try { readdirSync(root); return root; } catch {}
    }
    throw new Error("OpenClaw dist directory not found");
  }
}

export async function loadNodePairingModule(): Promise<{
  listNodePairing: Function;
  approveNodePairing: Function;
}> {
  if (cache) return cache;
  const dist = resolveOpenClawDist();
  const file = readdirSync(dist).find(
    (f) => f.startsWith("node-pairing-") && f.endsWith(".js") && !f.includes("authz"),
  );
  if (!file) throw new Error("node-pairing module not found in OpenClaw dist");
  // ESM import() correctly resolves named exports (listNodePairing, approveNodePairing)
  // unlike createRequire which exposes the minified export names (r, t).
  cache = await import(join(dist, file));
  return cache!;
}

/** Vitest-only: inject mock pairing functions. */
export function __setMockNodePairingForTests(mock: {
  listNodePairing: Function;
  approveNodePairing: Function;
}): void {
  cache = mock;
}
