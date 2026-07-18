import { homedir } from "node:os";

export type FridayNextLogLevel = "debug" | "info" | "warn" | "error";

export type FridayNextConfig = {
  channelId: "friday-next";
  historyLimit: number;
  historyDir: string;
  logLevel: FridayNextLogLevel;
  authToken: string;
  corsEnabled: boolean;
  corsAllowOrigin: string;
  sseKeepaliveSec: number;
  sseBacklogPerDevice: number;
  publicAccess: PublicAccessConfigResolved;
  appAttest: AppAttestConfigResolved;
};

/** App Attest gate — "only the genuine FridayNext app can connect" (App Store/TestFlight
 * app on a real Apple device). Off by default so non-attest clients keep working until
 * explicitly enabled. */
export type AppAttestConfigResolved = {
  required: boolean;
  teamId: string;
  bundleId: string;
  /** Accept development-environment attestations (ad-hoc / TestFlight dev builds). */
  allowDevelopment: boolean;
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
  /** Control-plane base for OSS attachment side-channel signing (Phase E). Client appends /v1. */
  controlPlaneUrl: string;
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

function asLogLevel(value: unknown): FridayNextLogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error"
    ? value
    : "info";
}

export function resolveFridayNextConfig(cfg: unknown): FridayNextConfig {
  const root = asObject(cfg);
  const channels = asObject(root.channels);
  const section = asObject(channels["friday-next"]);
  const sse = asObject(section.sse);
  const cors = asObject(section.cors);
  const pa = asObject(section.publicAccess);
  const aa = asObject(section.appAttest);

  const authToken =
    asString(asObject(root.gateway).auth && asObject(asObject(root.gateway).auth).token, "") ||
    asString(section.authToken, "") ||
    asString(process.env.FRIDAY_NEXT_AUTH_TOKEN, "");

  return {
    channelId: "friday-next",
    historyLimit: asNumber(section.historyLimit, 25, 1, 200),
    historyDir: asString(section.historyDir, `${homedir()}/.openclaw/friday-next/history`),
    logLevel: asLogLevel(section.logLevel),
    authToken,
    corsEnabled: asBool(cors.enabled, false),
    corsAllowOrigin: asString(cors.allowOrigin, "*"),
    sseKeepaliveSec: asNumber(sse.keepaliveSec, 30, 5, 120),
    sseBacklogPerDevice: asNumber(sse.backlogPerDevice, 200, 0, 1000),
    publicAccess: {
      // Default OFF: only tunnels when explicitly enabled in config, so a published plugin never
      // auto-routes a stranger's gateway to our relay. The bare-test gateway sets enabled=true.
      enabled: asBool(pa.enabled, false),
      // Both OPTIONAL overrides. Left empty, the gateway fetches the relay address and shared
      // token from the control plane at bring-up (and caches them under the public-access data
      // dir) — so the token isn't copied into every user's config file, and a relay move needs
      // no config edit. Set them to point at your own frps.
      relayAddr: asString(pa.relayAddr, ""),
      relayToken: asString(pa.relayToken, ""),
      subDomainHost: asString(pa.subDomainHost, "bj.gw.syengup.host"),
      subdomain: asString(pa.subdomain, ""),
      allocatorUrl: asString(pa.allocatorUrl, "https://friday.syengup.host/gw-alloc/allocate"),
      certSignUrl: asString(pa.certSignUrl, "https://friday.syengup.host/gw-alloc/sign-cert"),
      corePort: asNumber(pa.corePort, 18789, 1, 65535),
      controlPlaneUrl: asString(pa.controlPlaneUrl, "https://friday.syengup.host"),
    },
    appAttest: {
      // Default ON, but the gate is PUBLIC-SCOPED (only enforced on requests the
      // filter proxy marks as arriving via the relay — see server.ts isPublicRequest).
      // So this default is safe: with public access off there's no marker and the gate
      // never fires (LAN untouched); with public access on, the public URL is
      // automatically app-only. Set false to opt out even on the public surface.
      required: asBool(aa.required, true),
      teamId: asString(aa.teamId, "LQF97XWK5A"),
      bundleId: asString(aa.bundleId, "SyengUp.FridayNext"),
      allowDevelopment: asBool(aa.allowDevelopment, true),
    },
  };
}
