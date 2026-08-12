import { describe, it, expect } from "vitest";
import { TunnelWatchdogPolicy } from "./tunnel-watchdog-policy.js";

// 看门狗升级阶梯的策略层单测:确诊「闸门政策性拒绝(或任何长期不可达)」后,
// 重启节奏指数退避、重分配冷却、健康/空闲即复位——不再无限高频重启 frpc。
// (katelier 案例:grant 到期后网关无限循环重启 frpc,每轮都重新发起 NewProxy)

function makePolicy(now = () => 0) {
  return new TunnelWatchdogPolicy(now);
}

describe("TunnelWatchdogPolicy（重启退避阶梯）", () => {
  it("首个失败窗口立即重启(短暂故障自愈保持敏捷)", () => {
    const p = makePolicy(() => 0);
    expect(p.noteRestartWindowFired(false).kind).toBe("restart");
  });

  it("退避期内后续窗口跳过,退避期满再重启", () => {
    let t = 0;
    const p = makePolicy(() => t);
    const first = p.noteRestartWindowFired(false);
    expect(first.kind).toBe("restart");
    // 第一个窗口消费 180s 退避(约在 t+180000 才允许下一次)
    t = 60_000;
    expect(p.noteRestartWindowFired(false).kind).toBe("skip");
    t = 180_000;
    expect(p.noteRestartWindowFired(false).kind).toBe("restart");
  });

  it("退避间隔指数增长并封顶 30 分钟", () => {
    // 用显式子域(永不重分配)隔离出纯退避阶梯;窗口按 180s 探活节奏推进
    let t = 0;
    const p = makePolicy(() => t);
    const gaps: number[] = [];
    for (let i = 0; i < 26; i += 1) {
      const a = p.noteRestartWindowFired(true);
      if (a.kind === "restart") gaps.push(a.nextRestartAtMs - t);
      t += 180_000;
    }
    expect(gaps.map((g) => g / 1000)).toEqual([180, 360, 720, 1440, 1800, 1800]);
    expect(Math.max(...gaps)).toBe(1_800_000);
  });

  it("≥5 个无恢复窗口且非显式子域 → 重分配(沿用注册表重建自愈)", () => {
    // 每次窗口大步前跳,保证每个窗口都越过退避门限、真实重启
    let t = 0;
    const p = makePolicy(() => t);
    for (let i = 0; i < 4; i += 1) {
      expect(p.noteRestartWindowFired(false).kind).toBe("restart");
      t += 10_000_000;
    }
    expect(p.noteRestartWindowFired(false).kind).toBe("realloc");
  });

  it("重分配有 30 分钟冷却,期间不再反复重分配", () => {
    let t = 0;
    const p = makePolicy(() => t);
    // 快进到第 5 个窗口触发一次重分配
    let action = p.noteRestartWindowFired(false);
    while (action.kind !== "realloc") {
      t += 180_000;
      action = p.noteRestartWindowFired(false);
    }
    // 冷却期内再来窗口:不重分配(退避重启或跳过均可)
    for (let i = 0; i < 5; i += 1) {
      t += 180_000;
      const a = p.noteRestartWindowFired(false);
      expect(a.kind).not.toBe("realloc");
    }
    // 冷却期过后允许再次重分配
    t += 30 * 60_000;
    let sawRealloc = false;
    for (let i = 0; i < 10 && !sawRealloc; i += 1) {
      t += 180_000;
      if (p.noteRestartWindowFired(false).kind === "realloc") sawRealloc = true;
    }
    expect(sawRealloc).toBe(true);
  });

  it("显式子域网关永不重分配(操作者钉死的子域,重分配无意义)", () => {
    let t = 0;
    const p = makePolicy(() => t);
    for (let i = 0; i < 12; i += 1) {
      t += 1_000_000;
      const a = p.noteRestartWindowFired(true);
      expect(a.kind).not.toBe("realloc");
    }
  });

  it("健康探测通过后阶梯复位:下次失败窗口立即重启", () => {
    let t = 0;
    const p = makePolicy(() => t);
    // 打满退避到封顶
    for (let i = 0; i < 8; i += 1) {
      p.noteRestartWindowFired(false);
      t += 1_800_000;
    }
    p.noteHealthy();
    const first = p.noteRestartWindowFired(false);
    expect(first.kind).toBe("restart");
    expect(first.nextRestartAtMs - t).toBe(180_000); // 复位后从基础间隔重新起步
  });

  it("空闲(控制面下发空集)同样复位阶梯", () => {
    let t = 0;
    const p = makePolicy(() => t);
    for (let i = 0; i < 8; i += 1) {
      p.noteRestartWindowFired(false);
      t += 1_800_000;
    }
    p.noteIdle();
    expect(p.noteRestartWindowFired(false).kind).toBe("restart");
  });
});
