#!/usr/bin/env node
/**
 * Live gateway: POST /friday-next/messages + read SSE until deliver or timeout.
 * Token: FRIDAY_TOKEN or ~/.openclaw/openclaw.json gateway.auth.token
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
function loadConfig() {
  if (!fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    return {};
  }
}
function resolveBaseUrl(cfg) {
  if (process.env.OPENCLAW_BASE_URL) return process.env.OPENCLAW_BASE_URL;
  const port = Number(cfg?.gateway?.port) || 18789;
  return `http://127.0.0.1:${port}`;
}
function loadToken(cfg) {
  if (process.env.FRIDAY_TOKEN) return process.env.FRIDAY_TOKEN;
  return cfg?.gateway?.auth?.token || "";
}

const TIMEOUT_MS = Number(process.env.FRIDAY_MSG_TEST_TIMEOUT_MS) || 120_000;
const TEXT = process.env.FRIDAY_MSG_TEST_TEXT || "Reply with exactly one word: pong";

const cfg = loadConfig();
const base = resolveBaseUrl(cfg);
const token = loadToken(cfg);
if (!token) {
  console.error("[fail] missing token (FRIDAY_TOKEN or ~/.openclaw/openclaw.json)");
  process.exit(1);
}

const auth = { Authorization: `Bearer ${token}` };
const deviceId = `MSG-TEST-${Date.now()}`;
const sessionKey = `msg-live-${Date.now()}`;

function parseSseBlocks(raw) {
  const blocks = raw.split("\n\n").filter((b) => b.trim() && !b.trim().startsWith(":"));
  const out = [];
  for (const b of blocks) {
    const frame = { lines: b.trim().split("\n") };
    let id;
    let event;
    let data;
    for (const line of frame.lines) {
      if (line.startsWith("id:")) id = line.slice(3).trim();
      else if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data = line.slice(5).trim();
    }
    out.push({ id, event, data });
  }
  return out;
}

const ac = new AbortController();
let buf = "";
const seen = { connected: false, agent: 0, deliver: 0, outbound: 0 };

const ssePromise = (async () => {
  const res = await fetch(`${base}/friday-next/events?deviceId=${encodeURIComponent(deviceId)}`, {
    headers: { ...auth },
    signal: ac.signal,
  });
  if (res.status !== 200) {
    const t = await res.text();
    throw new Error(`SSE ${res.status}: ${t.slice(0, 200)}`);
  }
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("text/event-stream")) {
    const t = await res.text();
    if (t.includes("<!doctype html>")) {
      throw new Error(
        "Got HTML — friday-next routes not registered (check channels.friday-next.transport)",
      );
    }
    throw new Error(`Expected event-stream, got ${ct}`);
  }
  const reader = res.body?.getReader();
  if (!reader) throw new Error("No SSE body");
  const dec = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const frames = parseSseBlocks(buf);
    if (frames.length) {
      const last = buf.lastIndexOf("\n\n");
      if (last >= 0) buf = buf.slice(last + 2);
    }
    for (const f of frames) {
      if (f.event === "connected") seen.connected = true;
      if (f.event === "agent") seen.agent += 1;
      if (f.event === "deliver") seen.deliver += 1;
      if (f.event === "outbound") seen.outbound += 1;
      if (f.event === "deliver") {
        console.log("[ok] received event: deliver");
        try {
          console.log("[data]", f.data?.slice(0, 500));
        } catch {
          /* ignore */
        }
        return "deliver";
      }
    }
  }
  return null;
})();

const deadline = setTimeout(() => {
  ac.abort();
}, TIMEOUT_MS);
deadline.unref?.();

await new Promise((r) => setTimeout(r, 300));

console.log("[info] POST /friday-next/messages …");
const post = await fetch(`${base}/friday-next/messages`, {
  method: "POST",
  headers: { ...auth, "Content-Type": "application/json" },
  body: JSON.stringify({ deviceId, text: TEXT, sessionKey }),
});
const postText = await post.text();
if (post.status !== 202) {
  console.error("[fail] messages expected 202, got", post.status, postText.slice(0, 300));
  ac.abort();
  process.exit(1);
}
let ack;
try {
  ack = JSON.parse(postText);
} catch {
  ack = postText;
}
console.log("[ok] 202 ack", ack);

const result = await ssePromise.catch((e) => {
  console.error("[fail] SSE:", e.message);
  return null;
});
clearTimeout(deadline);
ac.abort();

if (result === "deliver") {
  console.log("[ok] roundtrip: seen", seen);
  process.exit(0);
}

console.error("[fail] no deliver within", TIMEOUT_MS, "ms; seen", seen);
process.exit(1);
