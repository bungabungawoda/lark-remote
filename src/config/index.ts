import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { getLogger } from '../logger/index.js';
import { atomicWrite } from '../persistence/atomic-write.js';
import type { AgentKind } from '../runner/index.js';
export { getConfigDir } from './dir.js';

// Import constants from agent config files (SSOT: Layer 1 source)
import { KIMI_THINKING_EFFORTS } from './kimi-config.js';

/** Valid effort values for Claude */
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * Claude 官方 --permission-mode 枚举（claude --help 输出，2026-08 实测）。
 * 额外支持 'default'：Claude settings.json 的官方未设置值，等价于不传
 * --permission-mode（交互式默认：高风险工具逐个询问）。
 * 'manual' 是 'default' 的别名（claude CLI 等价），schema 保留以向后兼容旧配置，
 * 但 UI 下拉不展示（见 router/config/claude.ts）。
 */
export const CLAUDE_PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'manual',
  'dontAsk',
  'plan',
] as const;

/** Valid thinking levels for Pi */
export const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

/** 默认值常量：schema 与 template 共享，避免双源不一致（G25 Magic Numbers）。 */
const DEFAULTS = {
  CLAUDE_MODEL: 'claude-opus-4-8',
  STOP_GRACE_MS: 5000,
  IDLE_WATCHDOG_MINUTES: 15,
  /** ACP/app-server turn idle 超时默认 30 分钟：Kimi/opencode/codex 常因
   *  等待 SubAgent 或长思考长时间静默，10 分钟会误杀正常进行中的 run。 */
  TURN_IDLE_TIMEOUT_MINUTES: 30,
  /** 审批超时默认 5 分钟（对齐 codex 红线：勿随意改短）。 */
  APPROVAL_TIMEOUT_MS: 5 * 60 * 1000,
  /** Claude 会话级空闲回收默认 30 分钟（对齐 codex appServer.idleTtlMs）。 */
  CLAUDE_IDLE_TTL_MINUTES: 30,
} as const;

/**
 * Default SIGTERM→SIGKILL grace period (ms). Exported so runners (SpawningRunner)
 * and config-loading paths (src/index.ts) can reuse the same source of truth
 * instead of re-literalizing `5000` (Clean Code P3-1, G25).
 */
export const DEFAULT_STOP_GRACE_MS = DEFAULTS.STOP_GRACE_MS;

/** Codex app-server turn idle timeout default (minutes). */
export const DEFAULT_TURN_IDLE_TIMEOUT_MINUTES = DEFAULTS.TURN_IDLE_TIMEOUT_MINUTES;

/** 入站媒体默认配置（schema 默认与 connector 兜底共用，避免双源漂移）。 */
export const DEFAULT_INBOUND_MEDIA_DIR_NAME = '.lark-remote-temp';
export const DEFAULT_INBOUND_MEDIA_MAX_SIZE_MB = 50;

/** 模型 ID → alias 映射。 */
export const MODEL_ID_TO_ALIAS: Record<string, string> = {
  'claude-opus-4-8': 'opus',
  'claude-sonnet-4-6': 'sonnet',
  'claude-haiku-4-5-20250501': 'haiku',
  'claude-fable-5': 'fable',
};

/** alias → model ID 反向映射。 */
export const MODEL_ALIAS_TO_ID: Record<string, string> = {
  opus: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20250501',
  fable: 'claude-fable-5',
};

const FeishuConfigSchema = z.object({
  appId: z.string().min(1),
  appSecret: z.string().min(1),
});

const ClaudeConfigSchema = z.object({
  model: z.string().default(DEFAULTS.CLAUDE_MODEL),
  effort: z.enum(CLAUDE_EFFORTS).default('medium'),
  /**
   * Claude 权限模式（官方 --permission-mode 枚举 + 'default'=省略该参数）。
   * 默认 bypassPermissions 保持现有行为（无审批卡）；配置为其他值后激活
   * 交互式审批（control_request → run 卡审批区）。
   */
  permissionMode: z.enum(CLAUDE_PERMISSION_MODES).default('bypassPermissions'),
  /** 审批请求超时（ms），默认 5 分钟；超时自动发送 cancel 并中断 turn。
   *  0 = 立即过期（fail-fast，避免审批永久挂起），不推荐；勿随意改短。 */
  approvalTimeoutMs: z.number().int().min(0).default(DEFAULTS.APPROVAL_TIMEOUT_MS),
  /** 会话级空闲回收（分钟）：turn 之间无新消息超过该窗口则停止长驻进程。 */
  idleTtlMinutes: z.number().int().min(0).default(DEFAULTS.CLAUDE_IDLE_TTL_MINUTES),
  stopGraceMs: z.number().int().min(0).default(DEFAULTS.STOP_GRACE_MS),
});

/** Codex app-server connection configuration. */
const CodexAppServerConfigSchema = z.object({
  /** Path to the codex binary for app-server mode. */
  binary: z.string().default('codex'),
  /** Request timeout in milliseconds. */
  requestTimeoutMs: z.number().int().min(0).default(60000),
  /** Idle TTL for connection pool in milliseconds. */
  idleTtlMs: z.number().int().min(0).default(1800000),
  /** Turn idle timeout in minutes: no app-server output for this long triggers
   *  turn/interrupt and fails the run. 0 disables the timeout. */
  turnIdleTimeoutMinutes: z.number().int().min(0).default(DEFAULT_TURN_IDLE_TIMEOUT_MINUTES),
});

/** Codex-specific configuration. */
export const CodexConfigSchema = z.object({
  /** model to use. Undefined → codex reads from its config.toml. */
  model: z.string().optional(),
  /** model provider, e.g. 'volcengine-coding-plan'. Undefined → codex reads from its config.toml. */
  modelProvider: z.string().optional(),
  /**
   * Reasoning effort level。codex 标准档位 minimal/low/medium/high/xhigh/max/ultra
   * 之外还接受 none 与模型自定义值（ReasoningEffort::Custom），目录声明什么就存什么
   * （P2-5），故用字符串而非枚举。
   */
  // codex 拒绝空串档位（ReasoningEffort::from_str "" → Err，P3-3）
  reasoningEffort: z.string().min(1).optional(),
  /** Approval policy (Codex 官方 AskForApproval 标准值). 默认 on-request。 */
  approvalPolicy: z.enum(['untrusted', 'on-request', 'never']).default('on-request'),
  /** Sandbox mode (Codex 官方 SandboxMode 标准值). 默认 workspace-write。 */
  sandbox: z
    .enum(['read-only', 'workspace-write', 'danger-full-access'])
    .default('workspace-write'),
  /** App-server connection configuration. */
  appServer: CodexAppServerConfigSchema.optional(),
});

/** OpenCode-specific configuration (run mode: opencode run --format json --auto). */
const OpencodeConfigSchema = z.object({
  /** Provider ID for the LLM backend (e.g. 'anthropic'). */
  providerID: z.string().default('anthropic'),
  /** Model ID for the LLM backend (e.g. 'claude-sonnet-4-20250514'). */
  modelID: z.string().default('claude-sonnet-4-20250514'),
  /** Session mode (opencode agent name): 'build' (default) or 'plan'. */
  mode: z.enum(['build', 'plan']).default('build'),
});

/** Pi-specific configuration. pi is a spawn-per-message CLI like Claude. */
const PiConfigSchema = z.object({
  /** LLM provider, e.g. 'Volcano', 'anthropic', 'openai'. */
  provider: z.string().default('Volcano'),
  /** Model ID or alias, e.g. 'glm-5.2'. */
  model: z.string().default('glm-5.2'),
  /** Thinking level: off/minimal/low/medium/high/xhigh. */
  thinking: z.enum(PI_THINKING_LEVELS).default('medium'),
  /** Comma-separated tool whitelist. */
  tools: z.string().default('read,bash,edit,write,grep,find,ls'),
});

/** Kimi-specific configuration. Pure ACP mode (persistent `kimi acp` connection). */
const KimiConfigSchema = z.object({
  /** Model ID or alias, e.g. 'kimi-code/k3'. */
  model: z.string().default('kimi-code/k3'),
  /** Thinking effort: 'on', 'max'. */
  thinkingEffort: z.enum(KIMI_THINKING_EFFORTS).default('max'),
  /** Permission mode: 'manual' (approve each), 'auto' (engine decides), 'yolo' (allow all). */
  permissionMode: z.enum(['manual', 'auto', 'yolo']).default('manual'),
  /** ACP sub-configuration. */
  acp: z
    .object({
      /** Path to kimi binary for ACP mode. */
      binary: z.string().default('kimi'),
      /** Request timeout in milliseconds. */
      requestTimeoutMs: z.number().int().min(0).default(60000),
      /** Idle TTL for ACP connection in milliseconds. */
      idleTtlMs: z.number().int().min(0).default(1800000),
      /** Turn idle timeout in minutes (0 disables). */
      turnIdleTimeoutMinutes: z.number().int().min(0).default(DEFAULT_TURN_IDLE_TIMEOUT_MINUTES),
    })
    .optional(),
});

/** DSH (DeepSeek Harness) Web Host default base URL. */
export const DEFAULT_DSH_HOST = 'http://127.0.0.1:3080';

/** DSH (DeepSeek Harness) Web Host connection config. */
const DshConfigSchema = z.object({
  /** DSH Web Host base URL (no auth, local). */
  host: z.string().url().default(DEFAULT_DSH_HOST),
  /**
   * Session preset（agentPreset）。preset 在 session 创建时固定，中途切换会被
   * 服务端拒绝（agent-preset-conflict）。留空 = 跟随服务端默认（不传 agentPreset）。
   * 枚举不在此硬编码：preset 清单随 DSH profile bundle 变化，合法性由配置卡下拉
   * 控制 + 运行时 DSH API 报错兜底。
   */
  agentPreset: z.string().optional(),
  /** 模型 ID。留空 = 跟随服务端默认。 */
  model: z.string().optional(),
  /**
   * 推理强度（off / low / high / max，跟随 llm.models 实际档位）。留空 = 跟随
   * 服务端默认。枚举不硬编码（理由同上 agentPreset）。
   */
  reasoningEffort: z.string().optional(),
});

/** 首次启动的默认 agents 配置：codex 默认 app-server / on-request / workspace-write。 */
const DEFAULT_AGENTS_CONFIG = {
  codex: CodexConfigSchema.parse({}),
};

/** Agents configuration: per-agent settings keyed by agent kind. */
const AgentsConfigSchema = z.object({
  codex: CodexConfigSchema.default(DEFAULT_AGENTS_CONFIG.codex),
  opencode: OpencodeConfigSchema.optional(),
  pi: PiConfigSchema.optional(),
  kimi: KimiConfigSchema.optional(),
  dsh: DshConfigSchema.optional(),
});

const IdleConfigSchema = z.object({
  /**
   * Idle watchdog 超时窗口（分钟）。Claude run 在此时间内无 stdout 事件则被
   * 视为挂死，bridge 自动 runner.stop() 解除串行队列阻塞（§9.12）。
   * 0 = 关闭 watchdog（不推荐，单次卡死会永久阻塞队列）。
   */
  watchdogMinutes: z.number().int().min(0).default(DEFAULTS.IDLE_WATCHDOG_MINUTES),
});

const OutputConfigSchema = z.object({
  showThinking: z.boolean().default(true),
  showToolUse: z.boolean().default(true),
  showToolResult: z.boolean().default(true),
});

const LoggingConfigSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

/** 入站媒体落盘配置（预留可配置，默认即可用）。 */
const InboundMediaConfigSchema = z.object({
  /** 是否启用图片/文件落盘。 */
  enabled: z.boolean().default(true),
  /** 落盘根目录名（位于当前 cwd 下）。 */
  dirName: z.string().min(1).default(DEFAULT_INBOUND_MEDIA_DIR_NAME),
  /** 单文件大小上限（MiB）。 */
  maxFileSizeMb: z.number().int().min(1).default(DEFAULT_INBOUND_MEDIA_MAX_SIZE_MB),
});

/** Agent-specific saved choices for quick switching. */
const AgentChoicesSchema = z.object({
  codex: z
    .object({
      model: z.string().optional(),
      modelProvider: z.string().optional(),
    })
    .optional(),
  pi: z
    .object({
      model: z.string().optional(),
      provider: z.string().optional(),
      thinking: z.string().optional(),
    })
    .optional(),
  opencode: z
    .object({
      modelID: z.string().optional(),
      providerID: z.string().optional(),
    })
    .optional(),
  kimi: z
    .object({
      model: z.string().optional(),
      thinkingEffort: z.string().optional(),
    })
    .optional(),
  dsh: z
    .object({
      host: z.string().optional(),
    })
    .optional(),
});

export const AppConfigSchema = z.object({
  feishu: FeishuConfigSchema,
  /** Claude config (top-level; other agents live under `agents`). */
  claude: ClaudeConfigSchema.default(ClaudeConfigSchema.parse({})),
  /** Per-agent configuration for non-claude agents. 首次启动默认含 codex（app-server / workspace-write / on-request）。 */
  agents: AgentsConfigSchema.default(DEFAULT_AGENTS_CONFIG),
  /** Agent-specific saved choices for quick switching. */
  agentChoices: AgentChoicesSchema.optional(),
  idle: IdleConfigSchema.default(IdleConfigSchema.parse({})),
  output: OutputConfigSchema.default(OutputConfigSchema.parse({})),
  logging: LoggingConfigSchema.default(LoggingConfigSchema.parse({})),
  /** 入站媒体（图片/文件）落盘配置。 */
  inboundMedia: InboundMediaConfigSchema.default(InboundMediaConfigSchema.parse({})),
  /** Default agent for new runs. */
  defaultAgent: z.enum(['claude', 'codex', 'opencode', 'pi', 'kimi', 'dsh']).default('claude'),
  /** Check for updates on bridge startup (default: false). */
  checkUpdateOnStartup: z.boolean().default(false),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

const TEMPLATE = `feishu:
  appId: ""
  appSecret: ""

claude:
  model: ${DEFAULTS.CLAUDE_MODEL}
  effort: medium
  permissionMode: bypassPermissions
  approvalTimeoutMs: ${DEFAULTS.APPROVAL_TIMEOUT_MS}
  idleTtlMinutes: ${DEFAULTS.CLAUDE_IDLE_TTL_MINUTES}
  stopGraceMs: ${DEFAULTS.STOP_GRACE_MS}

idle:
  watchdogMinutes: ${DEFAULTS.IDLE_WATCHDOG_MINUTES}

output:
  showThinking: true
  showToolUse: true
  showToolResult: true

logging:
  level: info

defaultAgent: claude
`;

export function loadConfig(configPath: string): AppConfig {
  if (!fs.existsSync(configPath)) {
    const dir = path.dirname(configPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(configPath, TEMPLATE, 'utf-8');
    console.error(`[lark-remote] config template generated at ${configPath}`);
    console.error('[lark-remote] please fill in feishu.appId and feishu.appSecret, then restart');
    process.exit(1);
  }

  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = YAML.parse(raw);

  const result = AppConfigSchema.safeParse(parsed);
  if (!result.success) {
    const errors = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    console.error(`[lark-remote] config validation failed:\n${errors}`);
    process.exit(1);
  }

  const config = result.data;
  return config;
}

/**
 * Agent key 前缀，这些前缀的 key 会映射到 `agents.<key>` 路径下。
 * `claude.` 保持顶层（不映射到 agents.claude）。
 */
const AGENT_PREFIXES = ['pi', 'codex', 'opencode', 'kimi', 'dsh'] as const;

/**
 * 将卡片短 key 映射到 schema 期望的路径：
 *   pi.xxx       → agents.pi.xxx
 *   codex.xxx    → agents.codex.xxx
 *   opencode.xxx → agents.opencode.xxx
 *   claude.xxx   → claude.xxx （顶层）
 *   其他         → 原样返回
 *
 * config 与 router 共用此函数（G11 Inconsistency 修复）。
 */
export function mapAgentKey(key: string): string {
  const firstDot = key.indexOf('.');
  const prefix = firstDot === -1 ? key : key.slice(0, firstDot);
  if (AGENT_PREFIXES.includes(prefix as (typeof AGENT_PREFIXES)[number])) {
    return `agents.${key}`;
  }
  return key;
}

/**
 * 将字符串值强制转换为合适的类型（boolean / number / string）。
 * 支持 case-insensitive 的 'true'/'false'，以及整数和浮点数（含负数）。
 */
function coerceValue(raw: string): string | number | boolean {
  const lower = raw.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (/^-?\d+\.\d+$/.test(raw)) return Number(raw);
  return raw;
}

/**
 * 拒绝原型链危险 key 段（§P1-4）。
 *
 * `/config` 直写路径的 key 是用户自由输入：`__proto__.polluted` 会通过
 * `current['__proto__']` 拿到 Object.prototype 并写入，污染整个进程且不可恢复；
 * `constructor.prototype.x` 会把垃圾键写进 config.yaml。三个危险段在合法
 * config 路径中不存在，写/删/读三条路径统一拒绝。
 */
export function assertSafeKeyPart(part: string): void {
  if (part === '__proto__' || part === 'prototype' || part === 'constructor') {
    throw new Error(`[lark-remote] invalid config key segment: '${part}'`);
  }
}

/**
 * 按 dot-separated key 下钻到目标键的父容器（不含最后一段）。
 *
 * - create=true：中间缺失/非对象段自动补 `{}`（set 语义）
 * - create=false：中间缺失/非对象段返回 undefined（get/delete 语义）
 *
 * 危险段（__proto__/prototype/constructor）在每段统一拒绝。
 */
export function walkNestedContainer(
  target: unknown,
  parts: string[],
  create: boolean,
): Record<string, unknown> | undefined {
  let current = target as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    assertSafeKeyPart(parts[i]);
    const next = current[parts[i]];
    if (next == null || typeof next !== 'object') {
      if (!create) return undefined;
      current[parts[i]] = {};
    }
    current = current[parts[i]] as Record<string, unknown>;
  }
  return current;
}

/** 在对象上按 dot-separated key 设置嵌套值（仅修改内存对象，不写盘）。 */
function setNestedValue(target: AppConfig, key: string, value: unknown): void {
  const parts = key.split('.');
  const container = walkNestedContainer(target, parts, true);
  const lastPart = parts[parts.length - 1];
  assertSafeKeyPart(lastPart);
  container![lastPart] = value;
}

/** Get a nested value from config by dot-separated key, e.g. "feishu.appId" */
export function getConfigValue(config: AppConfig, key: string): unknown {
  const parts = key.split('.');
  const container = walkNestedContainer(config, parts, false);
  if (!container) return undefined;
  const lastPart = parts[parts.length - 1];
  assertSafeKeyPart(lastPart);
  return container[lastPart];
}

/** Set a nested value in config by dot-separated key, write back to YAML file */
export function setConfigValue(
  configPath: string,
  config: AppConfig,
  key: string,
  value: string,
): AppConfig {
  return setConfigValues(configPath, config, { [key]: value });
}

/**
 * Set multiple nested values in config, write back to YAML file once.
 *
 * 在 draft 副本上操作（structuredClone），验证通过后才写盘，避免校验失败时
 * 内存中的 config 已被污染（P0 atomicity）。
 */
export function setConfigValues(
  configPath: string,
  config: AppConfig,
  updates: Record<string, string | undefined>,
): AppConfig {
  const draft = structuredClone(config);

  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) {
      // undefined 表示删除该键（如清空 reasoningEffort），
      // 不能写 "undefined" 字面量进 config.yaml
      deleteNestedValue(draft, mapAgentKey(key));
    } else {
      setNestedValue(draft, mapAgentKey(key), coerceValue(value));
    }
  }

  // 运行时校验：不能用 loadConfig（它失败时会 process.exit 杀死 bridge），
  // 改用 safeParse + throw，让 router 把错误反馈给用户
  const result = AppConfigSchema.safeParse(draft);
  if (!result.success) {
    const errors = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`[lark-remote] config validation failed:\n${errors}`);
  }

  atomicWrite(configPath, YAML.stringify(result.data));
  return result.data;
}

/**
 * 按 dot-separated key 删除嵌套值（不存在的键静默忽略）。
 */
function deleteNestedValue(target: AppConfig, key: string): void {
  const parts = key.split('.');
  const container = walkNestedContainer(target, parts, false);
  if (!container) return;
  const lastPart = parts[parts.length - 1];
  assertSafeKeyPart(lastPart);
  delete container[lastPart];
}

/** Type helpers for agent config (used by getAgentConfig). */
type ClaudeConfig = z.infer<typeof ClaudeConfigSchema>;
type CodexConfig = z.infer<typeof CodexConfigSchema>;
type OpencodeConfig = z.infer<typeof OpencodeConfigSchema>;
type PiConfig = z.infer<typeof PiConfigSchema>;
type KimiConfig = z.infer<typeof KimiConfigSchema>;
export type DshConfig = z.infer<typeof DshConfigSchema>;

/** Get configuration for a specific agent. Falls back to defaults if not configured. */
export function getAgentConfig(config: AppConfig, kind: 'claude'): ClaudeConfig;
export function getAgentConfig(config: AppConfig, kind: 'codex'): CodexConfig | undefined;
export function getAgentConfig(config: AppConfig, kind: 'opencode'): OpencodeConfig | undefined;
export function getAgentConfig(config: AppConfig, kind: 'pi'): PiConfig | undefined;
export function getAgentConfig(config: AppConfig, kind: 'kimi'): KimiConfig | undefined;
export function getAgentConfig(config: AppConfig, kind: 'dsh'): DshConfig | undefined;
export function getAgentConfig(
  config: AppConfig,
  kind: AgentKind,
): ClaudeConfig | CodexConfig | OpencodeConfig | PiConfig | KimiConfig | DshConfig | undefined {
  if (kind === 'claude') {
    return config.claude;
  }
  return config.agents?.[kind];
}

/**
 * 从 Claude settings.json 的 env 中读取所有以 MODEL 结尾的环境变量值，
 * 返回去重后的模型 ID 列表。
 * 例如 env 中有 ANTHROPIC_MODEL, ANTHROPIC_DEFAULT_OPUS_MODEL 等，
 * 提取所有值作为可选模型。
 *
 * 注意：只有当用户配置了自定义 base URL 时才返回动态模型列表，
 * 否则返回空数组（使用默认的 alias 列表）。
 */
export function getModelOptionsFromSettings(settingsPath: string): string[] {
  if (!settingsPath) return [];
  if (!fs.existsSync(settingsPath)) return [];

  try {
    const content = fs.readFileSync(settingsPath, 'utf-8');
    const settings = JSON.parse(content);

    if (!settings.env || typeof settings.env !== 'object') return [];

    // 检查是否配置了自定义 base URL
    // 如果使用默认的 Claude API，则返回空数组（使用默认 alias 列表）
    const hasCustomBaseUrl = settings.env.ANTHROPIC_BASE_URL || settings.env.CLAUDE_CODE_BASE_URL;
    if (!hasCustomBaseUrl) {
      return [];
    }

    const modelSet = new Set<string>();
    for (const key of Object.keys(settings.env)) {
      if (key.endsWith('MODEL')) {
        const value = settings.env[key];
        if (typeof value === 'string' && value.trim()) {
          modelSet.add(value.trim());
        }
      }
    }

    return Array.from(modelSet);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    getLogger().warn(`[config] getModelOptionsFromSettings failed for ${settingsPath}: ${err}`);
    return [];
  }
}
