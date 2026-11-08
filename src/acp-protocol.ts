/**
 * ACP 协议常量（src/ 根中立模块）。
 *
 * 为什么住在这里：`CODEBUDDY_CLIENT_CAPABILITIES` 同时被 `config` 层的
 * 目录探针和 `runner` 层的 ConnectionManager 使用。`tests/misc/import-direction.test.ts`
 * 禁止 `config/** → runner/**`，所以常量不能放在
 * `runner/common/acp/protocol-types.ts`（那里是 ACP 类型层，但仍属 runner 层）。
 * 本模块无 import、无行为，任何层都可以依赖，与 `agent-kinds.ts` /
 * `session-contract.ts` / `model-catalog.ts` 同一约定。
 */

/**
 * CodeBuddy 的 clientCapabilities：fs/terminal 均不声明 → 服务端本地自执行
 * （官方 ACP 集成文档的工具代理条款；声明 true 会改发 fs/*、terminal/*
 * reverse RPC，客户端未实现该面）。探针（config/codebuddy-catalog.ts）与
 * runner 共用这一份，改能力声明只需改这里。
 */
export const CODEBUDDY_CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
} as const;

/**
 * Qoder 的 clientCapabilities：与 CodeBuddy 同口径——fs/terminal 均不声明，
 * 工具由 CLI 本地自执行（客户端未实现 fs/*、terminal/* reverse RPC 面）。
 * 1.1.84 `qodercn --acp` initialize 握手实测通过。
 */
export const QODER_CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
} as const;
