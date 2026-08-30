import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claimPublicAccessOwnership,
  currentProcessOwnsPublicAccess,
  releasePublicAccessOwnership,
} from "./frpc-manager.js";

// Cross-process ownership: the gateway daemon and every `openclaw agent` CLI run on the same
// host used to each start public access (duplicate frpc at the relay + a permanent EADDRINUSE
// fight over corePort+1). The pid-file protocol pinned here is what keeps it singleton.

let dir: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fn-pa-owner-"));
});

afterEach(() => {
  for (const c of children.splice(0)) {
    try {
      c.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

function writeOwner(pid: number, role: string): void {
  writeFileSync(
    join(dir, "public-access-owner.json"),
    JSON.stringify({ pid, role, claimedAt: "2026-08-30T00:00:00Z" }),
  );
}

function ownerFilePid(): number | null {
  try {
    return (JSON.parse(readFileSync(join(dir, "public-access-owner.json"), "utf8")) as { pid?: number })
      .pid ?? null;
  } catch {
    return null;
  }
}

/** A pid that is definitely alive and not this test process. */
function liveOtherPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"]);
    children.push(child);
    child.on("spawn", () => resolve(child.pid as number));
    child.on("error", reject);
  });
}

/** A pid that is guaranteed dead by the time it is returned. */
function deadPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    child.on("error", reject);
    child.on("exit", () => resolve(child.pid as number));
  });
}

describe("public-access ownership", () => {
  it("claims an absent owner file", () => {
    expect(claimPublicAccessOwnership(dir, "ambient")).toBe(true);
    expect(ownerFilePid()).toBe(process.pid);
    expect(currentProcessOwnsPublicAccess(dir)).toBe(true);
  });

  it("ambient yields to a live owner", async () => {
    writeOwner(await liveOtherPid(), "service");
    expect(claimPublicAccessOwnership(dir, "ambient")).toBe(false);
    expect(ownerFilePid()).not.toBe(process.pid); // untouched
  });

  it("ambient takes over a dead owner", async () => {
    writeOwner(await deadPid(), "ambient");
    expect(claimPublicAccessOwnership(dir, "ambient")).toBe(true);
    expect(ownerFilePid()).toBe(process.pid);
  });

  it("service stomps even a live ambient owner (CLI grabbed it while the daemon was down)", async () => {
    writeOwner(await liveOtherPid(), "ambient");
    expect(claimPublicAccessOwnership(dir, "service")).toBe(true);
    expect(ownerFilePid()).toBe(process.pid);
  });

  it("re-entrant claim by the recorded owner is a no-op success", async () => {
    writeOwner(process.pid, "ambient");
    expect(claimPublicAccessOwnership(dir, "ambient")).toBe(true);
    expect(ownerFilePid()).toBe(process.pid);
  });

  it("release removes only our own record — a successor's file survives", async () => {
    writeOwner(await liveOtherPid(), "service");
    releasePublicAccessOwnership(dir);
    expect(existsSync(join(dir, "public-access-owner.json"))).toBe(true);

    writeOwner(process.pid, "service");
    releasePublicAccessOwnership(dir);
    expect(existsSync(join(dir, "public-access-owner.json"))).toBe(false);
    expect(currentProcessOwnsPublicAccess(dir)).toBe(false);
  });

  it("a corrupt owner file is treated as absent and reclaimed", () => {
    writeFileSync(join(dir, "public-access-owner.json"), "{not json");
    expect(claimPublicAccessOwnership(dir, "ambient")).toBe(true);
    expect(ownerFilePid()).toBe(process.pid);
  });
});
