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
  CONFIG_SAVE_RESPONSE_BUDGET_MS,
  applyDefaultAgentSwitch,
  parkDshSessionBoundaryNotice,
  computeHasAgentConfigChange,
  computeHasApprovalConfigChange,
  touchesAgentsSubtree,
} from './shared.js';
import type { ConfigSwitchResult } from './shared.js';

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

/**
 * 把一次字段变更交给当前 agent 的 config builder（处理 provider→model 这类
 * 依赖关系），逐条写进草稿，再把草稿刷到所有配置卡。
 * `config.set`（下拉）与 `config.input`（输入框提交）共用同一套应用逻辑。
 */
export async function applyConfigFieldChange(
  host: CommandRouter,
  key: string,
  newValue: string,
  ctx: CommandContext,
): Promise<void> {
  try {
    host.ensurePendingConfig();

    const defaultAgent = host.pendingConfig!.defaultAgent ?? 'claude';
    const configBuilder = getConfigBuilder(defaultAgent);
    const patches = configBuilder.handleFieldChange(key, newValue, host.pendingConfig!);

    for (const patch of patches) {
      host.setNestedValue(host.pendingConfig!, patch.key, patch.value);
    }

    await host.refreshConfigCards(ctx);
  } catch (err) {
    await host.bridge.sendResult({ text: `设置失败: ${(err as Error).message}` }, ctx);
  }
}

/**
 * 把当前草稿刷到所有已知 config 卡片上（含本次点击的那张）。
 *
 * 被点击的那张走 `updateCardInPlace`（失败 fallback 发新卡，保证点击必有
 * 反馈）；其余兄弟卡走 `patchCard`（纯 best-effort，失败即从集合剔除，不再
 * 重复打无效 PATCH，也不会因为卡片过期而反复补发新卡）。
 */
export async function refreshConfigCards(host: CommandRouter, ctx: CommandContext): Promise<void> {
  host.rememberConfigCard(ctx.messageId);
  const card = host.buildConfigCard().card;
  if (!card) return;
  for (const messageId of [...host.configCardIds]) {
    if (messageId === ctx.messageId) {
      await host.bridge.updateCardInPlace(card, ctx);
      continue;
    }
    const ok = await host.bridge.patchCard(messageId, card);
    if (!ok) host.configCardIds.delete(messageId);
  }
}

/**
 * 串行化 config.* 卡片回调（修复连击卡死 bug）。
 *
 * CardKit 2.0 input/button 回调经 `enqueueImmediate` 分发，不进 bridge 的
 * 串行队列；多次快速点击下拉/文本框会并发读写 `pendingConfig` 并同时调
 * `updateCardInPlace` → 两个 patch 请求乱序到达飞书，后到达的 patch（点击 1
 * 的旧卡片）覆盖先到达的 patch（点击 2 的新卡片），用户看到控件卡死。
 *
 * 此方法把所有 config.* 动作串成一个 Promise chain：每个动作等前一个动作
 * 的 `updateCardInPlace` 完全 settle 后再读 `pendingConfig`。
 */
export function enqueueConfigAction(
  host: CommandRouter,
  value: CardActionPayload,
  ctx: CommandContext,
): Promise<CardActionResponse | void> {
  const run = async (): Promise<CardActionResponse | void> => {
    // 上一轮 config.save 若把收尾转入后台，先等它，避免并发改卡（连击乱序）。
    await host.configSaveTail;
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
      await host.applyConfigFieldChange(key, newValue, ctx);
      return;
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
      await host.applyConfigFieldChange(key, newValue, ctx);
      return;
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

      try {
        const oldDefaultAgent = host.config.defaultAgent;
        host.config = setConfigValues(host.configPath, host.config, updates);
        // 运行时传播（idleTimeout / clearRunners / syncAgentChoices /
        // defaultAgent 切换的 session 处理）抽到共享方法，与文本直写路径共用。
        const switchResult = host.propagateConfigSave(oldDefaultAgent, updates, ctx);

        host.pendingConfig = null;
        // 保存已成功。卡片刷新 + 切换卡是收尾工作：给它们一个响应预算，
        // 超时就把剩下的部分转入后台，回调先回 200——飞书 3 秒上限之外没有
        // 第二次机会，卡在慢操作上时用户只会看到「目标服务器超时未响应」。
        const finish = async (): Promise<CardActionResponse | void> => {
          // 原地更新卡片：保存后卡片刷新为已保存状态。
          // 卡片刷新失败不吞切换通知——保存已成功，仅记录日志，
          // 后续切换消息照常发送；真正写盘/传播阶段的失败才走外层 catch 报「保存失败」。
          try {
            // host 可能已变更 → 重新预取 DSH 目录（内部按 host 缓存，未变不重复拉）
            await host.prefetchConfigCardCatalogs();
            await host.refreshConfigCards(ctx);
          } catch (refreshErr) {
            getLogger().warn(
              `[router] config.save 卡片刷新失败（保存已成功）: ${(refreshErr as Error).message}`,
            );
          }

          // agent 切换时发送 Resume 卡片（替代纯文本通知），
          // 让用户直观看到新 agent 的会话状态和历史。
          // 发送失败（resolve false）时兜底回退 toast 即时反馈。
          if (switchResult.notice) {
            const switchCard = host.buildConfigSwitchCard(switchResult, ctx);
            const sent = await host.bridge.sendResult(switchCard, ctx);
            if (!sent) {
              return {
                toast: { type: 'info', content: switchResult.notice },
              };
            }
          }
        };

        const work = finish().catch((err: unknown) => {
          getLogger().error('[router] config.save 收尾失败（保存已成功）:', err);
        });
        host.configSaveTail = work.then(
          () => undefined,
          () => undefined,
        );
        const budgetExceeded = Symbol('config-save-budget');
        const outcome = await Promise.race([
          work,
          sleep(CONFIG_SAVE_RESPONSE_BUDGET_MS).then(() => budgetExceeded),
        ]);
        if (outcome === budgetExceeded) {
          getLogger().warn(
            `[router] config.save 响应超出 ${CONFIG_SAVE_RESPONSE_BUDGET_MS}ms 预算，卡片刷新与切换卡转入后台`,
          );
          return;
        }
        return outcome as CardActionResponse | void;
      } catch (err) {
        await host.bridge.sendResult({ text: `保存失败: ${(err as Error).message}` }, ctx);
      }
      return;
    }
    default:
      return;
  }
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
  // Ensure probe cache is populated before building the card.
  await probeAllAgents();

  // 动态清单预取：DSH 模型/预设目录、CodeBuddy 模型目录。卡渲染前刷新，
  // 外部新增的 provider 与切换后的 CodeBuddy 登录立即可见；失败回退兜底。
  await host.prefetchConfigCardCatalogs(true, ctx);

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
      return card;
    } catch (err) {
      return { text: `设置失败: ${(err as Error).message}` };
    }
  }

  // Default: show interactive config card - initialize pendingConfig if needed
  host.ensurePendingConfig();
  return host.buildConfigCard();
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
