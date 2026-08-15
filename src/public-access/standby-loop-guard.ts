/**
 * LEGACY — production no longer uses this module. The live standby loop now runs inside
 * `@syengup/tunnel-edge`'s TunnelRuntime, which ships its own identical `StandbyLoopGuard`.
 * This file remains only for its existing unit tests.
 *
 * 长轮询循环的生命周期闸门（代际号）。
 *
 * 为什么需要它：standby 是 25 秒的 held HTTP 长轮询。`stopPublicAccess()` 会把
 * `standbyPollRunning` 直接置回 false 并清掉定时器，但此刻可能还有一次 fetch 挂在飞——
 * 紧接着的 start 看到「没有活循环」于是又开一个；等那次旧 fetch 回来时 `stopped` 已被
 * start 重置成 false，于是**旧循环也接着排下一拍**。stop→start 每来一次就多叠一条轮询,
 * 全都对着同一个控制面打，而且谁也不知道自己是多余的。
 *
 * 解法与 iOS 侧 SSE 重拨用的是同一套：给循环发代际号。stop 让代际号 +1，在途的旧循环
 * 醒来一看代际不对就自行退场，绝不去动新循环的状态。
 *
 * 单独成文件是为了能脱离网络/子进程直接单测这套时序（frpc-manager 里全是模块级可变全局）。
 */
export class StandbyLoopGuard {
  private generation = 0;
  private activeGeneration: number | null = null;

  /** 当前有没有活着的循环。 */
  get isRunning(): boolean {
    return this.activeGeneration !== null;
  }

  /**
   * 申请开一条新循环。已有活循环时返回 `null`（调用方直接放弃，避免重复轮询）。
   * 返回的代际号要一路带着，后续每一步都用 `isCurrent` 自检。
   */
  begin(): number | null {
    if (this.activeGeneration !== null) return null;
    this.generation += 1;
    this.activeGeneration = this.generation;
    return this.generation;
  }

  /** 这条循环还是不是当下这条。 */
  isCurrent(loopGeneration: number): boolean {
    return this.activeGeneration === loopGeneration;
  }

  /** 循环自己走完（只有当下这条才能销号，迟到的旧循环销不掉新循环）。 */
  end(loopGeneration: number): void {
    if (this.activeGeneration === loopGeneration) this.activeGeneration = null;
  }

  /**
   * stop 路径：作废在途循环。之后 `begin()` 立刻可以开新的；
   * 旧循环即便还在 await 里挂着，醒来 `isCurrent` 也已为 false。
   */
  invalidate(): void {
    this.activeGeneration = null;
  }
}
