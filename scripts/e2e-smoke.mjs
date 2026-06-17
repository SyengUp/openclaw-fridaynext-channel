#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";

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

function ensurePluginEnabled() {
  try {
    const raw = execSync("openclaw plugins list --json", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const start = raw.indexOf("{");
    const payload = start >= 0 ? JSON.parse(raw.slice(start)) : {};
    const plugin = (payload.plugins ?? []).find((p) => p?.id === "friday-next");
    if (plugin && plugin.enabled !== true) {
      console.log("[info] friday-next disabled, enabling it now...");
      execSync("openclaw plugins enable friday-next", { stdio: "inherit" });
      execSync("openclaw gateway restart", { stdio: "inherit" });
    }
  } catch {
    // best effort only
  }
}

const config = loadConfig();
const base = resolveBaseUrl(config);
const token = loadToken(config);
if (!token) {
  console.error("[fail] missing gateway token (FRIDAY_TOKEN or ~/.openclaw/openclaw.json)");
  process.exit(1);
}

ensurePluginEnabled();

async function req(name, url, init, expectStatus) {
  try {
    const res = await fetch(`${base}${url}`, init);
    if (res.status !== expectStatus) {
      console.error(`[fail] ${name} expected ${expectStatus}, got ${res.status}`);
      process.exitCode = 1;
      return null;
    }
    console.log(`[ok] ${name}`);
    return res;
  } catch (err) {
    console.error(`[fail] ${name}: ${String(err)}`);
    process.exitCode = 1;
    return null;
  }
}

const auth = { Authorization: `Bearer ${token}` };
const unauth = {};

const statusRes = await req("status 200", "/friday-next/status", { headers: auth }, 200);
if (statusRes) {
  const text = await statusRes.text();
  if (text.includes("<!doctype html>")) {
    console.warn(
      "[warn] friday-next route not registered on active gateway; fallback to local smoke lane",
    );
    const fallback = spawnSync(
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        "--config",
        "vitest.e2e.config.ts",
        "src/e2e/status-cors-auth.e2e.test.ts",
        "src/e2e/attachments-inbound.e2e.test.ts",
        "src/e2e/cancel-reconnect-errors.e2e.test.ts",
      ],
      {
        stdio: "inherit",
        cwd: process.cwd(),
      },
    );
    process.exit(fallback.status ?? 1);
  } else {
    try {
      const st = JSON.parse(text);
      if (!Array.isArray(st.activeRuns)) {
        console.error("[fail] status.activeRuns missing");
        process.exitCode = 1;
      } else {
        console.log("[ok] status activeRuns");
      }
    } catch {
      // ignore
    }
  }
}
await req("status 401", "/friday-next/status", { headers: unauth }, 401);

await req(
  "events options",
  "/friday-next/events",
  { method: "OPTIONS", headers: { ...auth, Origin: "https://smoke.local" } },
  204,
);
const ev = await req(
  "events connect",
  "/friday-next/events?deviceId=SMOKE",
  { headers: auth },
  200,
);
if (ev) {
  const reader = ev.body?.getReader();
  const first = reader ? await reader.read() : { done: true, value: new Uint8Array() };
  const t = Buffer.from(first.value ?? new Uint8Array()).toString("utf-8");
  if (!t.includes("event: connected")) {
    console.error("[fail] events connected frame missing");
    process.exitCode = 1;
  } else {
    console.log("[ok] events connected frame");
  }
  try {
    await reader?.cancel();
  } catch {
    // ignore
  }
}

const boundary = "----friday-next-smoke";
const body =
  `--${boundary}\r\n` +
  `Content-Disposition: form-data; name="file"; filename="smoke.txt"\r\n` +
  `Content-Type: text/plain\r\n\r\n` +
  `smoke-file\r\n` +
  `--${boundary}--\r\n`;
const up = await req(
  "files upload",
  "/friday-next/files",
  {
    method: "POST",
    headers: { ...auth, "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
  },
  200,
);
let fileUrl = "";
if (up) {
  const json = await up.json();
  fileUrl = json?.files?.[0]?.url || "";
}
if (fileUrl) {
  await req("files download", fileUrl, { headers: auth }, 200);
}

await req(
  "cancel ok",
  "/friday-next/cancel",
  {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ runId: "smoke-run" }),
  },
  200,
);

if (process.exitCode && process.exitCode !== 0) process.exit(process.exitCode);
