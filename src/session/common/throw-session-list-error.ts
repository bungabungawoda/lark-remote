import { getLogger } from '../../logger/index.js';

/**
 * session list 故障路径的统一出口：error 日志 + 抛契约文案 + cause 保留。
 *
 * 契约红线：错误文案固定为 `<agent> session list 读取失败: <msg>`（逐字节），
 * router 靠它展示「列表失败」——静默 [] 会让用户误以为没有 session，
 * 与真空不可区分。
 *
 * 各家 ENOENT → 优雅空态的分支是正常路径，留在调用点，不经过这里。
 */
export function throwSessionListError(agent: string, err: unknown): never {
  getLogger().error(`[${agent}-session-reader] session list failed: ${err}`);
  const msg = err instanceof Error ? err.message : String(err);
  throw new Error(`${agent} session list 读取失败: ${msg}`, { cause: err });
}
