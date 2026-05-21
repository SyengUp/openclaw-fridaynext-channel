import { readdirSync } from "node:fs";
import { join } from "node:path";

let cache: { listNodePairing: Function; approveNodePairing: Function } | null = null;

function resolveOpenClawDist(): string {
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

  // ESM import() returns the minified export names (r, t, …) because the
  // bundled module uses `export { listNodePairing as r, … }`.  Resolve the
  // correct functions by Function.name, which preserves the original name.
  const mod = await import(join(dist, file));
  let listNodePairing: Function | undefined;
  let approveNodePairing: Function | undefined;
  for (const value of Object.values(mod)) {
    if (typeof value === "function") {
      if (value.name === "listNodePairing") listNodePairing = value;
      else if (value.name === "approveNodePairing") approveNodePairing = value;
    }
  }
  if (!listNodePairing || !approveNodePairing) {
    throw new Error("node-pairing module did not export expected functions");
  }
  cache = { listNodePairing, approveNodePairing };
  return cache;
}

/** Vitest-only: inject mock pairing functions. */
export function __setMockNodePairingForTests(mock: {
  listNodePairing: Function;
  approveNodePairing: Function;
}): void {
  cache = mock;
}
