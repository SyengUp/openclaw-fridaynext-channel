/**
 * Shared OSS side-channel rewrite for OUTBOUND media (Phase E, E-wire ③).
 *
 * Two outbound-media surfaces exist and both must divert to OSS when public access is on:
 *   1. the deliver dispatcher (agent's final reply media) — `messages.ts`
 *   2. the `message` tool sends (`channel.ts` sendMedia + `channel-actions.ts` handleSend) — which
 *      broadcast `outbound` op:"media" events. This module is what those two call so the message-tool
 *      path stops leaking large attachments over the relay tunnel.
 *
 * When public access is off, or on any upload failure, callers keep their tunnel
 * `/friday-next/files/…` URL — the app downloads either kind through the same choke point
 * (`AttachmentDownloadManager`, which recognizes `fnoss:v1:…`).
 */
import { resolveFridayNextConfig } from "../config.js";
import { getHostOpenClawConfigSnapshot } from "../host-config.js";
import { getFridayNextRuntime } from "../runtime.js";
import { sseEmitter } from "../sse/emitter.js";
import { uploadOutboundMedia, encodeRefURI, type OSSTransferConfig } from "./oss-transfer.js";

/** OSS transfer config from the resolved plugin config, or null when public access is off. */
export function resolveOssOutboundConfig(): OSSTransferConfig | null {
  const cfg = resolveFridayNextConfig(getHostOpenClawConfigSnapshot(getFridayNextRuntime().config));
  if (!cfg.publicAccess.enabled) return null;
  return { controlPlaneUrl: cfg.publicAccess.controlPlaneUrl, authToken: cfg.authToken };
}

/**
 * Should outbound media for `deviceId` divert to OSS? Only when the device's LIVE SSE stream
 * arrived over the public relay (filter-proxy marker). LAN-connected devices keep the direct
 * tunnel (faster, no OSS traffic cost); offline devices too — a tunnel URL stays fetchable from
 * either origin once they reconnect.
 */
export function deviceUsesPublicSurface(deviceId: string | undefined): boolean {
  return !!deviceId && sseEmitter.isDeviceOnPublicSurface(deviceId);
}

/**
 * Encrypt + upload an outbound media buffer to OSS and return a `fnoss:v1:…` reference URI, or
 * `null` when the target device isn't on the public surface, public access is off, or the upload
 * failed (caller keeps its tunnel URL).
 */
export async function encryptOutboundBufferToFnoss(
  buffer: Buffer,
  opts: { name: string; mime: string },
  deviceId: string | undefined,
): Promise<string | null> {
  if (!deviceUsesPublicSurface(deviceId)) return null;
  const cfg = resolveOssOutboundConfig();
  if (!cfg) return null;
  const mime = opts.mime || "application/octet-stream";
  const ref = await uploadOutboundMedia(cfg, buffer, {
    name: opts.name || "attachment",
    mime,
    isImage: mime.startsWith("image/"),
  });
  return ref ? encodeRefURI(ref) : null;
}
