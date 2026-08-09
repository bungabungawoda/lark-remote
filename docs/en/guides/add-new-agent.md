[简体中文](../../zh/guides/add-new-agent.md) | English

# Adding a New Agent — Integration Template

> This document describes the complete 10-step process for integrating a new agent into lark-remote.
> Following this template verifies the architecture's extensibility and ensures that adding a new agent requires no changes to router logic code.

## Overview

lark-remote uses a multi-agent architecture with pluggable integration via three registries:

1. **AgentRegistry** (`src/runner/registry.ts`) — runner factory registry
2. **SessionReaderRegistry** (`src/session/registry.ts`) — session reader registry
3. **ConfigBuilderRegistry** (`src/router/config/index.ts`) — config card builder registry

Adding a new agent only requires registering with the corresponding registries — no modifications to router or bridge logic code are needed.

## Complete 10-Step Integration Process

### Step 1: Create the Runner Implementation

Create `src/runner/<agent>/runner.ts` implementing the `AgentRunner` interface:

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
    // Implement run logic, yielding event streams
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

### Step 2: Create the Runner Module Entry

Create `src/runner/<agent>/index.ts`:

```typescript
export { <Agent>Runner, type <Agent>RunnerConfig } from './runner.js';
```

### Step 3: Create the Session Reader Implementation

Create `src/session/<agent>/sessions.ts` implementing the `AgentSessionReader` interface:

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
    // List sessions under the specified cwd (mtime-desc paginated, total = full count)
  }

  getNewestSession(cwd: string): AgentSession | null {
    // Get the newest session
  }

  readSessionContent(
    sessionId: string,
    cwd: string,
    opts?: { maxEvents?: number }
  ): SessionContent {
    // Read session content
  }

  isSessionActive(sessionId: string, cwd: string): boolean {
    // Check whether the session is active
  }
}
```

### Step 4: Create the Session Reader Module Entry

Create `src/session/<agent>/index.ts`:

```typescript
export { <Agent>SessionReader } from './sessions.js';
```

### Step 5: Create the Config Card Builder Implementation

Create `src/router/config/<agent>.ts` implementing the `AgentConfigCardBuilder` interface:

```typescript
import type { AgentConfigCardBuilder, ConfigField } from './types.js';
import type { AppConfig } from '../../config/index.js';

export class <Agent>ConfigBuilder implements AgentConfigCardBuilder {
  buildFields(config: AppConfig, displayConfig: AppConfig): ConfigField[] {
    const fields: ConfigField[] = [];
    const agentConfig = config.agents?.<agent> ?? {};

    // Add config fields
    fields.push({
      key: 'agents.<agent>.model',
      label: 'Model',
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

### Step 6: Register with the Runner Registry

No changes needed in `src/runner/registry.ts` (the registry itself supports arbitrary agents).

Register in the `initializeRunner` function in `src/index.ts`:

```typescript
agentRegistry.register('<agent>', (_workspace: string) => {
  const container = agentRegistry.getConfigContainer();
  const latestConfig = container?.current as AppConfig;
  const agentConfig = getAgentConfig(latestConfig, '<agent>');

  return new <Agent>Runner({
    binary: agentConfig?.binary ?? '<agent>',
    model: agentConfig?.model,
    // ... other config
    pidDir: configDir,
    sessionReader: agentSessionReader,
  });
});
```

### Step 7: Register with the Session Reader Registry

In `src/index.ts`:

```typescript
const agentSessionReader = new <Agent>SessionReader({ /* config */ });
sessionReaderRegistry.register('<agent>', agentSessionReader);
```

### Step 8: Register with the Config Builder Registry

In `src/router/config/index.ts`:

```typescript
import { <Agent>ConfigBuilder } from './<agent>.js';

const builders: Record<AgentKind, AgentConfigCardBuilder> = {
  // ... other agents
  '<agent>': new <Agent>ConfigBuilder(),
};
```

### Step 9: Add the New Literal to the AgentKind Type

Modify the `AgentKind` type in `src/runner/types.ts`:

```typescript
export type AgentKind = 'claude' | 'codex' | 'opencode' | 'pi' | 'kimi' | '<agent>';
```

### Step 10: Add a Branch in the Config Functions

Add a case in the switch statement of `resolveAgentChoices` in `src/runner/resolve-agent-choices.ts`:

```typescript
case '<agent>':
  if (!resolvedAny.agents) resolvedAny.agents = {};
  if (!resolvedAny.agents.<agent>) resolvedAny.agents.<agent> = {};
  if (!resolvedAny.agents.<agent>.model && agentChoicesAny.model) {
    resolvedAny.agents.<agent>.model = agentChoicesAny.model;
  }
  break;
```

Similarly add in `src/runner/sync-agent-choices.ts`:

```typescript
case '<agent>':
  if (agentCfg.model) {
    if (!updatedAny.agentChoices.<agent>) updatedAny.agentChoices.<agent> = {};
    updatedAny.agentChoices.<agent>.model = agentCfg.model;
  }
  break;
```

## Verification

After completing the 10 steps above, run the following verifications:

```bash
# 1. Type check
bun run typecheck

# 2. Run tests
bun run test

# 3. Verify registry registration
node -e "
import { AgentRegistry } from './src/runner/registry.js';
import { SessionReaderRegistry } from './src/session/registry.js';
import { getConfigBuilder } from './src/router/config/index.js';

const agentReg = new AgentRegistry();
const sessionReg = new SessionReaderRegistry();

console.log('AgentRegistry supported agents:', agentReg.listRegistered());
console.log('SessionReaderRegistry supported agents:', sessionReg.listRegistered());

// Verify config builder
const builder = getConfigBuilder('<agent>');
console.log('Config builder:', builder.constructor.name);
"
```

## FAQ

### Q: Does adding a new agent require modifying router logic code?

**No.** As long as you correctly implement the interfaces and register with the registries, the router automatically obtains the corresponding components via the registries at runtime.

### Q: How do I test a newly added agent?

1. Register the new agent in `src/index.ts`
2. Test by sending a normal message, `/resume`, `/active`, `/config` commands

### Q: Does a new agent need to support all commands?

A new agent only needs to implement the core methods of the `AgentRunner` interface (`run`/`stop`/`getStatusInfo`, etc.).
Unimplemented commands (such as `/steer`, `/compact`, `/fork`) have already been removed at the router layer and require no attention.

### Q: How can I ensure the new agent's config won't cause save failures?

Refer to the three-layer defense design used for config saving:
1. Schema enum constants (single source of truth)
2. External CLI load-time filter
3. UI builder dual-defense filter
