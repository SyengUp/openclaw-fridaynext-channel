/**
 * Internal attest verifier for the standalone tunnel-edge process.
 *
 * The edge has no session store, so it forwards the caller's attest token here for the real
 * `verifySession` check. This is a localhost-only, bearer-free oracle and must NEVER be
 * reachable through the public tunnel: the edge denylists `/friday-next/edge` and this handler
 * independently refuses any request already stamped `x-fridaynext-public: 1`.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { verifySession } from "../../attest/attest-store.js";
import { isPublicRequest } from "../middleware/public-surface.js";

function loopbackOnly(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress ?? "";
  return remote === "127.0.0.1" || remote === "::1";
}

function reject(res: ServerResponse, status: number, body: Record<string, string>): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

export function handleEdgeAttestVerify(req: IncomingMessage, res: ServerResponse): boolean {
  if (!loopbackOnly(req)) {
    reject(res, 403, { error: "loopback_required" });
    return true;
  }
  if (isPublicRequest(req)) {
    reject(res, 403, { error: "not_available_publicly" });
    return true;
  }
  const header = req.headers["x-fridaynext-attest"];
  const token = Array.isArray(header) ? header[0] : header;
  if (!token) {
    reject(res, 401, { error: "attest_token_required" });
    return true;
  }
  const ok = verifySession(token, Date.now());
  if (!ok) {
    reject(res, 401, { error: "invalid_attest_session" });
    return true;
  }
  res.statusCode = 200;
  res.end();
  return true;
}
