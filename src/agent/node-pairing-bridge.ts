import { existsSync, readdirSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { importAbsoluteModule } from "../import-absolute-module.js";

// Results come from the untyped OpenClaw dist module, so the resolved shapes are
// `any` at this host boundary — callers read dynamic fields (.pending, .status, …).
type ListNodePairingFn = () => Promise<any>;
type ApproveNodePairingFn = (
  requestId: string,
  options: { callerScopes?: unknown },
) => Promise<any>;
type NodePairingModule = {
  listNodePairing: ListNodePairingFn;
  approveNodePairing: ApproveNodePairingFn;
};

let cache: NodePairingModule | null = null;

function resolveOpenClawDistFromPath(): string | null {
  // Walk PATH looking for the openclaw binary, then resolve its real
  // location to find the dist/ directory.  No shell commands needed.
  const binName = process.platform === "win32" ? "openclaw.cmd" : "openclaw";
  const pathDirs = (process.env.PATH ?? "").split(delimiter);
  for (const dir of pathDirs) {
    const candidate = join(dir, binName);
    if (!existsSync(candidate)) continue;
    try {
      const real = realpathSync(candidate);
      const dist = join(dirname(real), "dist");
      readdirSync(dist);
      return dist;
    } catch {
      // Not a real dist dir — keep walking PATH.
    }
  }
  return null;
}

function resolveOpenClawDist(): string {
  // Priority order:
  //   1. OPENCLAW_DIST env var (explicit override, works everywhere)
  //   2. Resolve the `openclaw` binary on PATH → dist/ (robust, cross-platform)
  //   3. Platform-specific standard install paths
  const fromBin = resolveOpenClawDistFromPath();
  const candidates: string[] = [
    process.env.OPENCLAW_DIST,
    fromBin,
    // Windows: standard npm -g locations
    join(process.env.APPDATA ?? "", "npm/node_modules/openclaw/dist"),
    join(process.env.LOCALAPPDATA ?? "", "npm/node_modules/openclaw/dist"),
    // Cross-platform: version-manager paths detected from PATH resolution
    // (nvm/fnm/asdf installs are found by resolveOpenClawDistFromPath via PATH)
    "/opt/homebrew/lib/node_modules/openclaw/dist",
    "/home/linuxbrew/.linuxbrew/lib/node_modules/openclaw/dist",
    "/usr/local/lib/node_modules/openclaw/dist",
    // Linux: npm -g with prefix=/usr
    "/usr/lib/node_modules/openclaw/dist",
  ].filter((v): v is string => typeof v === "string" && v.length > 0);

  for (const root of candidates) {
    try {
      readdirSync(root);
      return root;
    } catch {
      // Candidate dir doesn't exist — try the next one.
    }
  }
  throw new Error("OpenClaw dist directory not found. Set OPENCLAW_DIST env var.");
}

/**
 * OpenClaw hashed the pairing helpers into `node-pairing-*.js` through 2026.7.x.
 * 2026.8.1 renamed the chunk to `device-pairing-node-*.js` and left
 * `node-pairing-migration-*.js` / `node-pairing-authz-*.js` in dist — those
 * must not be picked as the live module.
 */
export function nodePairingModuleCandidates(filenames: string[]): string[] {
  const js = filenames.filter((f) => f.endsWith(".js"));
  const current = js.filter((f) => f.startsWith("device-pairing-node-"));
  const legacy = js.filter(
    (f) =>
      f.startsWith("node-pairing-") && !f.includes("authz") && !f.includes("migration"),
  );
  return [...current, ...legacy];
}

function readPairingExports(mod: Record<string, unknown>): NodePairingModule | null {
  // ESM import() returns the minified export names (r, t, …) because the
  // bundled module uses `export { listNodePairing as r, … }`.  Resolve the
  // correct functions by Function.name, which preserves the original name.
  let listNodePairing: ListNodePairingFn | undefined;
  let approveNodePairing: ApproveNodePairingFn | undefined;
  for (const value of Object.values(mod)) {
    if (typeof value === "function") {
      if (value.name === "listNodePairing") listNodePairing = value as ListNodePairingFn;
      else if (value.name === "approveNodePairing")
        approveNodePairing = value as ApproveNodePairingFn;
    }
  }
  if (!listNodePairing || !approveNodePairing) return null;
  return { listNodePairing, approveNodePairing };
}

export async function loadNodePairingModule(): Promise<NodePairingModule> {
  if (cache) return cache;
  const dist = resolveOpenClawDist();
  const candidates = nodePairingModuleCandidates(readdirSync(dist));
  if (candidates.length === 0) throw new Error("node-pairing module not found in OpenClaw dist");

  for (const file of candidates) {
    const mod = (await importAbsoluteModule(join(dist, file))) as Record<string, unknown>;
    const resolved = readPairingExports(mod);
    if (resolved) {
      cache = resolved;
      return cache;
    }
  }
  throw new Error("node-pairing module did not export expected functions");
}

/** Vitest-only: inject mock pairing functions. */
export function __setMockNodePairingForTests(mock: NodePairingModule): void {
  cache = mock;
}
