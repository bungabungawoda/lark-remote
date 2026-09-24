/**
 * 平台 seam 纯类型。
 */

/**
 * spawn 发现规格 —— resolveExecutable 的产出（v2 §4.3，仅探测/诊断用）。
 * v2 收窄：.cmd 垫片命中即报告垫片路径本身，不再解析内容定位入口；
 * 执行统一走 platform/spawn.ts 的 cross-spawn 包装。
 */
export interface LaunchSpec {
  kind: 'direct';
  /** 可执行文件路径（posix 绝对路径 / win32 含 .cmd 垫片路径） */
  file: string;
}

/** 终止结果（§3.2 win32 状态机产出；可观测降级用）。 */
export interface TerminateResult {
  /** 进程是否已确认被请求终止（不代表已退出，退出由 exit 事件驱动） */
  requested: boolean;
  /**
   * 终止途经：协议停止 / 强制终止 / 进程已退出 / 无通道跳过优雅段。
   * 强制终止在 posix 下是 SIGKILL 组杀、win32 下是 taskkill 树杀，同枚举值。
   * `requested: false` 时取值为**尝试过的那条途经**，配合 {@link error} 判读。
   */
  via: 'cooperative' | 'taskkill' | 'already-exited' | 'skipped-no-channel';
  /** 请求未送达的原因（ESRCH/进程已消失不算失败，不带此字段） */
  error?: string;
}
