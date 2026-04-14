#!/usr/bin/env node
/**
 * Simulates the Friday iOS app: SSE + POST /friday/messages.
 * Usage:
 *   node scripts/simulate-friday-subagent-test.mjs "用subagent调研一下游戏2077"
 *
 * Token: FRIDAY_TOKEN env, or ~/.openclaw/openclaw.json gateway.auth.token
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const HOME = process.env.HOME ?? "";
const cfgPath = path.join(HOME, ".openclaw", "openclaw.json");

function loadToken() {
  if (process.env.FRIDAY_TOKEN) return process.env.FRIDAY_TOKEN;
  try {
    const raw = fs.readFileSync(cfgPath, "utf8");
    const j = JSON.parse(raw);
    return j?.gateway?.auth?.token ?? "";
  } catch {
    return "";
  }
}

const token = loadToken();
const PORT = Number(process.env.FRIDAY_PORT || 18789);
const HOST = process.env.FRIDAY_HOST || "127.0.0.1";
const deviceId = process.env.FRIDAY_DEVICE || "SCRIPT-2077-TEST";
const sessionKey = process.env.FRIDAY_SESSION || `friday-${deviceId}`;
const prompt =
  process.argv.slice(2).join(" ").trim() || "用subagent调研一下游戏2077";
const waitMs = Number(process.env.FRIDAY_WAIT_MS || 240000);

if (!token) {
  console.error("No token: set FRIDAY_TOKEN or ensure ~/.openclaw/openclaw.json exists");
  process.exit(1);
}

let posted = false;
let lineCount = 0;

function postMessage() {
  if (posted) return;
  posted = true;
  const body = JSON.stringify({ deviceId, sessionKey, text: prompt });
  const req = http.request(
    {
      hostname: HOST,
      port: PORT,
      path: "/friday/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body, "utf8"),
        Authorization: `Bearer ${token}`,
      },
    },
    (res) => {
      let d = "";
      res.on("data", (c) => {
        d += c;
      });
      res.on("end", () => {
        console.error(`[POST /friday/messages] ${res.statusCode} ${d}`);
      });
    },
  );
  req.on("error", (e) => console.error("[POST error]", e.message));
  req.write(body);
  req.end();
}

const sseReq = http.request(
  {
    hostname: HOST,
    port: PORT,
    path: `/friday/events?deviceId=${encodeURIComponent(deviceId)}`,
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "text/event-stream,*/*",
    },
  },
  (res) => {
    console.error(`[SSE] HTTP ${res.statusCode} ${res.headers["content-type"] || ""}`);
    if (res.statusCode !== 200) {
      res.resume();
      process.exit(1);
    }
    let buf = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith(": keepalive")) continue;
        const t = line.trim();
        if (!t) continue;
        try {
          const j = JSON.parse(t);
          lineCount += 1;
          console.log(t);
          if (!posted && j.type === "agent" && j.event === "connected") {
            setTimeout(() => postMessage(), 300);
          }
        } catch {
          console.error("[non-JSON line]", t);
        }
      }
    });
    res.on("end", () => console.error("[SSE closed]"));
    res.on("error", (e) => console.error("[SSE res error]", e.message));
  },
);

sseReq.on("error", (e) => {
  console.error("[SSE request error]", e.message);
  process.exit(1);
});
sseReq.end();

const t = setTimeout(() => {
  console.error(`\n[TIMEOUT ${waitMs}ms] lines=${lineCount} posted=${posted}`);
  process.exit(0);
}, waitMs);

t.unref?.();
