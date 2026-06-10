import type { IncomingMessage, ServerResponse } from "node:http";
import { extractBearerToken } from "../middleware/auth.js";
import { PLUGIN_VERSION } from "../../version.js";
import {
  fetchLatestVersion,
  getInstallSource,
  semverGreater,
} from "../../plugin-install-info.js";

export interface PluginInfoResult {
  currentVersion: string;
  latestVersion: string | null;
  installSource: string;
  /** True when the install is npm-managed (the only auto-upgradable source). */
  canAutoUpgrade: boolean;
  /** True when a newer version is published AND the install can be auto-upgraded. */
  upgradable: boolean;
}

export async function handlePluginInfo(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
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

  const installSource = getInstallSource();
  const canAutoUpgrade = installSource === "npm";
  const latestVersion = await fetchLatestVersion(Date.now());
  const upgradable = canAutoUpgrade && semverGreater(latestVersion, PLUGIN_VERSION);

  const result: PluginInfoResult = {
    currentVersion: PLUGIN_VERSION,
    latestVersion,
    installSource,
    canAutoUpgrade,
    upgradable,
  };

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(result));
  return true;
}
