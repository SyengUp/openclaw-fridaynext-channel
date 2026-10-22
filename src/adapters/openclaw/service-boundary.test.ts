import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("公共服务接入边界", () => {
  it("胶囊与名称兼容导出只调用 Kit 处理器，不保留第二份 HTTP 规则", () => {
    for (const [file, factory] of [["prompt-capsules", "createPromptCapsuleHandler"], ["server-name", "createServerNameHandler"]]) {
      const source = fs.readFileSync(new URL(`../../http/handlers/${file}.ts`, import.meta.url), "utf8");
      expect(source).toContain(factory);
      expect(source).not.toMatch(/readJsonBody|JSON\.stringify|statusCode\s*=/);
    }
  });
  it("消息与恢复兼容门面不再拥有宿主执行或调度状态机", () => {
    for (const file of [
      "../../http/handlers/messages.ts",
      "../../runtime-v3/runtime-recovery.ts",
      "./message-adapter.ts",
    ]) {
      const source = fs.readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source).not.toMatch(
        /PassThrough|runFridayDispatch|waitForDispatchSlot|\.claimRun\(|\.claimRunnable\(/,
      );
    }
    const execution = fs.readFileSync(new URL("./execution.ts", import.meta.url), "utf8");
    expect(execution).not.toMatch(
      /getRuntimeV3Store|acceptCommand|appendRunEvent|claimRun|waitForDispatchSlot/,
    );
    const controls = fs.readFileSync(new URL("./control-adapter.ts", import.meta.url), "utf8");
    expect(controls).not.toContain("PassThrough");
  });
});
