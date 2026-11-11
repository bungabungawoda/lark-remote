// /ls 列表、目录浏览与文件投递动作族。
import path from 'node:path';
import type { CommandContext, CommandResult } from '../../bridge/index.js';
import { MAX_FILE_UPLOAD_SIZE } from '../../connector/file-limits.js';
import { parseJumpOffset, PAGE_JUMP_INVALID_HINT } from '../../card/card-helpers.js';
import { isDirectorySafe, resolveDirectory, statPath } from '../path-validation.js';
import { LS_PAGE_SIZE } from '../commands/ls.js';
import type { CommandRouter } from '../index.js';
import type { CardActionPayload, CardActionResponse } from './shared.js';
import { payloadOffset, searchQueryFrom } from './shared.js';

/**
 * 分页卡动作的 offset 解析：优先读取「跳转页码」输入框（paginationBar 内置
 * 的 CardKit 2.0 input），未输入则回退 `payload.offset`（上一页/下一页按钮）。
 * 非法页码返回 `{ error }`，调用方应回错误 toast 且不刷新卡片。
 */
export function pagingOffset(
  host: CommandRouter,
  value: CardActionPayload,
  defaultPageSize: number,
): { offset: number } | { error: string } {
  const rawSize = Number(value.pageSize);
  const pageSize = Number.isFinite(rawSize) && rawSize > 0 ? Math.trunc(rawSize) : defaultPageSize;
  const jump = parseJumpOffset(value.inputValue, pageSize);
  if (jump === null) return { error: PAGE_JUMP_INVALID_HINT };
  if (jump !== undefined) return { offset: jump };
  return { offset: payloadOffset(value) };
}

/**
 * Handle ls.switch: switch cwd to target directory after path validation.
 */
export async function handleLsSwitch(
  host: CommandRouter,
  value: CardActionPayload,
  ctx: CommandContext,
): Promise<void> {
  const targetPath = value.path;
  if (!targetPath) {
    await host.bridge.sendResult({ text: '卡片 payload 缺少 path' }, ctx);
    return;
  }
  const cwd = host.sessionStore.getCwd(ctx.userId);
  if (!cwd) {
    await host.bridge.sendResult({ text: '请先使用 /cd <path> 设置工作目录' }, ctx);
    return;
  }
  const resolvedTarget = path.resolve(targetPath);
  // 与 ls.browse 对齐：目标只要存在且是目录即可切换（不再做子树/父级限制）。
  // 安全边界由 binder owner 认证兜底，见 docs/zh/architecture/design.md §9.7 更新说明。
  const resolution = resolveDirectory(resolvedTarget);
  if (!resolution.ok) {
    await host.bridge.sendResult({ text: `路径无效: ${resolvedTarget}` }, ctx);
    return;
  }
  // Set cwd + auto-resume + user notification (shared with /cd and /ws use)
  const notifyResult = host.switchCwdAndNotify(ctx.userId, resolution.canonical, ctx);
  // Card channel: refresh ls card in-place (existing behavior preserved)。
  // value.root 是本次 /ls 浏览的起点（绝对路径，不受 cwd 变更影响），透传后
  // 「返回」仍回到用户最初 /ls 的那个目录。
  const card = host.cmdLs([resolution.canonical], ctx, 0, value.root);
  await host.refreshLsCard(card, ctx);
  // Message channel: send switch confirmation / auto-resume card to chat
  await host.bridge.sendResult(notifyResult, ctx);
}

/**
 * Handle ls.refresh: reload current directory.
 */
export async function handleLsRefresh(
  host: CommandRouter,
  value: CardActionPayload,
  ctx: CommandContext,
): Promise<void> {
  const targetPath = value.path;
  const offset = value.offset ?? 0;
  // Treat a vanished/non-dir path as "use current cwd" instead of crashing
  // the refresh. inspectPath closes the former existsSync→statSync race.
  const card =
    targetPath && isDirectorySafe(targetPath)
      ? host.cmdLs([targetPath], ctx, offset, value.root, value.q)
      : host.cmdLs([], ctx, offset, value.root, value.q);
  await host.refreshLsCard(card, ctx);
}

/**
 * ls 卡片动作的统一出口：命令返回 card 时原地刷新；只返回 text（目录读取
 * 失败等）时必须把文案发给用户，不能对 `card.card!` 传 undefined——那样
 * updateCardInPlace 失败后 sendResult({card:undefined}) 也直接返回 false，
 * 用户点了按钮没有任何反馈、真实错误被吞掉。
 */
export async function refreshLsCard(
  host: CommandRouter,
  result: CommandResult,
  ctx: CommandContext,
): Promise<void> {
  if (result.card) {
    await host.bridge.updateCardInPlace(result.card, ctx);
    return;
  }
  await host.bridge.sendResult({ text: result.text ?? '读取目录失败' }, ctx);
}

/**
 * Handle ls.page: paginate to a specific offset.
 */
export async function handleLsPage(
  host: CommandRouter,
  value: CardActionPayload,
  ctx: CommandContext,
): Promise<CardActionResponse> {
  const targetPath = value.path;
  if (!targetPath) {
    return { toast: { type: 'error', content: '卡片 payload 缺少 path' } };
  }
  const paging = host.pagingOffset(value, LS_PAGE_SIZE);
  if ('error' in paging) {
    return { toast: { type: 'error', content: paging.error } };
  }
  const resolvedTarget = path.resolve(targetPath);
  if (!isDirectorySafe(resolvedTarget)) {
    return { toast: { type: 'error', content: `路径无效: ${resolvedTarget}` } };
  }
  const card = host.cmdLs([resolvedTarget], ctx, paging.offset, value.root, value.q);
  if (!card.card) {
    return { toast: { type: 'error', content: card.text ?? '读取目录失败' } };
  }
  // 直接更新卡片，与 ls.browse/ls.refresh 行为一致
  await host.bridge.updateCardInPlace(card.card, ctx);
  return { toast: { type: 'success', content: '' } };
}

/**
 * Handle ls.filter: 按搜索框提交的关键词重新渲染当前目录卡。
 *
 * offset 恒重置为 0（新筛选从第 1 页开始）。路径校验与 TOCTOU 兜底照
 * handleLsPage——校验失败只回错误 toast，绝不动卡片（否则用户看到一张空卡）。
 * ls.browse / ls.switch 的 value 里刻意不带 q，换目录即清除筛选。
 */
export async function handleLsFilter(
  host: CommandRouter,
  value: CardActionPayload,
  ctx: CommandContext,
): Promise<CardActionResponse> {
  const targetPath = value.path;
  if (!targetPath) {
    return { toast: { type: 'error', content: '卡片 payload 缺少 path' } };
  }
  const q = searchQueryFrom(value);
  const resolvedTarget = path.resolve(targetPath);
  if (!isDirectorySafe(resolvedTarget)) {
    return { toast: { type: 'error', content: `路径无效: ${resolvedTarget}` } };
  }
  const card = host.cmdLs([resolvedTarget], ctx, 0, value.root, q);
  if (!card.card) {
    return { toast: { type: 'error', content: card.text ?? '读取目录失败' } };
  }
  await host.bridge.updateCardInPlace(card.card, ctx);
  return { toast: { type: 'success', content: q ? `筛选："${q}"` : '已清除筛选' } };
}

/**
 * Handle ls.browse: browse directory without switching cwd.
 */
export async function handleLsBrowse(
  host: CommandRouter,
  value: CardActionPayload,
  ctx: CommandContext,
): Promise<void> {
  const targetPath = value.path;
  if (!targetPath) {
    await host.bridge.sendResult({ text: '卡片 payload 缺少 path' }, ctx);
    return;
  }
  const resolvedTarget = path.resolve(targetPath);
  if (!isDirectorySafe(resolvedTarget)) {
    await host.bridge.sendResult({ text: `路径无效: ${resolvedTarget}` }, ctx);
    return;
  }
  // Always reset to page 0 when browsing to a new directory
  const card = host.cmdLs([resolvedTarget], ctx, 0, value.root);
  await host.refreshLsCard(card, ctx);
}

/**
 * `ls.file` card button: send file to Feishu, rejecting if > 30MB.
 */
export async function cardLsFile(
  host: CommandRouter,
  target: string | undefined,
  ctx: CommandContext,
): Promise<void> {
  if (!target) {
    await host.bridge.sendResult({ text: '卡片 payload 缺少 path' }, ctx);
    return;
  }
  const result = await host.deliverFileToFeishu(path.resolve(target), ctx);
  if (result) await host.bridge.sendResult(result, ctx);
}

/**
 * 校验并发送本地文件到飞书（≤30MB）。成功返回 null（文件已发出），失败返回
 * 错误 CommandResult 由调用方展示。
 *
 * `/download` 与 `ls.file` 卡片按钮共用，避免两处重复 30MB/存在性校验。
 */
export async function deliverFileToFeishu(
  host: CommandRouter,
  resolved: string,
  ctx: CommandContext,
): Promise<CommandResult | null> {
  const resolution = statPath(resolved);
  if (!resolution.ok) {
    if (resolution.reason === 'missing') return { text: `文件不存在: ${resolved}` };
    return { text: `无法读取: ${resolved}` };
  }
  const { stat } = resolution;
  if (stat.isDirectory()) {
    return { text: `这是一个目录，不能作为文件发送: ${resolved}\n用 /ls 查看目录内容` };
  }
  if (!stat.isFile()) {
    return { text: `不是普通文件: ${resolved}` };
  }
  // 30MB，与飞书 im/v1/files API 对齐
  if (stat.size > MAX_FILE_UPLOAD_SIZE) {
    const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
    return {
      text: `文件太大 (${sizeMB}MB)，超过 ${MAX_FILE_UPLOAD_SIZE / (1024 * 1024)}MB 限制不能发送`,
    };
  }
  await host.bridge.sendFile(resolved, ctx);
  return null;
}
