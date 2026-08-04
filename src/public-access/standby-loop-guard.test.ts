import { describe, expect, it } from "vitest";
import { StandbyLoopGuard } from "./standby-loop-guard.js";

// standby 是 25 秒的 held HTTP 长轮询。此前 stop 直接把「有没有在跑」的布尔位清掉，
// 而那次 fetch 还挂在飞；紧接着的 start 于是又开一条，旧的醒来看到 stopped 已被 start
// 重置成 false，也接着排下一拍——stop→start 每来一次就多叠一条轮询（审查 P2-17）。
describe("StandbyLoopGuard", () => {
  it("只允许一条活循环", () => {
    const guard = new StandbyLoopGuard();
    const first = guard.begin();
    expect(first).not.toBeNull();
    expect(guard.begin()).toBeNull(); // 已有活循环 → 调用方放弃，不重复轮询
    expect(guard.isRunning).toBe(true);
  });

  it("stop→start：在途旧循环被作废，新循环独占", () => {
    const guard = new StandbyLoopGuard();
    const inFlight = guard.begin()!; // 假设它正挂在 25s 长轮询上

    guard.invalidate(); // stopPublicAccess()
    const fresh = guard.begin()!; // 紧接着的 startPublicAccess()

    expect(fresh).not.toBe(inFlight);
    expect(guard.isCurrent(fresh)).toBe(true);
    expect(guard.isCurrent(inFlight)).toBe(false); // 旧循环醒来即退场
  });

  it("迟到的旧循环销不掉新循环", () => {
    const guard = new StandbyLoopGuard();
    const stale = guard.begin()!;
    guard.invalidate();
    const fresh = guard.begin()!;

    guard.end(stale); // 旧 fetch 终于回来，走 finally 收尾
    expect(guard.isRunning).toBe(true);
    expect(guard.isCurrent(fresh)).toBe(true);
  });

  it("循环正常结束后可以再开", () => {
    const guard = new StandbyLoopGuard();
    const first = guard.begin()!;
    guard.end(first);
    expect(guard.isRunning).toBe(false);
    const second = guard.begin();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });

  it("反复 stop→start 也只留一条活循环", () => {
    const guard = new StandbyLoopGuard();
    const generations: number[] = [];
    for (let i = 0; i < 5; i++) {
      const g = guard.begin();
      if (g !== null) generations.push(g);
      guard.invalidate(); // 每轮都在旧循环仍在途时打断
    }
    const live = guard.begin()!;
    // 之前每一代都已作废，只有最后这条是当下的
    for (const g of generations) expect(guard.isCurrent(g)).toBe(false);
    expect(guard.isCurrent(live)).toBe(true);
    expect(guard.isRunning).toBe(true);
  });
});
