import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fridayNextChannelPlugin } from "./channel.js";
import { sseEmitter } from "./sse/emitter.js";
import {
  registerFridaySessionDeviceMapping,
  setLastDeviceStateFileForTest,
} from "./friday-session.js";

/**
 * Isolated cron / background pushes reach the core outbound target resolver with no `to`.
 * friday-next returns null from resolveOutboundSessionRoute (to avoid phantom delivery-mirror
 * sessions), so the session bucket never stores a routable friday-next target. Without
 * config.resolveDefaultTo the core aborts with "Delivering to Friday Next requires target"
 * before sendText's own device fallback runs. resolveDefaultTo surfaces that same fallback
 * (sole connected device, else last seen device — DISK-persisted, because the in-memory value
 * dies on gateway restart and cron fires precisely when the app is backgrounded/offline).
 */

class MockRes extends EventEmitter {
  write(): boolean {
    return true;
  }
  end(): void {
    // no-op
  }
}

const config = fridayNextChannelPlugin.config as {
  resolveDefaultTo?: () => string | undefined;
};

describe("friday-next config.resolveDefaultTo (implicit cron delivery target)", () => {
  let stateDir = "";

  beforeEach(() => {
    sseEmitter.resetForTest();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-last-device-"));
    setLastDeviceStateFileForTest(path.join(stateDir, "last-device.json"));
  });

  afterEach(() => {
    setLastDeviceStateFileForTest(null);
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("exposes resolveDefaultTo so the core can resolve an implicit target", () => {
    expect(typeof config.resolveDefaultTo).toBe("function");
  });

  it("returns the sole connected device (uppercased) when exactly one is online", () => {
    sseEmitter.addConnection("dev-sole-1", new MockRes() as never);
    expect(config.resolveDefaultTo?.()).toBe("DEV-SOLE-1");
  });

  it("falls back to the last registered device when none is connected", () => {
    registerFridaySessionDeviceMapping("agent:operator:friday-next:direct:abc", "dev-last-post-9");
    expect(config.resolveDefaultTo?.()).toBe("DEV-LAST-POST-9");
  });

  it("prefers the sole connected device over a stale last-registered device", () => {
    registerFridaySessionDeviceMapping(
      "agent:operator:friday-next:direct:stale",
      "dev-stale-registered",
    );
    sseEmitter.addConnection("dev-online-now", new MockRes() as never);
    expect(config.resolveDefaultTo?.()).toBe("DEV-ONLINE-NOW");
  });

  it("persists the last seen device to disk when registered", () => {
    registerFridaySessionDeviceMapping("agent:operator:friday-next:direct:p1", "dev-persisted-1");
    const raw = JSON.parse(fs.readFileSync(path.join(stateDir, "last-device.json"), "utf8")) as {
      deviceId: string;
    };
    expect(raw.deviceId).toBe("DEV-PERSISTED-1");
  });

  it("survives a gateway restart: cold process + app offline resolves from the disk state", () => {
    // Warm process learns the device, persisting it.
    registerFridaySessionDeviceMapping("agent:operator:friday-next:direct:r1", "dev-restart-1");
    const stateFile = path.join(stateDir, "last-device.json");
    expect(fs.existsSync(stateFile)).toBe(true);

    // Simulate restart: wipe in-memory state, keep the disk file, no SSE connection.
    setLastDeviceStateFileForTest(stateFile);
    expect(config.resolveDefaultTo?.()).toBe("DEV-RESTART-1");
  });

  it("returns undefined when nothing is known (no connection, no memory, no disk state)", () => {
    expect(config.resolveDefaultTo?.()).toBeUndefined();
  });

  it("recovers after an early miss: a cold read before the state file exists must not poison later reads", () => {
    // Regression: gateway restarts, ControlUI cron previews call resolveDefaultTo BEFORE the app
    // has reconnected — miss. Once the app connects (file written), the next read must succeed.
    expect(config.resolveDefaultTo?.()).toBeUndefined();
    fs.writeFileSync(
      path.join(stateDir, "last-device.json"),
      JSON.stringify({ deviceId: "DEV-LATE-ARRIVAL", updatedAt: 1 }),
    );
    expect(config.resolveDefaultTo?.()).toBe("DEV-LATE-ARRIVAL");
  });
});
