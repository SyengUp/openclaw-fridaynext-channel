import type { ServerResponse } from "node:http";
import { resolveFridayNextConfig } from "../../config.js";
import { getHostOpenClawConfigSnapshot } from "../../host-config.js";
import { getFridayNextRuntime } from "../../runtime.js";

export function applyCorsHeaders(res: ServerResponse): void {
  const cfg = resolveFridayNextConfig(getHostOpenClawConfigSnapshot(getFridayNextRuntime().config));
  if (!cfg.corsEnabled) return;
  res.setHeader("Access-Control-Allow-Origin", cfg.corsAllowOrigin || "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Last-Event-ID");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
}
