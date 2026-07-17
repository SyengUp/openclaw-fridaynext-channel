import type { IncomingMessage } from "node:http";

/** True when the request arrived over the public relay tunnel. The public-surface
 * filter proxy — which EVERY public request must traverse — stamps this marker and
 * strips any client-supplied value, so it can't be forged from outside. LAN clients
 * hit core directly and never carry it. Consumed by the App Attest gate (public-only
 * enforcement) and the OSS side-channel divert (LAN devices keep the tunnel path). */
export function isPublicRequest(req: IncomingMessage): boolean {
  const v = req.headers["x-fridaynext-public"];
  return (Array.isArray(v) ? v[0] : v) === "1";
}
