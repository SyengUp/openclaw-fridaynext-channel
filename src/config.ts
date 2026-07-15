import { homedir } from "node:os";

export type FridayNextLogLevel = "debug" | "info" | "warn" | "error";

export type FridayNextConfig = {
  channelId: "friday-next";
  pathPrefix: string;
  transport: string;
  historyLimit: number;
  historyDir: string;
  logLevel: FridayNextLogLevel;
  authToken: string;
  corsEnabled: boolean;
  corsAllowOrigin: string;
  sseKeepaliveSec: number;
  sseBacklogPerDevice: number;
  publicAccess: PublicAccessConfigResolved;
};

/** Public access (FridayNext 云) — resolved from `channels.friday-next.publicAccess`. */
export type PublicAccessConfigResolved = {
  enabled: boolean;
  relayAddr: string;
  relayToken: string;
  subDomainHost: string;
  subdomain: string;
  allocatorUrl: string;
  certSignUrl: string;
  corePort: number;
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function asNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function resolveFridayNextConfig(cfg: unknown): FridayNextConfig {
  const root = asObject(cfg);
  const channels = asObject(root.channels);
  const section = asObject(channels["friday-next"]);
  const sse = asObject(section.sse);
  const cors = asObject(section.cors);
  const pa = asObject(section.publicAccess);

  const authToken =
    asString(asObject(root.gateway).auth && asObject(asObject(root.gateway).auth).token, "") ||
    asString(section.authToken, "") ||
    asString(process.env.FRIDAY_NEXT_AUTH_TOKEN, "");

  return {
    channelId: "friday-next",
    pathPrefix: asString(section.pathPrefix, "/friday-next"),
    transport: asString(section.transport, "http+sse"),
    historyLimit: asNumber(section.historyLimit, 25, 1, 200),
    historyDir: asString(section.historyDir, `${homedir()}/.openclaw/friday-next/history`),
    logLevel: asString(section.logLevel, "info") as FridayNextLogLevel,
    authToken,
    corsEnabled: asBool(cors.enabled, false),
    corsAllowOrigin: asString(cors.allowOrigin, "*"),
    sseKeepaliveSec: asNumber(sse.keepaliveSec, 30, 5, 120),
    sseBacklogPerDevice: asNumber(sse.backlogPerDevice, 200, 0, 1000),
    publicAccess: {
      // Default OFF: only tunnels when explicitly enabled in config, so a published plugin never
      // auto-routes a stranger's gateway to our relay. The bare-test gateway sets enabled=true.
      enabled: asBool(pa.enabled, false),
      relayAddr: asString(pa.relayAddr, "47.95.195.236:7000"),
      relayToken: asString(pa.relayToken, ""),
      subDomainHost: asString(pa.subDomainHost, "bj.gw.syengup.host"),
      subdomain: asString(pa.subdomain, ""),
      allocatorUrl: asString(pa.allocatorUrl, "https://friday.syengup.host/gw-alloc/allocate"),
      certSignUrl: asString(pa.certSignUrl, "https://friday.syengup.host/gw-alloc/sign-cert"),
      corePort: asNumber(pa.corePort, 18789, 1, 65535),
    },
  };
}
