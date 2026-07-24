import { describe, expect, it } from "vitest";
import {
  pluginFrpcPidsFromProcessList,
  shouldClearRecordedFrpcPid,
} from "./frpc-manager.js";

describe("frpc pidfile lifecycle", () => {
  it("clears the pidfile when the recorded child exits", () => {
    expect(shouldClearRecordedFrpcPid(4599, 4599)).toBe(true);
  });

  it("keeps a replacement child's pidfile when a stale child exits later", () => {
    expect(shouldClearRecordedFrpcPid(5338, 4599)).toBe(false);
  });

  it("does not clear for an invalid or missing child pid", () => {
    expect(shouldClearRecordedFrpcPid(0, 4599)).toBe(false);
    expect(shouldClearRecordedFrpcPid(4599, undefined)).toBe(false);
  });

  it("finds every orphan using the exact plugin-private executable and config", () => {
    const executable = "/Users/test/.openclaw/friday-next/public-access/frpc";
    const config = "/Users/test/.openclaw/friday-next/public-access/frpc.toml";
    const processList = [
      ` 101 ${executable} -c ${config}`,
      ` 202 ${executable} -c ${config}`,
      ` 303 /opt/homebrew/bin/frpc -c /Users/test/personal/frpc.toml`,
      ` 404 ${executable} -c /Users/test/other/frpc.toml`,
    ].join("\n");

    expect(pluginFrpcPidsFromProcessList(processList, executable, config)).toEqual([101, 202]);
  });

  it("does not match an unrelated command that merely mentions the config path", () => {
    const executable = "/private/plugin/frpc";
    const config = "/private/plugin/frpc.toml";
    const processList = ` 505 sh -c echo ${executable} -c ${config}`;

    expect(pluginFrpcPidsFromProcessList(processList, executable, config)).toEqual([]);
  });
});
