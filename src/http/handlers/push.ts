import type { IncomingMessage, ServerResponse } from "node:http";
import { extractBearerToken } from "../middleware/auth.js";
import { readJsonBody } from "../middleware/body.js";
import { getPushRuntime, PUSH_ORIGIN } from "../../push/push-runtime.js";

/** 推送 grant 只向固定中继核验，调用方不能指定转发地址。 */
export async function handlePush(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const reply = (status: number, body: unknown): boolean => {
    res.statusCode = status; res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body)); return true;
  };
  if (!extractBearerToken(req)) return reply(401, {error:"Unauthorized"});
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "GET" && url.pathname.endsWith("/registration")) return reply(200, {capability:"push-v1"});
  if (req.method !== "POST" && req.method !== "DELETE") return reply(405, {error:"Method Not Allowed"});
  const body = await readJsonBody(req);
  if (!body || typeof body.deviceId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.deviceId)) return reply(400, {error:"invalid_device"});
  const deviceId = body.deviceId.toUpperCase();
  if (url.pathname.endsWith("/handled") && req.method === "POST") {
    if (typeof body.notificationId !== "string" || !/^session\.[a-f0-9]{64}$/.test(body.notificationId)) return reply(400, {error:"invalid_identity"});
    getPushRuntime().handled(deviceId, body.notificationId);
    return reply(200, {ok:true});
  }
  if (req.method === "DELETE") { getPushRuntime().remove(deviceId); return reply(200, {ok:true}); }
  if (typeof body.pushGrant !== "string" || body.pushGrant.length > 256) return reply(400, {error:"invalid_grant"});
  try {
    const response = await fetch(PUSH_ORIGIN + "/v1/push/binding", {
      method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({pushGrant:body.pushGrant}), signal:AbortSignal.timeout(10000),
    });
    if (!response.ok) return reply(response.status === 403 ? 403 : 503, {error:"binding_unavailable"});
    const binding = await response.json() as Record<string,unknown>;
    if (binding.deviceId !== deviceId || binding.profileId !== body.profileId || binding.registrationId !== body.registrationId
      || typeof body.profileId !== "string" || typeof body.registrationId !== "string") return reply(403, {error:"binding_mismatch"});
    getPushRuntime().register({deviceId, profileId:body.profileId, registrationId:body.registrationId, pushGrant:body.pushGrant});
    return reply(200, {ok:true});
  } catch { return reply(503, {error:"binding_unavailable"}); }
}
