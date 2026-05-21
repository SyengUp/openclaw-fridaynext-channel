import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const OPENCLAW_DIST = "/opt/homebrew/lib/node_modules/openclaw/dist";

let cache: { listNodePairing: Function; approveNodePairing: Function } | null = null;

export function loadNodePairingModule(): {
  listNodePairing: Function;
  approveNodePairing: Function;
} {
  if (cache) return cache;
  const file = readdirSync(OPENCLAW_DIST).find(
    (f) => f.startsWith("node-pairing-") && f.endsWith(".js") && !f.includes("authz"),
  );
  if (!file) throw new Error("node-pairing module not found in OpenClaw dist");
  const gatewayRequire = createRequire(join(OPENCLAW_DIST, "_"));
  cache = gatewayRequire(`./${file.replace(/\.js$/, "")}`);
  return cache!;
}

/** Vitest-only: inject mock pairing functions. */
export function __setMockNodePairingForTests(mock: {
  listNodePairing: Function;
  approveNodePairing: Function;
}): void {
  cache = mock;
}
