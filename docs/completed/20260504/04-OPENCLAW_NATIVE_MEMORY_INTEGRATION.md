# OpenClaw 原生记忆接管与 Vulcan 适配计划

## 任务目标

当前 `vulcan-memory` 仍主要依赖旁路工具与 hooks 完成记忆召回和写回，尚未按 OpenClaw 原生 memory takeover 体系提供完整的 `MemoryPluginCapability.runtime`。本任务目标是：

1. 基于 OpenClaw 现有记忆框架，完成 `vulcan-memory` 的原生记忆接管实现。
2. 保留现有 `vulcan_memory_search` / `vulcan_memory_get` 作为可见侧车工具，但不再把它们当作主链路。
3. 梳理综合处理模式下，`vulcan-host / MCP` 仍需补充或调整的能力边界，为后续宿主统一接入做准备。

## 执行步骤

1. 阅读并梳理 OpenClaw 当前 `MemoryPluginCapability`、`MemoryPluginRuntime`、`MemorySearchManager`、`memory-core` 相关实现与测试，确认原生接管链路的最低接口要求。
2. 审查当前 `vulcan-memory` 插件入口、memory capability、hooks、旁路工具和 shared gRPC client，定位和 OpenClaw 原生记忆框架的差距。
3. 在 `vulcan-memory` 中实现原生 `MemorySearchManager` 适配层，使 OpenClaw 能通过 memory runtime 使用 Vulcan 记忆，而不是只依赖旁路工具。
4. 调整 prompt builder、runtime backend config、manager 生命周期收口逻辑，确保与 OpenClaw 的 memory slot 语义保持一致。
5. 重新评估 hooks 的职责边界：保留对 OpenClaw 原生框架有价值的部分，剥离和主链路冲突或重复的部分。
6. 结合实现结果，整理 `vulcan-host / MCP` 当前已足够的能力和仍需新增的能力清单，重点关注 session/project/user 映射、precheck/postaction、枚举元信息与结构化写入约束。
7. 运行类型检查与必要校验，完成自检后在本文件追加执行变更总结。

## 技术选型

- 以 OpenClaw 原生 `MemoryPluginCapability.runtime` 为主，不继续扩大旁路工具模式。
- 通过插件内部适配器把 Vulcan gRPC 能力包装成 OpenClaw 可消费的 `MemorySearchManager`。
- 将 `vulcan-host` 继续视为统一能力入口；若 OpenClaw 原生记忆链路缺必要信息，再反推 `vulcan-host / MCP` 接口补充，而不是在插件侧堆积宿主特例。
- 对高风险的持久化写入维持保守策略，优先保证召回、读取、会话上下文和生命周期闭环正确。

## 验收标准

1. `vulcan-memory` 不再返回空的 `manager: null` 占位实现，而是具备可用的原生 memory runtime 适配。
2. OpenClaw 记忆槽位可通过该插件拿到可用的 memory manager，并保留现有 prompt 指导与侧车工具能力。
3. 自动 recall / postaction 的职责边界清晰，不与原生 memory takeover 冲突。
4. 代码通过当前仓库的类型检查或等效校验。
5. 形成一份明确的 `vulcan-host / MCP` 后续调整结论，便于下一阶段继续推进。

## 执行变更总结

### 1. 核心修复与调整概述

本轮已把 `vulcan-memory` 从“memory slot 占位 + sidecar 工具”升级为“OpenClaw 原生 memory slot + canonical memory tools + full-mode hooks”的完整形态。具体来说：

- `MemoryPluginCapability.runtime.getMemorySearchManager` 不再返回空 manager，而是会构造可用的原生 `VulcanMemorySearchManager`。
- 新增 canonical `memory_search` / `memory_get`，让 OpenClaw 通过标准记忆工具入口使用 Vulcan 记忆。
- 保留 `vulcan_memory_search` / `vulcan_memory_get` 作为分组式 VMM 兼容工具，方便保留原有操作流。
- `before_prompt_build` 由简单旁路搜索升级为优先走 VMM `PreCheck`，并在缺少稳定 session 时降级到 grouped search。
- `agent_end` 写回由直接 `vmm_memory_write` 草图升级为 VMM `PostAction`，与完整模式职责更一致。
- shared gRPC client 已补齐 `BuildHostAdapterRuntime` 与原始 `VMMService` 调用能力，插件可直接完成 OpenClaw -> VMM 的原生记忆接管链路。

### 2. 📂文件变更清单

新增文件：

- `packages/vulcan-memory/src/vmm-scope.ts`
- `packages/vulcan-memory/src/manager.ts`

修改文件：

- `packages/shared/src/types.ts`
- `packages/shared/src/context.ts`
- `packages/shared/src/vulcan-host-client.ts`
- `packages/shared/src/grpc-vulcan-host-client.ts`
- `packages/vulcan-memory/src/memory-capability.ts`
- `packages/vulcan-memory/src/hooks.ts`
- `packages/vulcan-memory/src/tools.ts`
- `packages/vulcan-memory/src/index.ts`
- `packages/vulcan-memory/src/sync-vmm-tools.ts`
- `types/openclaw-sdk.d.ts`
- `README.md`

删除文件：

- 无独立删除；原有 `memory-capability.ts`、`hooks.ts`、`tools.ts` 已按同路径重写。

### 3. 💻关键代码调整详情

1. shared 层新增了 `VulcanHostAdapterRuntime`、VMM user/project/search/turn/precheck/postaction 等结构化类型，并将 `DynamicGrpcVulcanHostClient` 扩展为同时加载 `mcp_service.proto` 与 `vmm.proto`。
2. shared client 现在支持：
   - `buildHostAdapterRuntime`
   - `resolveVmmUser`
   - `ensureVmmProject`
   - `searchVmmMemories`
   - `getVmmTurnDetails`
   - `preCheckVmm`
   - `postActionVmm`
3. 新增 `vmm-scope.ts`，实现 OpenClaw 上下文到 VMM `userRef / Team/Space/Project` 的确定性映射规则：
   - workspace 优先映射项目路径
   - channel / conversation / session 次级回退
   - requester/account/session/agent 组合映射用户引用
4. 新增 `manager.ts`，实现原生 `VulcanMemorySearchManager`：
   - `search` 将 VMM 命中映射为 OpenClaw `MemorySearchResult`
   - `readFile` 支持 `vulcan-turns/<id>.md` 与 `vulcan-memories/<id>.md`
   - `status/probe/sync/close` 提供原生 memory runtime 所需的最小闭环
5. `memory-capability.ts` 已改为真正创建 native manager，并通过 `api.runtime.agent.resolveAgentWorkspaceDir` 优先获取 agent workspace。
6. `tools.ts` 新增 canonical `memory_search` / `memory_get`，并保留 grouped compatibility 工具：
   - `vulcan_memory_search`
   - `vulcan_memory_get`
7. `hooks.ts` 已从旧的直接 `callMcpTool(vmm_memory_search / vmm_memory_write)` 迁移到：
   - `PreCheck` + grouped-search fallback
   - `PostAction`

### 4. ⚠️遗留问题与注意事项

1. 当前 OpenClaw 插件虽然已经可以完整接管自己的 native memory slot，但 `vulcan-host` 仍未提供“trusted host context -> resolved VMM user_id/project_id/session_id”的统一 relay。因此：
   - OpenClaw 现在通过插件侧 deterministic mapping 打通。
   - Claude Code / Qwen / Hermes 若要进入同等 full-mode，后续仍建议在 `vulcan-host` 内补统一 host-aware VMM relay。
2. native manager 路径目前主要依赖 `agentId + workspaceDir + sessionKey` 等宿主信号，不等同于未来统一 relay 的最终身份策略。后续若 host 侧补齐 relay，建议把插件侧 deterministic mapping 下沉或收敛到 host。
3. canonical `memory_search` / `memory_get` 已具备原生可用性，但 `wiki`/`all` 语义目前未像 `memory-core` 那样对接补充语料，仅对 Vulcan/VMM 记忆面生效。
4. 本轮仅完成了静态校验：`pnpm check` 已通过，但尚未在真实 OpenClaw Gateway + vulcan-host + VMM 联调环境下做端到端实测。
