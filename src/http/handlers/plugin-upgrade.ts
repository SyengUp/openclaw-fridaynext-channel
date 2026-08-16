import type { IncomingMessage, ServerResponse } from "node:http";
import { extractBearerToken } from "../middleware/auth.js";
import { createFridayNextLogger } from "../../logging.js";
import { alternateRegistry, npmRegistryEnv, resolveNpmRegistry } from "../../npm-registry.js";
import { PLUGIN_PACKAGE_NAME, PLUGIN_VERSION } from "../../version.js";
import { fetchLatestVersion, getInstallSource } from "../../plugin-install-info.js";
import { getUpgradeRuntime, type SpawnResultLike } from "../../upgrade-runtime.js";

/**
 * Async plugin upgrade.
 *
 * POST /friday-next/plugin/upgrade runs `openclaw plugins install
 * @syengup/friday-channel-next@<exactVersion> --force` in the BACKGROUND and
 * responds 202 immediately; the app polls GET /friday-next/plugin/upgrade/status
 * for progress. The install used to run synchronously on the HTTP request path
 * with a 120s cap — on small gateways a cold npm install (all deps from
 * scratch) easily exceeds that, so the request hung until a proxy/app timeout
 * killed it (observed: 504 + "upgrade timed out", plus a double-tap running
 * two installs concurrently and OOM-killing the machine).
 *
 * The background install has a much longer cap (10 min) and is serialized:
 * a second POST while one is in flight returns 409, so two installs can never
 * race for memory or the config write lock again.
 *
 * On success the handler schedules a safe gateway restart (500ms after the
 * 202 has flushed). The restart wipes the in-process upgrade state — which is
 * exactly right: a fresh process runs the new plugin, so `status` reads idle
 * again and the app confirms success by comparing /plugin/info versions.
 *
 * Only npm-installed plugins are eligible — dev (load.paths / source==="path")
 * installs return 409 to protect the dev environment from duplicate npm
 * installs.
 *
 * We resolve the exact latest version and install THAT, never the `@latest`
 * dist-tag: OpenClaw persists a `@latest` install as a caret range
 * (`"^1.0.5"`) in the managed project package.json, and OpenClaw's own
 * plugin auto-update then rejects that range ("unsupported npm spec: use an
 * exact version or dist-tag"), disabling the plugin. Installing an exact
 * version makes OpenClaw store an exact spec, which auto-update accepts.
 */

/** Max time for the background install. Longer than a cold install needs
 *  (2-5 min on small gateways); nothing blocks on it, so it can be generous. */
const UPGRADE_INSTALL_TIMEOUT_MS = 10 * 60_000;
/** Give the 202 response time to flush AND the app one status poll
 *  (phase "installed") before the restart drops the connection. */
const RESTART_DELAY_MS = 2_000;

export type UpgradePhase = "idle" | "installing" | "installed" | "failed";

export type UpgradeState = {
  phase: UpgradePhase;
  /** Version the gateway was running when the upgrade started. */
  from: string;
  /** Version being installed. */
  to: string;
  /** Short machine-readable failure code (only when phase === "failed"). */
  error?: string;
  /** User-readable failure detail (stderr tail etc.). */
  detail?: string;
};

let upgradeState: UpgradeState = { phase: "idle", from: "", to: "" };

function failUpgrade(error: string, detail: string): void {
  upgradeState = { ...upgradeState, phase: "failed", error, detail };
}

/** Runs the install off the HTTP request path. Mutates `upgradeState` through
 *  installing → installed → (restart) → gone, or → failed.
 *
 *  Failover: an install that exits non-zero (npm timeout, registry hiccup)
 *  retries ONCE on the alternate registry (`npm-registry.ts` picks the faster
 *  channel; the alternate is the other candidate). One channel at a time —
 *  never two parallel installs, which is what OOM-killed a small gateway. */
async function runUpgradeInBackground(
  spec: string,
  preferredRegistry: string,
  npmEnv: NodeJS.ProcessEnv | undefined,
  log: ReturnType<typeof createFridayNextLogger>,
): Promise<void> {
  const rt = getUpgradeRuntime();
  if (!rt) {
    failUpgrade("runtime-unavailable", "upgrade runtime unavailable");
    return;
  }

  const runInstall = async (env: NodeJS.ProcessEnv | undefined): Promise<SpawnResultLike> => {
    try {
      return await rt.runCommandWithTimeout(
        ["openclaw", "plugins", "install", spec, "--force"],
        UPGRADE_INSTALL_TIMEOUT_MS,
        env,
      );
    } catch (err) {
      // `code: -1` marks a spawn failure (env/command problem — retrying on the
      // alternate registry would not help, so it is terminal).
      return { code: -1, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
    }
  };

  let result = await runInstall(npmEnv);
  if (result.code !== 0) {
    const alternate = alternateRegistry(preferredRegistry);
    if (alternate && result.code !== -1) {
      const stderrTail = (result.stderr ?? "").slice(-2000);
      log.warn(
        `plugin upgrade exited code=${result.code}; retrying once via ${alternate}: ${stderrTail}`,
      );
      const retryEnv = await npmRegistryEnv(Date.now(), alternate);
      const retried = await runInstall(retryEnv);
      if (retried.code === 0) result = retried;
      else result = retried.code !== -1 ? retried : result;
    }
  }

  if (result.code !== 0) {
    const stderrTail = (result.stderr ?? "").slice(-2000);
    const errorCode = result.code === -1 ? "spawn-failed" : "install-exit-nonzero";
    log.error(`plugin upgrade exited code=${result.code}: ${stderrTail}`);
    failUpgrade(errorCode, `exit code ${result.code}: ${stderrTail}`.slice(0, 2000));
    return;
  }

  upgradeState = { ...upgradeState, phase: "installed" };
  log.info("Plugin upgrade install succeeded; scheduling gateway restart");

  // Responding happened already; give the app one status poll (installed) before
  // the restart drops the connection, then trigger the safe restart.
  setTimeout(() => {
    void rt
      .mutateConfigFile({
        afterWrite: { mode: "restart", reason: "friday-next 插件自动升级后重启" },
        mutate: () => {},
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`gateway restart trigger failed: ${msg}`);
        failUpgrade("restart-failed", msg);
      });
  }, RESTART_DELAY_MS).unref?.();
}

export async function handlePluginUpgrade(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Method Not Allowed" }));
    return true;
  }
  if (!extractBearerToken(req)) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Unauthorized: bearer token mismatch" }));
    return true;
  }

  const log = createFridayNextLogger("upgrade");
  const installSource = getInstallSource();
  if (installSource !== "npm") {
    res.statusCode = 409;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        error: "auto-upgrade not available",
        detail: `install source is "${installSource}"; only npm installs can be auto-upgraded`,
        installSource,
      }),
    );
    return true;
  }

  const rt = getUpgradeRuntime();
  if (!rt) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "upgrade runtime unavailable" }));
    return true;
  }

  // Serialize upgrades: a second POST while one is in flight must not spawn a
  // concurrent install (double-tapping was the trigger for the OOM kill).
  if (upgradeState.phase === "installing" || upgradeState.phase === "installed") {
    res.statusCode = 409;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        error: "upgrade already in progress",
        phase: upgradeState.phase,
        from: upgradeState.from,
        to: upgradeState.to,
      }),
    );
    return true;
  }

  // In-app upgrade tracks the STABLE `latest` line ONLY. Beta is an opt-in testing
  // channel installed out-of-band via `install.js --beta`; it must never be pushed
  // through the in-app upgrade button. A prerelease install therefore upgrades only
  // once a stable release surpasses it (graduation onto the stable line).
  const latest = await fetchLatestVersion(Date.now(), "latest");
  if (!latest) {
    log.error(`plugin upgrade aborted: could not resolve latest version from npm registry`);
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        error: "could not resolve latest version",
        detail: "npm registry lookup failed; not falling back to @latest (would store a range)",
      }),
    );
    return true;
  }

  // Install the exact version, NOT the @latest dist-tag — see the doc comment.
  const spec = `${PLUGIN_PACKAGE_NAME}@${latest}`;
  log.info(`Starting plugin upgrade: ${spec} (from ${PLUGIN_VERSION})`);

  // Point npm at the fastest reachable registry (latency-aware; China mirror
  // when it beats the official) so the install subprocess doesn't wait out
  // npm's 5-minute fetch timeouts on a slow channel.
  const preferredRegistry = await resolveNpmRegistry(Date.now());
  const npmEnv = await npmRegistryEnv(Date.now(), preferredRegistry);
  if (npmEnv) log.info(`using npm registry ${npmEnv.npm_config_registry} for upgrade install`);

  upgradeState = { phase: "installing", from: PLUGIN_VERSION, to: latest };
  void runUpgradeInBackground(spec, preferredRegistry, npmEnv, log);

  // 202 immediately — the install runs in the background; the app polls
  // GET /friday-next/plugin/upgrade/status for progress.
  res.statusCode = 202;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ status: "upgrading", from: PLUGIN_VERSION, to: latest }));

  return true;
}

/**
 * GET /friday-next/plugin/upgrade/status
 *
 * Progress of the in-flight upgrade. After the gateway restart (success path)
 * the state is gone with the old process and reads `idle` — the app confirms
 * success by comparing /plugin/info versions, not by the phase alone.
 */
export async function handlePluginUpgradeStatus(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Method Not Allowed" }));
    return true;
  }
  if (!extractBearerToken(req)) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Unauthorized: bearer token mismatch" }));
    return true;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(upgradeState));
  return true;
}

/** Vitest-only: reset the module state between tests. */
export function resetUpgradeStateForTest(): void {
  upgradeState = { phase: "idle", from: "", to: "" };
}
