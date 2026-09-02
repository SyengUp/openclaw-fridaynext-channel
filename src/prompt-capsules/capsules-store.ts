import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveFridayNextConfig } from "../config.js";
import { getHostOpenClawConfigSnapshot } from "../host-config.js";
import { getFridayNextRuntime } from "../runtime.js";

/**
 * Gateway-side source of truth for prompt capsules ("提示词胶囊").
 *
 * The app used to seed starter capsules locally and push them up. That meant a new
 * app pairing an existing gateway would mint fresh ids and merge them back in — including
 * when the user had already deleted the starters. Defaults now live here: a brand-new
 * store file is planted with the starter; an existing file (even `capsules: []`) is
 * left alone, so a deletion survives a reinstall / new-app pairing.
 *
 * Scope is deliberately **global** (one list per gateway, shared by every agent) —
 * that matches the app, where `PromptCapsuleStore` is a single app-wide singleton.
 */

export type PromptCapsuleRecord = {
  id: string;
  name: string;
  iconSystemName: string;
  prompt: string;
  /** epoch ms */
  createdAt: number;
  sortOrder: number;
  /** epoch ms — last-writer-wins key for cross-device merge */
  updatedAt: number;
};

export type PromptCapsulesFile = {
  version: 1;
  /**
   * Stable identity of *this* capsule store, minted once on first write and never
   * changed. The app keys its sync bookkeeping on it, so the same gateway reached over
   * LAN IP and over the public relay domain is recognised as one data source — and a
   * genuinely different gateway is recognised as a new peer (union-only, never delete).
   */
  storeId: string;
  /** Bumped on every successful write; used for optimistic-concurrency (`baseRevision`). */
  revision: number;
  /** epoch ms */
  updatedAt: number;
  capsules: PromptCapsuleRecord[];
};

export const MAX_CAPSULES = 200;
export const MAX_NAME_LEN = 100;
export const MAX_ICON_LEN = 100;
export const MAX_PROMPT_LEN = 8000;

/**
 * Starter capsule planted the first time this gateway's store file is created.
 * Copy matches the app's original Chinese source strings (the plugin is not localized).
 * Ids are minted per gateway — they are not a shared well-known set.
 */
export const DEFAULT_SEED_CAPSULES: ReadonlyArray<
  Omit<PromptCapsuleRecord, "id" | "createdAt" | "updatedAt">
> = [
  {
    name: "长按胶囊来编辑/删除",
    iconSystemName: "hand.tap",
    prompt: '在这里输入你常用的提示词，如"用网页搜索"\n现在，你可以删除这个胶囊了',
    sortOrder: 0,
  },
];

function plantDefaultCapsules(now: number): PromptCapsuleRecord[] {
  return DEFAULT_SEED_CAPSULES.map((spec) => ({
    ...spec,
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
  }));
}

/** Test-only override for the store base directory. */
let testBaseDir: string | null = null;

export function setPromptCapsulesBaseDirForTest(dir: string | null): void {
  testBaseDir = dir;
}

export function resolvePromptCapsulesDir(): string {
  if (testBaseDir) return testBaseDir;
  try {
    const cfg = resolveFridayNextConfig(
      getHostOpenClawConfigSnapshot(getFridayNextRuntime().config),
    );
    return path.join(path.dirname(cfg.historyDir), "prompt-capsules");
  } catch {
    return path.join(os.homedir(), ".openclaw", "friday-next", "prompt-capsules");
  }
}

function capsulesFile(): string {
  return path.join(resolvePromptCapsulesDir(), "capsules.json");
}

function emptyFile(): PromptCapsulesFile {
  return { version: 1, storeId: randomUUID(), revision: 0, updatedAt: 0, capsules: [] };
}

/** First persist of a gateway that has never had a capsules file. */
function seededNewStore(): PromptCapsulesFile {
  const now = Date.now();
  return {
    version: 1,
    storeId: randomUUID(),
    revision: 0,
    updatedAt: now,
    capsules: plantDefaultCapsules(now),
  };
}

function coerceRecord(raw: unknown): PromptCapsuleRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id.trim() : "";
  if (!id) return null;
  const now = Date.now();
  const num = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  const createdAt = num(r.createdAt, now);
  return {
    id,
    name: typeof r.name === "string" ? r.name : "",
    iconSystemName: typeof r.iconSystemName === "string" ? r.iconSystemName : "",
    prompt: typeof r.prompt === "string" ? r.prompt : "",
    createdAt,
    sortOrder: num(r.sortOrder, 0),
    updatedAt: num(r.updatedAt, createdAt),
  };
}

/**
 * Read the persisted list. A missing/corrupt file degrades to an empty in-memory store
 * rather than throwing — and does **not** plant defaults (that would resurrect a list the
 * user cleared, or mint a throwaway `storeId`). Callers that hand a `storeId` to a client
 * must go through `readOrInitCapsules()`.
 */
export function readCapsules(): PromptCapsulesFile {
  const file = capsulesFile();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return emptyFile();
    const p = parsed as Record<string, unknown>;
    const capsules = Array.isArray(p.capsules)
      ? p.capsules.map(coerceRecord).filter((c): c is PromptCapsuleRecord => c !== null)
      : [];
    return {
      version: 1,
      storeId: typeof p.storeId === "string" && p.storeId ? p.storeId : randomUUID(),
      revision:
        typeof p.revision === "number" && Number.isFinite(p.revision) ? Math.trunc(p.revision) : 0,
      updatedAt: typeof p.updatedAt === "number" && Number.isFinite(p.updatedAt) ? p.updatedAt : 0,
      capsules,
    };
  } catch {
    return emptyFile();
  }
}

/**
 * Read, and persist immediately if the file didn't exist yet (so `storeId` is stable from
 * the first GET, and a brand-new gateway starts with the starter capsule).
 *
 * An existing file is never re-seeded — `capsules: []` means the user deleted them.
 */
export function readOrInitCapsules(): PromptCapsulesFile {
  const file = capsulesFile();
  if (fs.existsSync(file)) return readCapsules();
  const fresh = seededNewStore();
  persist(fresh);
  return fresh;
}

/** Replace the whole list, bumping the revision. Returns the persisted state. */
export function writeCapsules(
  capsules: PromptCapsuleRecord[],
  previous?: PromptCapsulesFile,
): PromptCapsulesFile {
  const prev = previous ?? readOrInitCapsules();
  const next: PromptCapsulesFile = {
    version: 1,
    storeId: prev.storeId,
    revision: prev.revision + 1,
    updatedAt: Date.now(),
    capsules,
  };
  persist(next);
  return next;
}

function persist(state: PromptCapsulesFile): void {
  const dir = resolvePromptCapsulesDir();
  fs.mkdirSync(dir, { recursive: true });
  // Atomic tmp+rename: a half-written capsules.json would lose the user's whole list.
  const target = path.join(dir, "capsules.json");
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, target);
}

export type CapsuleValidationResult =
  | { ok: true; capsules: PromptCapsuleRecord[] }
  | { ok: false; error: string };

/** Validate + normalize an inbound `capsules` array from a PUT body. */
export function validateCapsulesPayload(raw: unknown): CapsuleValidationResult {
  if (!Array.isArray(raw)) return { ok: false, error: "capsules must be an array" };
  if (raw.length > MAX_CAPSULES) {
    return { ok: false, error: `capsules must contain at most ${MAX_CAPSULES} items` };
  }
  const out: PromptCapsuleRecord[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const rec = coerceRecord(item);
    if (!rec) return { ok: false, error: "each capsule requires a non-empty string id" };
    if (seen.has(rec.id)) return { ok: false, error: `duplicate capsule id: ${rec.id}` };
    seen.add(rec.id);
    if (rec.name.length > MAX_NAME_LEN) {
      return { ok: false, error: `capsule name must be at most ${MAX_NAME_LEN} characters` };
    }
    if (rec.iconSystemName.length > MAX_ICON_LEN) {
      return {
        ok: false,
        error: `capsule iconSystemName must be at most ${MAX_ICON_LEN} characters`,
      };
    }
    if (rec.prompt.length > MAX_PROMPT_LEN) {
      return { ok: false, error: `capsule prompt must be at most ${MAX_PROMPT_LEN} characters` };
    }
    out.push(rec);
  }
  return { ok: true, capsules: out };
}
