import { execSync } from "node:child_process";
import { readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

let cache: { listNodePairing: Function; approveNodePairing: Function } | null = null;

function resolveOpenClawDistFromBin(): string | null {
  try {
    const whichCmd = process.platform === "win32" ? "where" : "which";
    const raw = execSync(`${whichCmd} openclaw`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const binPath = raw.split("\n")[0].trim();
    if (!binPath) return null;
    const real = realpathSync(binPath);
    const dist = join(dirname(real), "dist");
    readdirSync(dist); // throw if not a readable directory
    return dist;
  } catch {
    return null;
  }
}

function resolveOpenClawDist(): string {
  // Priority order:
  //   1. OPENCLAW_DIST env var (explicit override, works everywhere)
  //   2. Resolve the `openclaw` binary on PATH → dist/ (robust, cross-platform)
  //   3. Platform-specific standard install paths
  const fromBin = resolveOpenClawDistFromBin();
  const candidates: string[] = [
    process.env.OPENCLAW_DIST,
    fromBin,
    join(process.env.APPDATA ?? "", "npm/node_modules/openclaw/dist"),
    "/opt/homebrew/lib/node_modules/openclaw/dist",
    "/home/linuxbrew/.linuxbrew/lib/node_modules/openclaw/dist",
    "/usr/local/lib/node_modules/openclaw/dist",
  ].filter((v): v is string => typeof v === "string" && v.length > 0);

  for (const root of candidates) {
    try { readdirSync(root); return root; } catch {}
  }
  throw new Error("OpenClaw dist directory not found. Set OPENCLAW_DIST env var.");
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
