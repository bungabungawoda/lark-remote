// /config 卡片动作、写盘传播与配置卡构建。
import YAML from 'yaml';
import type { CommandContext, CommandResult } from '../../bridge/index.js';
import type { AppConfig } from '../../config/index.js';
import {
  setConfigValue,
  setConfigValues,
  mapAgentKey,
  getAgentConfig,
} from '../../config/index.js';
import { syncAgentChoices } from '../../runner/index.js';
import { atomicWrite } from '../../persistence/atomic-write.js';
import { getLogger } from '../../logger/index.js';
import { sleep } from '../../common/sleep.js';
import { enforceCardBudget } from '../../card/card-budget.js';
import { agentDisplayName } from '../../card/card-shared.js';
import { markdownDiv } from '../../card/card-helpers.js';
import type { AgentKind } from '../../agent-kinds.js';
import { getConfigBuilder, listRegisteredAgents, sortAgentsForDisplay } from '../config/index.js';
import { buildConfigCardFromTabs } from '../config/common/render.js';
import type { ConfigTab } from '../config/common/render.js';
import type { ConfigField } from '../config/types.js';
import { probeAllAgents, getCachedAvailability } from '../../runner/probe.js';
import { resolveDshCredentialsFile } from '../../dsh/auth.js';
import {
  defaultCodebuddyProductConfigCacheDir,
  invalidateCodebuddyCatalogCache,
  invalidateCodebuddyRegion,
  refreshCodebuddyCatalogForConfig,
} from '../../config/codebuddy-catalog.js';
import {
  diffConfig as computeConfigDiff,
  setNestedValue as assignNestedValue,
} from '../config-diff.js';
import type { CommandRouter } from '../index.js';
import type { CardActionPayload, CardActionResponse } from './shared.js';
import {
  MAX_CONFIG_CARDS,
  CONFIG_CALLBACK_BUDGET_MS,
  CONFIG_OPEN_PREFETCH_BUDGET_MS,
  CONFIG_SWITCH_NOTICE_BUDGET_MS,
  applyDefaultAgentSwitch,
  parkDshSessionBoundaryNotice,
  computeHasAgentConfigChange,
  computeHasApprovalConfigChange,
  touchesAgentsSubtree,
} from './shared.js';
import type { ConfigSwitchResult } from './shared.js';
import { scheduleConfigRender } from './config-render.js';
import { logConfigPerf, ConfigPerfSpan } from '../../common/config-perf.js';

export function ensurePendingConfig(host: CommandRouter): void {
  if (!host.pendingConfig) {
    host.pendingConfig = structuredClone(host.config);
  }
}

/**
 * 记住一张 config 卡片 messageId（有界：超限丢最早的一张）。
 * 无 messageId 的调用（测试/文本路径）不登记。
 */
export function rememberConfigCard(host: CommandRouter, messageId: string | undefined): void {
  if (!messageId) return;
  host.configCardIds.delete(messageId);
  host.configCardIds.add(messageId);
  while (host.configCardIds.size > MAX_CONFIG_CARDS) {
    const oldest = host.configCardIds.values().next().value as string;
    host.configCardIds.delete(oldest);
  }
}

export interface ConfigRefreshStats {
  patches: number;
  t_build_ms: number;
  t_patch_ms: number;
}

/**
 * 配置卡的单一预算出口：inline 响应体与兄弟卡 PATCH 必须走同一套口径。
 *
 * 飞书对单卡「带 tag 节点 ≤ 200」（`MAX_CARD_COMPONENTS` 保守到 190）的限制在
 * send 与 patch 两条路径上都成立。只在一处裁剪会让另一条路径被 `11310` 拒绝，
 * 而 `patchCard` 失败会把该卡从 `configCardIds` 永久剔除——多卡同步静默失效，
 * 表面症状是「只有刚点的那张卡有新值」。
 */
function budgetConfigCard(card: object, where: 'inline' | 'patch'): object {
  const { card: safeCard, wasTruncated, reason, bytesAfter } = enforceCardBudget(card);
  if (wasTruncated) {
    getLogger().info(
      `[router] config card budget applied (${where}): reason=${reason} bytesAfter=${bytesAfter}`,
    );
  }
  return safeCard;
}

/**
 * 把当前草稿刷到所有已知 config 卡片上（仅后台渲染队列调用）。
 *
 * **不在这里登记卡片**：登记是调度时刻的事（scheduleConfigRender 同步完成，
 * `/c` 文本命令通过 skipRemember 排除）。之前把「是否登记」存进合并后的 pending
 * 再传给本函数，合并时字段一丢就会把用户文本消息 id 登记成 config 卡，之后每次
 * config.set 都会把那条聊天消息 PATCH 成配置卡。职责拆开后这类事故不可能再出现。
 *
 * `excludeMessageId` 是刚被响应体替换的那张，跳过避免同消息重复 PATCH 触发
 * 飞书 230429。注意：它同时意味着这张卡不会拿到本轮刷新后的目录（如 DSH 新增
 * provider），下一次点击会补齐——最终一致，不做二次 PATCH。
 */
export async function refreshConfigCards(
  host: CommandRouter,
  excludeMessageId?: string,
): Promise<ConfigRefreshStats> {
  const buildStart = Date.now();
  const built = host.buildConfigCard().card;
  // 与 inline 响应同一预算口径：超限卡的 PATCH 会被飞书整卡拒绝，
  // 再被 patchCard 的失败分支把这个 messageId 永久剔除。
  const card = built ? budgetConfigCard(built, 'patch') : undefined;
  const t_build_ms = Date.now() - buildStart;
  if (!card) return { patches: 0, t_build_ms, t_patch_ms: 0 };
  const patchStart = Date.now();
  let patches = 0;
  for (const messageId of [...host.configCardIds]) {
    if (messageId === excludeMessageId) continue;
    const ok = await host.bridge.patchCard(messageId, card);
    if (ok) patches += 1;
    else host.configCardIds.delete(messageId);
  }
  return { patches, t_build_ms, t_patch_ms: Date.now() - patchStart };
}

/**
 * 把一次字段变更交给当前 agent 的 config builder（处理 provider→model 这类
 * 依赖关系），逐条写进草稿。`config.set`（下拉）与 `config.input`（输入框提交）
 * 共用同一套应用逻辑。
 *
 * apply 段全是内存操作（+ 目录 SWR 同步读），不含网络写；卡片渲染交给后台队列。
 */
export async function applyConfigFieldChange(
  host: CommandRouter,
  key: string,
  newValue: string,
  ctx: CommandContext,
): Promise<CardActionResponse | void> {
  const span = new ConfigPerfSpan();
  try {
    host.ensurePendingConfig();

    const defaultAgent = host.pendingConfig!.defaultAgent ?? 'claude';
    const configBuilder = getConfigBuilder(defaultAgent);
    const patches = configBuilder.handleFieldChange(key, newValue, host.pendingConfig!);

    for (const patch of patches) {
      host.setNestedValue(host.pendingConfig!, patch.key, patch.value);
    }
    span.segment('apply');

    // 回调响应体直出这张卡（飞书原地替换 pre-click 卡，零额外网络写）。
    const card = host.buildConfigCard().card;
    span.segment('build');
    logConfigPerf('apply', {
      cmd: 'config.set',
      key,
      agent: defaultAgent,
      patches_in_callback: 0,
      budget_exceeded: span.totalMs() > CONFIG_CALLBACK_BUDGET_MS,
      ...span.fields(),
    });
    if (!card) return;

    scheduleConfigRender(host, { ctx, refreshCatalogs: false, inlineMessageId: ctx.messageId });
    return {
      // 响应体携带卡片：飞书原地替换被点击的那张（零 PATCH）；兄弟卡由后台
      // 渲染队列刷新。toast 给一行暂存提示，避免用户以为已经写盘。
      toast: { type: 'info', content: `已暂选 ${newValue}（未保存）` },
      card: { type: 'raw', data: budgetConfigCard(card, 'inline') },
    };
  } catch (err) {
    return { toast: { type: 'error', content: `设置失败: ${(err as Error).message}` } };
  }
}

/**
 * 串行化 config.* 卡片回调的**内存草稿** apply（修复连击卡死 bug）。
 *
 * 与旧版的区别：链里只有内存读写 + 建卡，没有网络写；卡片 PATCH 由独立的
 * 后台渲染队列串行合并。因此不再 `await host.configSaveTail`——旧版等后台 tail
 * 会让一次慢收尾传染给后续每一次点击（日志里连点后接超时的形态）。
 */
export function enqueueConfigAction(
  host: CommandRouter,
  value: CardActionPayload,
  ctx: CommandContext,
): Promise<CardActionResponse | void> {
  const run = async (): Promise<CardActionResponse | void> => {
    try {
      return await host.dispatchConfigAction(value, ctx);
    } catch (err) {
      getLogger().error('[router] config action error:', err);
    }
  };
  const next = host.configActionQueue.then(run);
  // chain 永不 reject（错误已在 run 内吞掉），保证后续动作不被卡住
  host.configActionQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export async function dispatchConfigAction(
  host: CommandRouter,
  value: CardActionPayload,
  ctx: CommandContext,
): Promise<CardActionResponse | void> {
  switch (value.cmd) {
    case 'config.set': {
      // Set config value from select dropdown (option from CardKit 2.0)
      const key = value.key as string | undefined;
      const newValue = value.option as string | undefined;
      if (!key || newValue === undefined) {
        await host.bridge.sendResult({ text: '缺少参数' }, ctx);
        return;
      }
      return host.applyConfigFieldChange(key, newValue, ctx);
    }
    case 'config.input': {
      // Handle input field: value.key is the field key.
      // CardKit 2.0 input 提交（回车/完成键）触发 callback，回传 input_value。
      // Fall back to formValue[key]: the SDK currently reports input values
      // via action.formValue for form-wrapped inputs.
      const key = value.key as string | undefined;
      if (!key) {
        await host.bridge.sendResult({ text: '缺少配置项 key' }, ctx);
        return;
      }
      const newValue = value.inputValue ?? (value.formValue?.[key] as string | undefined);
      if (newValue === undefined) {
        await host.bridge.sendResult({ text: '缺少输入值' }, ctx);
        return;
      }
      return host.applyConfigFieldChange(key, newValue, ctx);
    }
    case 'config.save': {
      // 批量保存：将 pendingConfig 一次性写入磁盘
      if (!host.pendingConfig) {
        await host.bridge.sendResult({ text: '没有待保存的修改' }, ctx);
        return;
      }
      const updates = host.diffConfig(host.config, host.pendingConfig);
      if (Object.keys(updates).length === 0) {
        host.pendingConfig = null;
        await host.bridge.sendResult({ text: '没有变更需要保存' }, ctx);
        return;
      }

      const span = new ConfigPerfSpan();
      try {
        const oldDefaultAgent = host.config.defaultAgent;
        host.config = setConfigValues(host.configPath, host.config, updates);
        // 运行时传播（idleTimeout / clearRunners / syncAgentChoices /
        // defaultAgent 切换的 session 处理）与文本直写路径共用，全是本地同步操作。
        const switchResult = host.propagateConfigSave(oldDefaultAgent, updates, ctx);
        host.pendingConfig = null;
        span.segment('apply');
        logConfigPerf('apply', {
          cmd: 'config.save',
          agent: host.config.defaultAgent,
          fields: Object.keys(updates).length,
          budget_exceeded: span.totalMs() > CONFIG_CALLBACK_BUDGET_MS,
          ...span.fields(),
        });

        // 目录预取 + 兄弟卡刷新进后台渲染队列（串行 + 合并）。切换通知仍在回调
        // 内发送（锚定契约：它是持久消息，成功不回 toast、失败才回退），但带预算
        // ——见 sendSwitchNotice。
        scheduleConfigRender(host, {
          ctx,
          refreshCatalogs: true,
          inlineMessageId: ctx.messageId,
        });

        if (switchResult.notice) {
          return await sendSwitchNotice(host, switchResult, ctx);
        }
        return;
      } catch (err) {
        await host.bridge.sendResult({ text: `保存失败: ${(err as Error).message}` }, ctx);
      }
      return;
    }
    default:
      return;
  }
}

const SWITCH_NOTICE_BUDGET_HIT = Symbol('switch-notice-budget');

/**
 * 切换 Agent 的持久化通知：仍在回调内发送，但给一个响应预算。
 *
 * 锚定契约要求它是**持久消息**（成功不回 toast、失败才回退 info toast），所以
 * 不能直接丢进后台渲染队列。但这是整条回调里唯一剩下的网络写：写盘与运行时
 * 传播已经完成，若网络长尾（重试、限流）把它拖过飞书 3 秒上限，用户看到的是
 * 「目标服务器超时未响应」而配置其实已保存——最坏的误导。
 *
 * 超预算时通知转后台继续发；后台也失败才补一条文本回执，保证用户最终仍能
 * 看到「切到哪个 agent」，只是不在同一次回调里。
 */
async function sendSwitchNotice(
  host: CommandRouter,
  switchResult: ConfigSwitchResult,
  ctx: CommandContext,
): Promise<CardActionResponse | void> {
  const notice = switchResult.notice!;
  const card = host.buildConfigSwitchCard(switchResult, ctx);
  const send = host.bridge.sendResult(card, ctx);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budgetHit = new Promise<typeof SWITCH_NOTICE_BUDGET_HIT>((resolve) => {
    timer = setTimeout(() => resolve(SWITCH_NOTICE_BUDGET_HIT), CONFIG_SWITCH_NOTICE_BUDGET_MS);
    // 发送先胜出时别让这个定时器把进程多钉住一个预算。
    timer.unref?.();
  });
  let outcome: boolean | typeof SWITCH_NOTICE_BUDGET_HIT;
  try {
    outcome = await Promise.race([send, budgetHit]);
  } finally {
    clearTimeout(timer);
  }
  if (outcome !== SWITCH_NOTICE_BUDGET_HIT) {
    // 回调内已完成：成功不回 toast，失败回退 info toast（锚定契约）。
    return outcome ? undefined : { toast: { type: 'info', content: notice } };
  }

  getLogger().warn(`[router] 切换通知超出 ${CONFIG_SWITCH_NOTICE_BUDGET_MS}ms 预算，转后台补发`);
  void send.then(
    (sent) => {
      if (sent) return;
      getLogger().warn('[router] 切换通知卡片后台发送失败，改发文本回执');
      void host.bridge.sendResult({ text: notice }, ctx);
    },
    (err: unknown) => {
      getLogger().error('[router] 切换通知后台发送异常，改发文本回执:', err);
      void host.bridge.sendResult({ text: notice }, ctx);
    },
  );
  // 回调体已经给出反馈（保存成功的卡片刷新由后台队列完成），不再补 toast。
  return;
}

export function setNestedValue(
  host: CommandRouter,
  target: AppConfig,
  key: string,
  value: unknown,
): void {
  assignNestedValue(target, key, value);
}

export function diffConfig(
  host: CommandRouter,
  original: AppConfig,
  pending: AppConfig,
): Record<string, string | undefined> {
  return computeConfigDiff(original, pending);
}

/**
 * config 写盘后的运行时传播（自 config.save 卡片路径抽出，卡片保存与
 * `/config <key> <value>` 文本直写两条路径共用）。
 *
 * 1. bridge 运行时值同步：setConfig + idle watchdog timeout；
 * 2. agent 配置或 defaultAgent 变更 → clearRunners（否则 runner 缓存继续用旧
 *    配置值，/status 与真实 run 自相矛盾）；
 * 3. defaultAgent 切换 → 旧 agent session 存 previousSessions、新 agent 恢复
 *    或清空（等效 /new）；
 * 4. 当前 agent 配置变更 → syncAgentChoices 并原子写盘（禁裸同步写盘，
 *    写一半崩溃会截断 config.yaml 导致 bridge 起不来）。
 *
 * @param updates 以 config 路径形式给出的变更 key（卡片路径来自 diffConfig；
 *   直写路径传 mapAgentKey(key)，保证 pi./codex./opencode./kimi. 命中 agents.*）。
 * @returns 结构化切换结果（含 notice 文案 + 新 agent/sessionId 信息）
 */
export function propagateConfigSave(
  host: CommandRouter,
  oldDefaultAgent: AgentKind,
  updates: Record<string, string | undefined>,
  ctx: CommandContext,
): ConfigSwitchResult {
  host.bridge.setConfig(host.config);
  // idle.watchdogMinutes 改动需同步到 bridge 的 idleTimeoutMs
  host.idleTimeoutMs = host.config.idle.watchdogMinutes * 60_000;
  host.bridge.setIdleTimeout(host.idleTimeoutMs);

  // 检测是否有任何 agent 配置变更或 defaultAgent 切换
  const hasDefaultAgentChange = oldDefaultAgent !== host.config.defaultAgent;
  const changedKeys = Object.keys(updates);
  const hasAgentConfigChange = computeHasAgentConfigChange(changedKeys);

  // CodeBuddy 模型目录是 f(登录态, 区域)：env（尤其
  // CODEBUDDY_INTERNET_ENVIRONMENT）或 binary 一变，旧快照就属于另一个身份。
  // 立刻失效，让同一次保存后的卡片重绘重新点火探针；否则 negative cache
  // 会在 5 分钟 TTL 内继续把旧区域的模型列表渲染给用户。
  const hasCodebuddyIdentityChange = changedKeys.some(
    (key) =>
      key.startsWith('agents.codebuddy.env') ||
      key.startsWith('agents.codebuddy.cli') ||
      key === 'agents.codebuddy.binary',
  );
  if (hasCodebuddyIdentityChange) {
    invalidateCodebuddyCatalogCache();
    invalidateCodebuddyRegion();
    // 换区后旧 sessionId 属于另一个身份：留着会被 /restart 的
    // restoreLastSession() auto-resume 回旧区域会话并重放 401。只清当前
    // agent 的 session，cwd 保留（用户还在同一个工作目录）。
    host.sessionStore.clearSessionId(ctx.userId, 'codebuddy');
    getLogger().info('[config] codebuddy identity changed, catalog/region/session invalidated');
  }

  // 当 defaultAgent 改变时，清除旧 agent 的 sessionId，
  // 同时清除新 agent 的 sessionId（等效于 /new 命令），
  // 并支持 session 恢复 - 切换回来时如果条件满足则恢复之前的 session。
  let switchNotice: string | undefined;
  let switchNewAgent: AgentKind | undefined;
  let switchSessionId: string | undefined;
  if (hasDefaultAgentChange) {
    const outcome = applyDefaultAgentSwitch(
      host.sessionStore,
      ctx.userId,
      oldDefaultAgent,
      host.config.defaultAgent,
    );
    switchNotice = outcome.notice;
    switchNewAgent = outcome.newAgent;
    switchSessionId = outcome.sessionId;
  }

  // DSH 的两个「会话边界」变更共用一套处理：preset 在 session 创建时固定，
  // 中途切换会被服务端拒绝（agent-preset-conflict）；host 变更等于换服务，
  // 旧 host 的 sessionId 发往新 host 是错的。两者都把旧 sessionId 停到
  // previousSessions 恢复槽（可 /resume 校验后恢复）并清空当前值，下次 run
  // 走 session.create 新建。已发生 agent 切换时（switchNotice 已设置）跳过，
  // 避免覆盖切换 notice——切换分支对 dsh 的 session 已做恢复/清空处理。
  switchNotice = parkDshSessionBoundaryNotice(
    host.sessionStore,
    ctx.userId,
    host.config.defaultAgent,
    changedKeys.includes('agents.dsh.agentPreset'),
    'preset',
    switchNotice,
  );
  switchNotice = parkDshSessionBoundaryNotice(
    host.sessionStore,
    ctx.userId,
    host.config.defaultAgent,
    changedKeys.includes('agents.dsh.host'),
    'host',
    switchNotice,
  );

  // 同步 agent 配置到 agentChoices（用于切换 agent 时恢复配置）
  const currentAgent = host.config.defaultAgent;
  if (touchesAgentsSubtree(changedKeys, currentAgent)) {
    host.config = syncAgentChoices(host.config, currentAgent);
    // agentChoices 同步写盘必须走原子写（tmp+rename），禁裸同步写盘
    atomicWrite(host.configPath, YAML.stringify(host.config));
    host.bridge.setConfig(host.config);
  }

  // live approval settings: active workspace-lifetime runners
  // are not evicted by clearRunners() (would orphan the live subprocess).
  // Push the new approval-mode settings to those runners via the unified
  // duck method `updateApprovalMode` (codex thread/settings/update,
  // kimi/opencode session/set_mode) so they take effect for subsequent
  // turns without waiting for the runner to be recreated.
  const hasApprovalConfigChange = computeHasApprovalConfigChange(changedKeys);
  if (hasApprovalConfigChange) {
    host.bridge.syncActiveApprovalModes();
  }

  // 任何 agent 配置变更或 defaultAgent 切换，都清除 runner 缓存
  if (hasDefaultAgentChange || hasAgentConfigChange) {
    host.bridge.clearRunners();
  }

  return { notice: switchNotice, newAgent: switchNewAgent, sessionId: switchSessionId };
}

export async function cmdConfig(
  host: CommandRouter,
  args: string[],
  ctx: CommandContext,
): Promise<CommandResult> {
  const span = new ConfigPerfSpan();
  // Ensure probe cache is populated before building the card.
  await probeAllAgents();
  span.segment('probe');

  // 动态清单预取：DSH 模型/预设目录、CodeBuddy 模型目录。
  // 只给一个短预算，超时立即用缓存/兜底清单出卡，后台继续刷新并合并渲染一次
  // （飞书卡片回调 3 秒上限；打开 /config 不该被 RPC/探针拖住）。
  const prefetch = host.prefetchConfigCardCatalogs(true, ctx);
  const prefetchDone = Symbol('prefetch-done');
  const outcome = await Promise.race([
    prefetch.then(() => prefetchDone),
    sleep(CONFIG_OPEN_PREFETCH_BUDGET_MS),
  ]);
  const deferred = outcome !== prefetchDone;
  span.segment('prefetch');
  if (deferred) {
    // 交给 router 在卡片发送并登记之后接上刷卡片（见 trackConfigOpenRefresh）：
    // 预取先于发卡落地时，新卡还没进 configCardIds，这里直接调度会漏掉它。
    host.trackConfigOpenRefresh(prefetch);
  }
  logConfigPerf('open', {
    agent: host.config.defaultAgent,
    prefetch_deferred: deferred,
    ...span.fields(),
  });

  // Check if this is a direct set command: /config <key> <value>
  // Command-style set: immediate write to disk, clear pendingConfig
  if (args.length >= 2) {
    const key = args[0];
    const value = args.slice(1).join(' ');
    try {
      const oldDefaultAgent = host.config.defaultAgent;
      // 直写前若 pendingConfig 存在未保存差异，提示用户被丢弃的条数，
      // 避免静默清空导致用户在卡片上的修改无反馈丢失。差异必须在 setConfigValue
      // 之前计算——直写本身也会改变 config，不应计入「被丢弃的未保存修改」。
      const discarded = host.pendingConfig
        ? Object.keys(host.diffConfig(host.config, host.pendingConfig)).length
        : 0;
      host.config = setConfigValue(host.configPath, host.config, key, value);
      // 直写路径与 config.save 卡片路径共用运行时传播（idleTimeout /
      // clearRunners / syncAgentChoices / defaultAgent 切换）。key 经 mapAgentKey
      // 归一化，pi./codex./opencode./kimi. 命中 agents.* 判定；claude. 与
      // defaultAgent 不再漏判。
      const switchResult = host.propagateConfigSave(
        oldDefaultAgent,
        { [mapAgentKey(key)]: value },
        ctx,
      );
      host.pendingConfig = null; // 命令式写盘后清空暂存，避免不一致
      // agent 切换时额外发送 Resume 卡片
      if (switchResult.notice) {
        const switchCard = host.buildConfigSwitchCard(switchResult, ctx);
        // 文本路径返回 config card，Resume card 通过 bridge 异步发送
        void host.bridge.sendResult(switchCard, ctx);
      }
      const card = host.buildConfigCard();
      if (discarded > 0) {
        // buildConfigCardFromTabs 恒返回 body.elements（至少含保存按钮），
        // 这里直接收窄插入提示条——同模块自己刚构建的值无需逐层探测。
        const body = (card.card as { body: { elements: object[] } }).body;
        body.elements.unshift({
          tag: 'div',
          text: { tag: 'lark_md', content: `⚠️ 已丢弃 ${discarded} 项未保存修改` },
        });
      }
      // 发送成功后由 router 登记（trackConfigCard）：deferred 目录刷新与后续
      // config.* 兄弟卡刷新都要覆盖这张卡。
      return { ...card, trackConfigCard: true };
    } catch (err) {
      return { text: `设置失败: ${(err as Error).message}` };
    }
  }

  // Default: show interactive config card - initialize pendingConfig if needed
  host.ensurePendingConfig();
  // 发送成功后由 router 登记（trackConfigCard），让 deferred 目录刷新能覆盖它。
  return { ...host.buildConfigCard(), trackConfigCard: true };
}

/**
 * 卡片构建前的动态清单预取。
 *
 * - **DSH**：`/config` 打开时强制刷新模型/预设目录，Web UI 刚新增的 provider
 *   立即可见；失败回退固定兜底清单。
 * - **CodeBuddy**：模型清单只随 ACP `session/new` 下发，且目录是
 *   f(登录态, 区域)。这里按账号指纹（`settings.json` 的 mtime+size）决定是否
 *   重探：切换 CodeBuddy 登录后第一次打开 `/config` 就能看到新模型，而不是
 *   等下一条消息 401 才被动重建。指纹/区域变化时顺带重置持久 sessionId 与
 *   runner（它们绑在旧身份上，不重置会在失效端点重放 401）。
 *
 * 预取失败不阻断——两个 builder 内部都有兜底（DSH 固定清单、CodeBuddy 文本输入）。
 */
export async function prefetchConfigCardCatalogs(
  host: CommandRouter,
  force = false,
  ctx?: CommandContext,
): Promise<void> {
  if (host.config.defaultAgent === 'codebuddy') {
    const cbConf = getAgentConfig(host.config, 'codebuddy');
    const outcome = await refreshCodebuddyCatalogForConfig({
      binary: cbConf?.acp?.binary,
      env: cbConf?.env,
      hostProductConfigCacheDir: defaultCodebuddyProductConfigCacheDir(),
    });
    if (outcome.identityChanged && ctx) host.bridge.resetCodebuddyRuntime(ctx.userId);
    return;
  }
  if (host.config.defaultAgent !== 'dsh') return;
  const builder = getConfigBuilder('dsh');
  const dshConf = getAgentConfig(host.config, 'dsh');
  const credentialsFile =
    dshConf?.credentialsFile?.trim() ||
    (dshConf?.dshHome?.trim()
      ? resolveDshCredentialsFile(process.env, dshConf.dshHome)
      : undefined);
  await builder.prefetch?.(dshConf?.host, dshConf?.token, credentialsFile, { force });
}

export function buildConfigCard(host: CommandRouter): CommandResult {
  // 使用 pendingConfig（若存在）或当前 config
  const displayConfig = host.pendingConfig ?? host.config;

  // 定义字段分组：defaultAgent 选择器 + 该 agent 的配置字段 + idle.watchdogMinutes +
  // output/logging。stopGraceMs 等实现细节走 YAML，不在卡片暴露。

  // 根据 defaultAgent 构建完整的 Agent 配置字段组
  // 使用 agent config builder 获取该 agent 的配置字段
  const defaultAgent = displayConfig.defaultAgent ?? 'claude';
  const configBuilder = getConfigBuilder(defaultAgent);

  // defaultAgent 选择器作为普通 select 字段交给共享渲染（SelectOption 支持
  // text/value 分离：未安装 agent 的 label 带「⚠️ (未安装)」，value 保持干净）。
  // 固定展示顺序（Codex → Claude → OpenCode → Pi → Kimi → DSH），
  // 明确未安装的 agent 排到后面（getCachedAvailability === false）。
  const allAgents = sortAgentsForDisplay(listRegisteredAgents(), getCachedAvailability);
  const agentOptions = allAgents.map((kind) => {
    const available = getCachedAvailability(kind);
    const label =
      available === false ? `${agentDisplayName(kind)} ⚠️ (未安装)` : agentDisplayName(kind);
    return { text: label, value: kind };
  });
  const selectedAgent = displayConfig.defaultAgent ?? 'claude';
  const agentSelectorField: ConfigField = {
    key: 'defaultAgent',
    label: '默认 Agent',
    type: 'select',
    options: agentOptions,
    currentValue: selectedAgent,
  };

  const tabDefs: ConfigTab[] = [
    {
      id: 'agent',
      label: `🤖 ${agentDisplayName(defaultAgent)}`,
      fields: [agentSelectorField, ...configBuilder.buildFields(displayConfig)],
    },
    {
      id: 'idle',
      label: '⏱️ 空闲',
      fields: [{ key: 'idle.watchdogMinutes', label: '空闲超时(分钟, 0关闭)', type: 'input' }],
    },
    {
      id: 'logging',
      label: '📝 日志',
      fields: [
        {
          key: 'logging.level',
          label: '日志级别',
          type: 'select',
          options: ['debug', 'info', 'warn', 'error'],
        },
      ],
    },
  ];

  // 使用共享渲染模块构建卡片（Agent 选择器作为普通 select 字段参与渲染）
  return { card: buildConfigCardFromTabs(tabDefs, displayConfig) };
}

/**
 * Build card for config.save agent switch.
 * When the new agent has a restored session, renders a Resume card (shared
 * body via buildResumeLikeCard) with session history + stop/new buttons.
 * When the session was cleared, renders a compact notice card instead.
 */
export function buildConfigSwitchCard(
  host: CommandRouter,
  switchResult: ConfigSwitchResult,
  ctx: CommandContext,
): CommandResult {
  const newAgent = switchResult.newAgent!;
  const agentName = agentDisplayName(newAgent);
  const cwd = host.sessionStore.getCwd(ctx.userId);
  const sessionId = switchResult.sessionId;

  // No cwd or no session → compact notice card (no new-session button: the
  // next message already starts a fresh session, a button would mislead
  // users into thinking a click is required)
  if (!cwd || !sessionId) {
    const elements: object[] = [markdownDiv(switchResult.notice!)];
    return {
      card: {
        schema: '2.0',
        config: { wide_screen_mode: true },
        header: {
          title: { tag: 'plain_text', content: `🔀 切换到 ${agentName}` },
        },
        body: { elements },
      },
    };
  }

  // Has session → Resume card (shared body with buildAutoResumeCard)
  // SessionReaderRegistry.get() throws when the agent is not registered —
  // a null-reader fallback branch here is unreachable either way.
  return host.buildResumeLikeCard({
    cwd,
    sessionId,
    agentKind: newAgent,
    titleBase: '切换 Agent',
    idleIcon: '🔀',
    // 切换语义（已使用所选 / 将继续之前的 / 已清空）必须随卡可见：
    // 2026-08-13 换 Resume 卡时这条信息一度只在「无 reader」回退分支
    // 渲染，生产路径（registry 恒有 reader）上不可见——卡上只剩
    // sessionId，用户无法区分显式选择、停车恢复与清空。notice 含
    // sessionId，与「已恢复会话」行并存（agent-switch-entry-points 与
    // arrival-baseline 两族 anchor 分别钉住两行）。
    resumedLine: `已恢复会话: **${sessionId}**`,
    headerTail: switchResult.notice,
    emptyPlaceholder: '_该会话暂无新消息可显示（最后一条为用户输入）_',
  });
}
