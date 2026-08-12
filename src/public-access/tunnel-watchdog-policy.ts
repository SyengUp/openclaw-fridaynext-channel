/**
 * 隧道看门狗的「升级阶梯」策略层——确诊隧道长期不可达(闸门政策性拒绝、注册表重建、
 * 长时间断网等)后,重启节奏指数退避、重分配冷却,健康/空闲即复位。
 *
 * 为什么需要它:看门狗原本对「永远不健康的隧道」无限重启 frpc——每次 kill 都由
 * keepalive 拉起、重新发起 NewProxy,每 3 分钟一轮,永不停止(katelier 案例里一台
 * grant 到期的用户网关在旧版本插件下以 33s 周期风暴重试,一个月被拒 3.3 万次)。
 * 重启对网络瞬时故障是正确自愈,对「控制面拒绝」毫无意义——本策略让重启节奏按
 * 窗口指数退避并封顶 30 分钟,把无意义的注册风暴压到每半小时一次;健康探测一旦
 * 通过(授权恢复、网络回来)或控制面下发空集(进入空闲),阶梯立即复位。
 *
 * 与 frpc-manager 的 TunnelHealthTracker 分工:tracker 数「连续失败几次」(strike
 * 窗口),本策略决定「这个窗口该干什么」。纯逻辑、无定时器,便于脱离网络单测。
 */

/** 首个失败窗口后的重启间隔:与 (探活间隔 × strike 数) 对齐,健康时保持原节奏。 */
export const RESTART_BACKOFF_BASE_MS = 180_000;
/** 退避封顶:再糟的情况每 30 分钟最多重试一次注册。 */
export const RESTART_BACKOFF_MAX_MS = 30 * 60_000;
/** 连续无恢复窗口达到该次数后,考虑「本地子域分配已不可信」的重分配自愈。 */
export const REALLOC_AFTER_CYCLES = 5;
/** 重分配冷却:重分配会丢弃本地记录并全量重走 bring-up,不该反复折腾。 */
export const REALLOC_COOLDOWN_MS = 30 * 60_000;

export type TunnelWatchdogAction =
  | { kind: "restart"; nextRestartAtMs: number }
  | { kind: "realloc" }
  | { kind: "skip" };

export class TunnelWatchdogPolicy {
  private restartCycles = 0;
  private backoffMs = 0;
  private nextRestartAt = 0;
  private lastReallocAt = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** 健康探测通过:一切复位,下个失败窗口立即重启(短暂故障自愈保持敏捷)。 */
  noteHealthy(): void {
    this.reset();
  }

  /** 控制面下发空集(网关当前无 entitled 账号):视为空闲,同样复位。 */
  noteIdle(): void {
    this.reset();
  }

  /**
   * 一个 strike 窗口刚触发(连续 N 次探活失败)。返回本窗口该做什么。
   * `hasExplicitSubdomain` = 操作者显式钉死了子域(重分配无意义)。
   */
  noteRestartWindowFired(hasExplicitSubdomain: boolean): TunnelWatchdogAction {
    this.restartCycles += 1;
    const nowMs = this.now();

    // 阶梯 1:多次重启仍无恢复 → 本地分配可能已不可信(注册表重建),丢弃并重走 bring-up。
    if (
      this.restartCycles >= REALLOC_AFTER_CYCLES &&
      !hasExplicitSubdomain &&
      nowMs - this.lastReallocAt >= REALLOC_COOLDOWN_MS
    ) {
      this.lastReallocAt = nowMs;
      this.backoffMs = 0;
      this.nextRestartAt = 0;
      this.restartCycles = 0;
      return { kind: "realloc" };
    }

    // 阶梯 2:退避——间隔按窗口指数增长并封顶,确诊不健康后停止高频重启。
    if (nowMs < this.nextRestartAt) {
      return { kind: "skip" };
    }
    this.backoffMs =
      this.backoffMs === 0
        ? RESTART_BACKOFF_BASE_MS
        : Math.min(this.backoffMs * 2, RESTART_BACKOFF_MAX_MS);
    this.nextRestartAt = nowMs + this.backoffMs;
    return { kind: "restart", nextRestartAtMs: this.nextRestartAt };
  }

  private reset(): void {
    this.restartCycles = 0;
    this.backoffMs = 0;
    this.nextRestartAt = 0;
  }
}
