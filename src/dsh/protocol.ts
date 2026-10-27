/**
 * DSH 远程调用的线格式助手（中立层，runner 与 session 共用）。
 *
 * 这两个函数原先住在 `runner/dsh/client.ts`，于是 session/dsh 为了拼一个
 * `args` 信封要 import 上层 runner —— 与 AgentSessionReader 同一类反向依赖。
 */

/** Extract the `token` query parameter from a pasted `dsh web` URL. */
export function extractDshToken(raw: string | undefined): string {
  const value = (raw ?? '').trim();
  if (!value) return '';
  if (!value.includes('token=') && !value.includes('://')) return value;
  try {
    const url = new URL(value.startsWith('?') ? `http://dsh.invalid/${value}` : value);
    const token = url.searchParams.get('token');
    if (token) return token;
    // 带 scheme 却没有 token 参数的输入是误贴的 host URL（如
    // `http://127.0.0.1:3080`）：整串不是合法 token，参与握手只会得到
    // 指向性缺失的 401。返回空串让上游走「token 缺失」的诊断路径。
    if (value.includes('://')) return '';
    return value;
  } catch {
    return value;
  }
}

/**
 * Remote methods take named parameters. Most session methods call their single
 * argument `request`; `session/list` reserves `_request`; catalog methods take
 * no arguments. `commands/*` address the receiving agent by its wire field
 * `agentId`, so their payload is already in wire shape (pass-through).
 * The gateway rejects any other `args` shape.
 */
const DSH_ARGS_KEY: Record<string, string | null> = {
  'session/list': '_request',
  'session/create': 'request',
  'session/prompt': 'request',
  'session/cancel': 'request',
  'session/selectModel': 'request',
  'session/projections': 'request',
  'session/page': 'request',
  'session/follow': 'request',
  'session/updateQueue': 'request',
  'job/list': 'request',
  'job/kill': 'request',
  'session/modelCatalog': null,
  'agentPresets/list': null,
  'permissionPresets/catalog': null,
};

export function dshArgs(method: string, payload: unknown): Record<string, unknown> {
  const key = DSH_ARGS_KEY[method];
  if (key === null) return {};
  if (key === undefined) return payload as Record<string, unknown>;
  return { [key]: payload };
}
