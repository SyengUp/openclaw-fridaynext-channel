import type { IncomingMessage, ServerResponse } from "node:http";
import { extractBearerToken } from "../middleware/auth.js";
import { getPairingInfo } from "../../public-access/frpc-manager.js";

/**
 * GET /friday-next/public-access/pairing
 *
 * Returns the public-access pairing superset — `{v, lanUrl, publicUrl,
 * fingerprint, token, subdomain}` — the same shape the app's QR parser decodes
 * (`OnboardingQRPayload`). The owner's app fetches this over its already-paired
 * (LAN) connection and renders a QR to share; a guest scans it and connects over
 * the relay, pinning the self-signed leaf `fingerprint`.
 *
 * Bearer-authed: the response carries the gateway token, so only a caller that
 * already holds it (the owner) can fetch. 503 when public access is disabled or
 * the tunnel has not come up yet (`getPairingInfo()` still null).
 */
export async function handlePublicAccessPairing(
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

  const pairing = getPairingInfo();
  if (!pairing) {
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        error: "public access not available",
        detail:
          "channels.friday-next.publicAccess.enabled is false, or the tunnel has not come up yet",
      }),
    );
    return true;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(pairing));
  return true;
}
