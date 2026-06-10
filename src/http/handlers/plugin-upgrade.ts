import type { IncomingMessage, ServerResponse } from "node:http";
import { extractBearerToken } from "../middleware/auth.js";
import { createFridayNextLogger } from "../../logging.js";
import { PLUGIN_PACKAGE_NAME, PLUGIN_VERSION } from "../../version.js";
import { getInstallSource } from "../../plugin-install-info.js";
import { getUpgradeRuntime } from "../../upgrade-runtime.js";

const UPGRADE_TIMEOUT_MS = 120_000;
/** Give the 202 response time to flush before the restart kills the process. */
const RESTART_DELAY_MS = 500;

/**
 * POST /friday-next/plugin/upgrade
 *
 * Runs `openclaw plugins install @syengup/friday-channel-next@latest --force`
 * (registry-aware, updates the install record), responds 202, then triggers a
 * safe gateway restart so the new version loads. Only npm-installed plugins are
 * eligible — dev (load.paths / source==="path") installs return 409 to protect
 * the dev environment from duplicate npm installs.
 */
export async function handlePluginUpgrade(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
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

  const spec = `${PLUGIN_PACKAGE_NAME}@latest`;
  log.info(`Starting plugin upgrade: ${spec} (from ${PLUGIN_VERSION})`);

  let result;
  try {
    result = await rt.runCommandWithTimeout(
      ["openclaw", "plugins", "install", spec, "--force"],
      UPGRADE_TIMEOUT_MS,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`plugin upgrade command failed to spawn: ${msg}`);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "upgrade command failed", detail: msg }));
    return true;
  }

  if (result.code !== 0) {
    const stderrTail = (result.stderr ?? "").slice(-2000);
    log.error(`plugin upgrade exited code=${result.code}: ${stderrTail}`);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        error: "upgrade command exited non-zero",
        code: result.code,
        detail: stderrTail,
      }),
    );
    return true;
  }

  log.info("Plugin upgrade install succeeded; scheduling gateway restart");

  // Respond first so the app receives confirmation before the restart drops the
  // connection, then trigger the safe restart after a short flush delay.
  res.statusCode = 202;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ status: "upgrading", from: PLUGIN_VERSION }));

  setTimeout(() => {
    void rt
      .mutateConfigFile({
        afterWrite: { mode: "restart", reason: "friday-next 插件自动升级后重启" },
        mutate: () => {},
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`gateway restart trigger failed: ${msg}`);
      });
  }, RESTART_DELAY_MS).unref?.();

  return true;
}
