import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveFridayNextConfig } from "../config.js";
import { getHostOpenClawConfigSnapshot } from "../host-config.js";
import { getFridayNextRuntime } from "../runtime.js";

/**
 * Gateway-side store for this server's display name ("服务器名称").
 *
 * The iOS app supports multiple gateway servers; each server row shows a
 * user-chosen name. Storing the name here (instead of only in the app) makes it
 * a property of the *gateway*: every paired device sees the same name, and a
 * delete+reinstall restores it. Mirrors the prompt-capsules store conventions
 * (atomic tmp+rename persist, corrupt file degrades to empty).
 */

export type ServerNameFile = {
  version: 1;
  name: string;
  /** epoch ms — last-writer-wins key across devices */
  updatedAt: number;
};

export const MAX_SERVER_NAME_LEN = 100;

/** Test-only override for the store base directory. */
let testBaseDir: string | null = null;

export function setServerNameBaseDirForTest(dir: string | null): void {
  testBaseDir = dir;
}

function resolveServerNameDir(): string {
  if (testBaseDir) return testBaseDir;
  try {
    const cfg = resolveFridayNextConfig(
      getHostOpenClawConfigSnapshot(getFridayNextRuntime().config),
    );
    return path.join(path.dirname(cfg.historyDir), "server-info");
  } catch {
    return path.join(os.homedir(), ".openclaw", "friday-next", "server-info");
  }
}

function serverNameFile(): string {
  return path.join(resolveServerNameDir(), "server-name.json");
}

function emptyFile(): ServerNameFile {
  return { version: 1, name: "", updatedAt: 0 };
}

/** Read the persisted name. Missing/corrupt file degrades to empty rather than throwing. */
export function readServerName(): ServerNameFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(serverNameFile(), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return emptyFile();
    const p = parsed as Record<string, unknown>;
    return {
      version: 1,
      name: typeof p.name === "string" ? p.name : "",
      updatedAt:
        typeof p.updatedAt === "number" && Number.isFinite(p.updatedAt) ? p.updatedAt : 0,
    };
  } catch {
    return emptyFile();
  }
}

/** Persist a (already validated) name. Returns the persisted state. */
export function writeServerName(name: string): ServerNameFile {
  const next: ServerNameFile = { version: 1, name, updatedAt: Date.now() };
  const dir = resolveServerNameDir();
  fs.mkdirSync(dir, { recursive: true });
  const target = serverNameFile();
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next));
  fs.renameSync(tmp, target);
  return next;
}

export type ServerNameValidationResult =
  | { ok: true; name: string }
  | { ok: false; error: string };

/** Validate + normalize an inbound `name` from a PUT body. Empty string clears the name. */
export function validateServerName(raw: unknown): ServerNameValidationResult {
  if (typeof raw !== "string") return { ok: false, error: "name must be a string" };
  const name = raw.trim();
  if (name.length > MAX_SERVER_NAME_LEN) {
    return { ok: false, error: `name must be at most ${MAX_SERVER_NAME_LEN} characters` };
  }
  return { ok: true, name };
}
