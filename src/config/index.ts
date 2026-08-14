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

/** Valid thinking levels for Pi */
export const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

/** 默认值常量：schema 与 template 共享，避免双源不一致（G25 Magic Numbers）。 */
const DEFAULTS = {
  CLAUDE_MODEL: 'claude-opus-4-8',
  STOP_GRACE_MS: 5000,
  IDLE_WATCHDOG_MINUTES: 15,
} as const;

/**
 * Default SIGTERM→SIGKILL grace period (ms). Exported so runners (SpawningRunner)
 * and config-loading paths (src/index.ts) can reuse the same source of truth
 * instead of re-literalizing `5000` (Clean Code P3-1, G25).
 */
export const DEFAULT_STOP_GRACE_MS = DEFAULTS.STOP_GRACE_MS;

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
  // permissionMode 硬编码为 bypassPermissions（runner 内部），不通过 config 配置
  stopGraceMs: z.number().int().min(0).default(DEFAULTS.STOP_GRACE_MS),
});

/** Codex-specific configuration. */
export const CodexConfigSchema = z.object({
  /** model to use. Undefined → codex reads from its config.toml. */
  model: z.string().optional(),
  /** model provider, e.g. 'volcengine-coding-plan'. Undefined → codex reads from its config.toml. */
  modelProvider: z.string().optional(),
  // approvalPolicy 和 sandboxPolicy 在 runner 内硬编码（exec 模式使用 approval_policy=never）
  /**
   * Reasoning effort level。codex 标准档位 minimal/low/medium/high/xhigh/max/ultra
   * 之外还接受 none 与模型自定义值（ReasoningEffort::Custom），目录声明什么就存什么
   * （P2-5），故用字符串而非枚举。
   */
  // codex 拒绝空串档位（ReasoningEffort::from_str "" → Err，P3-3）
  reasoningEffort: z.string().min(1).optional(),
  /** Stop grace period in milliseconds. */
  stopGraceMs: z.number().int().min(0).default(5000),
});

/** OpenCode-specific configuration (run mode: opencode run --format json --auto). */
const OpencodeConfigSchema = z.object({
  /** Provider ID for the LLM backend (e.g. 'anthropic'). */
  providerID: z.string().default('anthropic'),
  /** Model ID for the LLM backend (e.g. 'claude-sonnet-4-20250514'). */
  modelID: z.string().default('claude-sonnet-4-20250514'),
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

/** Kimi-specific configuration. kimi is a spawn-per-message CLI. */
const KimiConfigSchema = z.object({
  /** Model ID or alias, e.g. 'kimi-code/k3'. */
  model: z.string().default('kimi-code/k3'),
  /** Thinking effort: 'on', 'max'. */
  thinkingEffort: z.enum(KIMI_THINKING_EFFORTS).default('max'),
});

/** Agents configuration: per-agent settings keyed by agent kind. */
const AgentsConfigSchema = z.object({
  codex: CodexConfigSchema.optional(),
  opencode: OpencodeConfigSchema.optional(),
  pi: PiConfigSchema.optional(),
  kimi: KimiConfigSchema.optional(),
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
});

export const AppConfigSchema = z.object({
  feishu: FeishuConfigSchema,
  /** Claude config (top-level; other agents live under `agents`). */
  claude: ClaudeConfigSchema.default(ClaudeConfigSchema.parse({})),
  /** Per-agent configuration for non-claude agents. */
  agents: AgentsConfigSchema.optional(),
  /** Agent-specific saved choices for quick switching. */
  agentChoices: AgentChoicesSchema.optional(),
  idle: IdleConfigSchema.default(IdleConfigSchema.parse({})),
  output: OutputConfigSchema.default(OutputConfigSchema.parse({})),
  logging: LoggingConfigSchema.default(LoggingConfigSchema.parse({})),
  /** Default agent for new runs. */
  defaultAgent: z.enum(['claude', 'codex', 'opencode', 'pi', 'kimi']).default('claude'),
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
const AGENT_PREFIXES = ['pi', 'codex', 'opencode', 'kimi'] as const;

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

/** 在对象上按 dot-separated key 设置嵌套值（仅修改内存对象，不写盘）。 */
function setNestedValue(target: AppConfig, key: string, value: unknown): void {
  const parts = key.split('.');
  let current: Record<string, unknown> = target as unknown as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    assertSafeKeyPart(parts[i]);
    const next = current[parts[i]];
    if (next == null || typeof next !== 'object') {
      current[parts[i]] = {};
    }
    current = current[parts[i]] as Record<string, unknown>;
  }
  const lastPart = parts[parts.length - 1];
  assertSafeKeyPart(lastPart);
  current[lastPart] = value;
}

/** Get a nested value from config by dot-separated key, e.g. "feishu.appId" */
export function getConfigValue(config: AppConfig, key: string): unknown {
  const parts = key.split('.');
  let current: Record<string, unknown> = config as unknown as Record<string, unknown>;
  for (const part of parts) {
    assertSafeKeyPart(part);
    if (current == null || typeof current !== 'object') return undefined;
    current = current[part] as Record<string, unknown>;
  }
  return current;
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
  let current: Record<string, unknown> = target as unknown as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    assertSafeKeyPart(parts[i]);
    const next = current[parts[i]];
    if (next == null || typeof next !== 'object') return;
    current = next as Record<string, unknown>;
  }
  const lastPart = parts[parts.length - 1];
  assertSafeKeyPart(lastPart);
  delete current[lastPart];
}

/** Type helpers for agent config (used by getAgentConfig). */
type ClaudeConfig = z.infer<typeof ClaudeConfigSchema>;
type CodexConfig = z.infer<typeof CodexConfigSchema>;
type OpencodeConfig = z.infer<typeof OpencodeConfigSchema>;
type PiConfig = z.infer<typeof PiConfigSchema>;
type KimiConfig = z.infer<typeof KimiConfigSchema>;

/** Get configuration for a specific agent. Falls back to defaults if not configured. */
export function getAgentConfig(config: AppConfig, kind: 'claude'): ClaudeConfig;
export function getAgentConfig(config: AppConfig, kind: 'codex'): CodexConfig | undefined;
export function getAgentConfig(config: AppConfig, kind: 'opencode'): OpencodeConfig | undefined;
export function getAgentConfig(config: AppConfig, kind: 'pi'): PiConfig | undefined;
export function getAgentConfig(config: AppConfig, kind: 'kimi'): KimiConfig | undefined;
export function getAgentConfig(
  config: AppConfig,
  kind: AgentKind,
): ClaudeConfig | CodexConfig | OpencodeConfig | PiConfig | KimiConfig | undefined {
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
