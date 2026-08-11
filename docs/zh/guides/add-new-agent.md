[English](../../en/guides/add-new-agent.md) | 简体中文

# 新增 Agent 接入模板

> 本文档描述将新 agent 接入 lark-remote 所需的完整 10 步操作。
> 按照本模板操作，可以验证架构扩展性，确保添加新 agent 时无需修改 router 逻辑代码。

## 概述

lark-remote 采用多 agent 架构设计，通过以下三个 registry 实现可插拔接入：

1. **AgentRegistry** (`src/runner/registry.ts`) - runner 工厂注册中心
2. **SessionReaderRegistry** (`src/session/registry.ts`) - session reader 注册中心
3. **ConfigBuilderRegistry** (`src/router/config/index.ts`) - 配置卡片构建器注册中心

添加新 agent 只需在对应 registry 注册，无需修改 router 或 bridge 的逻辑代码。

## 完整 10 步接入流程

### 步骤 1: 创建 Runner 实现

创建 `src/runner/<agent>/runner.ts`，实现 `AgentRunner` 接口：

```typescript
import type {
  AgentEvent,
  AgentRunner,
  AgentSessionReader,
  SpawnOptions,
  AgentStatusInfo,
  AgentKind,
} from '../types.js';

export class <Agent>Runner implements AgentRunner {
  readonly kind: AgentKind = '<agent>';
  readonly sessionReader: AgentSessionReader;

  constructor(config: <Agent>RunnerConfig) {
    this.sessionReader = new <Agent>SessionReader(config);
  }

  get isRunning(): boolean { /* ... */ }

  async *run(message: string, opts: SpawnOptions): AsyncGenerator<AgentEvent> {
    // 实现运行逻辑，产生事件流
    yield { type: 'system', subtype: 'init', /* ... */ };
    yield { type: 'assistant', /* ... */ };
    yield { type: 'result', subtype: 'success', /* ... */ };
  }

  async stop(opts?: { immediate?: boolean }): Promise<void> { /* ... */ }
  killOrphan(): void { /* ... */ }
  registerExitHandlers(): void { /* ... */ }
  getStatusInfo(): AgentStatusInfo { /* ... */ }
}
```

### 步骤 2: 创建 Runner 模块入口

创建 `src/runner/<agent>/index.ts`：

```typescript
export { <Agent>Runner, type <Agent>RunnerConfig } from './runner.js';
```

### 步骤 3: 创建 Session Reader 实现

创建 `src/session/<agent>/sessions.ts`，实现 `AgentSessionReader` 接口：

```typescript
import type {
  AgentSession,
  AgentSessionReader,
  SessionContent,
} from '../types.js';

export class <Agent>SessionReader implements AgentSessionReader {
  listSessions(
    cwd: string,
    opts?: { limit?: number; offset?: number },
  ): { sessions: AgentSession[]; total: number } {
    // 列出指定 cwd 下的 session（mtime 倒序分页，total 为全量数）
  }

  getNewestSession(cwd: string): AgentSession | null {
    // 获取最新 session
  }

  readSessionContent(
    sessionId: string,
    cwd: string,
    opts?: { maxEvents?: number }
  ): SessionContent {
    // 读取 session 内容
  }

  isSessionActive(sessionId: string, cwd: string): boolean {
    // 检查 session 是否活跃
  }
}
```

### 步骤 4: 创建 Session Reader 模块入口

创建 `src/session/<agent>/index.ts`：

```typescript
export { <Agent>SessionReader } from './sessions.js';
```

### 步骤 5: 创建 Config Card Builder 实现

创建 `src/router/config/<agent>.ts`，实现 `AgentConfigCardBuilder` 接口：

```typescript
import type { AgentConfigCardBuilder, ConfigField } from './types.js';
import type { AppConfig } from '../../config/index.js';

export class <Agent>ConfigBuilder implements AgentConfigCardBuilder {
  buildFields(config: AppConfig, displayConfig: AppConfig): ConfigField[] {
    const fields: ConfigField[] = [];
    const agentConfig = config.agents?.<agent> ?? {};

    // 添加配置字段
    fields.push({
      key: 'agents.<agent>.model',
      label: '使用模型',
      type: 'select',
      options: ['model-a', 'model-b'],
      currentValue: agentConfig.model,
    });

    return fields;
  }

  handleFieldChange(
    key: string,
    value: unknown,
    config: AppConfig,
  ): Array<{ key: string; value: unknown }> {
    return [{ key, value }];
  }
}
```

### 步骤 6: 在 Runner Registry 注册

在 `src/runner/registry.ts` 无需修改（registry 本身支持任意 agent）。

在 `src/index.ts` 的 `initializeRunner` 函数中注册：

```typescript
agentRegistry.register('<agent>', (_workspace: string) => {
  const container = agentRegistry.getConfigContainer();
  const latestConfig = container?.current as AppConfig;
  const agentConfig = getAgentConfig(latestConfig, '<agent>');
  
  return new <Agent>Runner({
    model: agentConfig?.model,
    // ... 其他配置
    pidDir: configDir,
    sessionReader: agentSessionReader,
  });
});
```

### 步骤 7: 在 Session Reader Registry 注册

在 `src/index.ts` 中：

```typescript
const agentSessionReader = new <Agent>SessionReader({ /* 配置 */ });
sessionReaderRegistry.register('<agent>', agentSessionReader);
```

### 步骤 8: 在 Config Builder Registry 注册

在 `src/router/config/index.ts` 中：

```typescript
import { <Agent>ConfigBuilder } from './<agent>.js';

const builders: Record<AgentKind, AgentConfigCardBuilder> = {
  // ... 其他 agent
  '<agent>': new <Agent>ConfigBuilder(),
};
```

### 步骤 9: 在 AgentKind 类型添加新字面量

在 `src/runner/types.ts` 中修改 `AgentKind` 类型：

```typescript
export type AgentKind = 'claude' | 'codex' | 'opencode' | 'pi' | 'kimi' | '<agent>';
```

### 步骤 10: 在配置函数添加分支

在 `src/runner/resolve-agent-choices.ts` 的 `resolveAgentChoices` 函数的 switch 语句中添加：

```typescript
case '<agent>':
  if (!resolvedAny.agents) resolvedAny.agents = {};
  if (!resolvedAny.agents.<agent>) resolvedAny.agents.<agent> = {};
  if (!resolvedAny.agents.<agent>.model && agentChoicesAny.model) {
    resolvedAny.agents.<agent>.model = agentChoicesAny.model;
  }
  break;
```

在 `src/runner/sync-agent-choices.ts` 中同样添加：

```typescript
case '<agent>':
  if (agentCfg.model) {
    if (!updatedAny.agentChoices.<agent>) updatedAny.agentChoices.<agent> = {};
    updatedAny.agentChoices.<agent>.model = agentCfg.model;
  }
  break;
```

## 验证方法

完成上述 10 步后，运行以下验证：

```bash
# 1. 类型检查
bun run typecheck

# 2. 运行测试
bun run test

# 3. 验证 registry 注册
node -e "
import { AgentRegistry } from './src/runner/registry.js';
import { SessionReaderRegistry } from './src/session/registry.js';
import { getConfigBuilder } from './src/router/config/index.js';

const agentReg = new AgentRegistry();
const sessionReg = new SessionReaderRegistry();

console.log('AgentRegistry 支持的 agent:', agentReg.listRegistered());
console.log('SessionReaderRegistry 支持的 agent:', sessionReg.listRegistered());

// 验证 config builder
const builder = getConfigBuilder('<agent>');
console.log('Config builder:', builder.constructor.name);
"
```

## 常见问题

### Q: 添加新 agent 需要修改 router 逻辑代码吗？

**不需要**。只要正确实现接口并在 registry 注册，router 会自动通过 registry 动态获取对应组件。

### Q: 如何测试新添加的 agent？

1. 在 `src/index.ts` 中注册新 agent
2. 直接发普通消息、`/resume`、`/active`、`/config` 命令测试

### Q: 新 agent 需要支持所有命令吗？

新 agent 只需实现 `AgentRunner` 接口的核心方法（`run`/`stop`/`getStatusInfo` 等）。
未实现的命令（如 `/steer` `/compact` `/fork`）已在 router 层移除，无需关心。

### Q: 如何确保新 agent 的配置不会导致保存失败？

参考配置保存的三层防御设计：
1. Schema 枚举常量（单一真相源）
2. 外部 CLI 加载时 filter
3. UI builder 双重防御 filter
