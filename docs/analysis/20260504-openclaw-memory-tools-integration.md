# OpenClaw 记忆与工具接入分析

## 一、当前结论

OpenClaw 源码已按要求强制更新到最新远端状态：

- 仓库：`OpenClaw`
- 分支：`main`
- 最新提交：`feb9a5af6a fix(plugins): scope commands to channels`
- 状态：`main...origin/main`，工作区干净

综合源码、官方文档和现有 vulcan-host 方案判断，OpenClaw 接入不应该以 MCP 作为完整主路径。推荐采用：

- 工具层：OpenClaw 原生插件工具为主，MCP/单 dispatcher 仅作为降级路径。
- 记忆层：OpenClaw 原生 memory 插件 + hooks 为主，通过 vulcan-host gRPC 中转 VMM，不直接连接 VMM。
- 动态工具：通过 vulcan-host 同步 LuaSkills 列表后生成 OpenClaw manifest 与工具注册代码，再触发 OpenClaw registry refresh 或重启网关。
- 会话注入：利用 OpenClaw hook context 中的 `sessionKey`、`sessionId`、`agentId`、`workspaceDir` 自动补齐 Vulcan session/workmem 上下文。

一句话结论：OpenClaw 的插件体系比 OpenCode 更适合做完整 Vulcan 接入，但它的工具列表仍然不是任意运行时动态注册模型，需要以“静态 manifest 同步 + 原生 runtime proxy”的方式解决。

## 二、OpenClaw 工具机制判断

### 2.1 工具不是完全动态注册

OpenClaw 插件工具需要同时满足两层条件：

- manifest 中通过 `contracts.tools` 声明工具所有权。
- 插件运行时通过 `api.registerTool(...)` 注册同名工具。

关键依据：

- `OpenClaw\src\plugins\registry.ts:486` 开始处理 `registerTool`。
- `OpenClaw\src\plugins\registry.ts:494` 读取 manifest 声明的工具名。
- `OpenClaw\src\plugins\registry.ts:495-503` 在没有 `contracts.tools` 时拒绝注册。
- `OpenClaw\src\plugins\registry.ts:514-525` 在工具名未声明时拒绝注册。
- `OpenClaw\docs\plugins\manifest.md:662-663` 明确运行时注册必须匹配 `contracts.tools`。

因此，LuaSkills 中 install/uninstall/update 导致工具 ID 变化时，OpenClaw 不能只靠运行时 gRPC 返回新列表来直接新增任意工具。更稳妥的方式是：

1. vulcan-host 暴露 LuaSkills 当前工具清单。
2. OpenClaw 插件同步命令读取清单。
3. 生成或更新 `openclaw.plugin.json` 的 `contracts.tools`。
4. 生成或更新 runtime 侧注册表。
5. 提醒用户执行 `openclaw plugins registry --refresh`，必要时重启 Gateway 或重新安装/link 插件。

### 2.2 工具描述可以完整同步

OpenClaw 的工具 descriptor 可以携带名称、描述、参数 schema。相比当前 OpenCode 中 LuaSkills 工具说明未完整同步给 AI 的问题，OpenClaw 这里应直接把 vulcan-host 返回的工具说明映射为 OpenClaw tool descriptor：

- `description` 映射 LuaSkills 工具描述。
- `parameters` 映射 LuaSkills JSON schema。
- 参数字段描述必须保留，避免 AST 工具那类“paths 无描述”的问题再次出现。
- VMM 相关枚举、category、memoryLevel、priority 等不应由插件硬编码，应由 vulcan-host 从 VMM 端读取后统一生成 schema 描述。

工具代理运行时只做上下文补齐和调用转发，不应该自己解释 VMM 业务枚举。

### 2.3 单 dispatcher 只能作为降级

可以保留一个类似 `vulcan_luaskill_call` 的低保真 dispatcher 工具，用于调试或 OpenClaw 未刷新 manifest 时的临时调用。但它不适合作为主路径：

- AI 看不到每个 LuaSkill 的独立描述。
- OpenClaw 无法对每个工具做独立 allow/deny。
- 审计、缓存、权限、工具选择质量都会下降。
- 与 OpenClaw 原生工具生态不一致。

因此主路径应坚持 per-tool 原生注册。

## 三、OpenClaw 记忆机制判断

### 3.1 推荐实现为 OpenClaw memory 插件

OpenClaw 存在原生 memory capability：

- `OpenClaw\src\plugins\memory-state.ts:128-133` 定义 `MemoryPluginCapability`。
- `OpenClaw\src\plugins\memory-state.ts:164-169` 注册 active memory capability。
- `OpenClaw\src\plugins\memory-runtime.ts:56-65` 从 runtime 解析 active memory manager。
- `OpenClaw\extensions\memory-core\index.ts:170-181` 是官方 memory-core 的注册示例。

Vulcan 记忆接入应新增一个 `kind: "memory"` 插件，例如 `vulcan-memory`。它通过 `api.registerMemoryCapability(...)` 提供 OpenClaw 期望的 memory runtime，但底层不直接连接 VMM，而是统一调用 vulcan-host gRPC。

这能满足当前架构目标：

- 插件不直连 VMM。
- VMM 是否启用由 vulcan-host 暴露。
- 没有 VMM 时插件可关闭记忆工具或返回明确 disabled 状态。
- session/workmem 自动由 OpenClaw hook/tool context 注入。

### 3.2 记忆工具命名建议

如果 Vulcan 作为 OpenClaw active memory slot，建议优先复用 OpenClaw canonical 工具名：

- `memory_search`
- `memory_get`

原因：

- OpenClaw 默认提示词和生态会围绕这些工具名组织。
- 官方 memory-core 也是这样暴露。
- AI 不需要额外学习一套完全不同的记忆工具。

但这会带来一个约束：同一时间应由 `plugins.slots.memory = "vulcan-memory"` 选择 Vulcan memory 插件，避免和 memory-core 同时争用 canonical memory 工具。

如果用户希望保留 memory-core，同时只让 Vulcan 作为旁路能力，则可以采用 sidecar 模式：

- 暴露 `vulcan_memory_search`
- 暴露 `vulcan_memory_write`
- 通过 hooks 注入 Vulcan active recall

sidecar 模式集成度较低，但不会替换 OpenClaw 默认记忆。

### 3.3 precheck 与 postaction 可行

OpenClaw 提供多种 hook，可以覆盖我们之前讨论的 precheck、postaction、工具前后拦截：

- `before_prompt_build`：适合每轮构建 prompt 前做 VMM precheck/active recall 并返回 `prependContext`。
- `agent_turn_prepare`：适合处理下一轮注入、单轮注入、queued injection。
- `before_tool_call`：适合调用工具前补齐参数、阻断调用、做权限检查。
- `after_tool_call`：适合记录工具结果、触发轻量 postaction。
- `agent_end`：适合在回合结束后做记忆写入、摘要、审计。
- `before_agent_reply`：适合需要在最终回复前做强干预的场景，但应慎用。

关键依据：

- `OpenClaw\src\plugins\hook-types.ts:155-160` 定义 prompt 注入类 hook。
- `OpenClaw\src\plugins\hook-before-agent-start.types.ts:22-42` 定义 `before_prompt_build` 可返回的 prompt 修改字段。
- `OpenClaw\src\plugins\host-hook-turn-types.ts:29-38` 定义 `agent_turn_prepare` 的上下文注入结果。
- `OpenClaw\src\plugins\hook-types.ts:403-434` 定义 `before_tool_call`。
- `OpenClaw\src\plugins\hook-types.ts:436-444` 定义 `after_tool_call`。

因此，OpenClaw 相比 Claude Code 这类偏 MCP 的宿主，更适合做完整模式接入。

### 3.4 session/workmem 映射建议

OpenClaw hook/tool context 可拿到：

- `sessionKey`
- `sessionId`
- `agentId`
- `workspaceDir`
- `runId`
- `channelId`

建议映射方式：

- `sessionKey` 作为 Vulcan workmem/session 的主稳定 ID。
- `sessionId` 作为 OpenClaw 当前会话实例 ID，用于追踪 `/new`、`/reset` 等会话变体。
- `agentId + sessionKey` 可作为跨 agent 隔离后的 Vulcan workmem 命名空间。
- `workspaceDir` 用于项目级记忆作用域。

不要让 AI 手动传 `VULCANMEM_ID`。插件应在工具代理和 hook 调用时自动补齐。

## 四、MCP 与 vulcan-host 的边界

当前判断仍然保持此前的大方向：插件端不应该直接连 VMM，而应连接 vulcan-host。

推荐职责划分：

- VMM：记忆服务本体。
- LuaSkills：工具运行时与工具库。
- vulcan-host：统一 gRPC 中转、MCP 降级、LuaSkills 工具清单、VMM 状态、schema/枚举描述合成。
- OpenClaw 插件：宿主适配层，只负责 OpenClaw manifest、hooks、tool proxy、memory capability、session context 注入。

因此 OpenClaw 插件内不应复制 VMM 业务知识。尤其是 VMM 参数枚举、预算、客户端 profile、工具说明等，都应由 vulcan-host 统一给出。

## 五、推荐目录结构

建议 `this plugin repository` 采用如下结构：

```text
this plugin repository
├── docs
│   ├── analysis
│   ├── completed
│   └── plan
├── packages
│   ├── shared
│   │   ├── src
│   │   │   ├── config
│   │   │   ├── grpc
│   │   │   ├── schema
│   │   │   └── session
│   │   └── package.json
│   ├── vulcan-tools
│   │   ├── src
│   │   │   ├── generated
│   │   │   ├── sync
│   │   │   └── runtime
│   │   ├── openclaw.plugin.json
│   │   └── package.json
│   └── vulcan-memory
│       ├── src
│       │   ├── hooks
│       │   ├── memory
│       │   └── runtime
│       ├── openclaw.plugin.json
│       └── package.json
```

如果后续为了发布便利需要单插件包，也可以将 `vulcan-tools` 与 `vulcan-memory` 合并到一个插件目录中，但逻辑上仍建议拆成两个模块。原因是 memory 插件有 `kind: "memory"` 和 slot 语义，而 tools 插件只是普通工具适配层。

## 六、建议开发顺序

1. 先实现 shared gRPC client。
   - 读取 vulcan-host endpoint。
   - 提供 `health/status/list_tools/call_tool/memory_status/memory_search/memory_get/precheck/postaction` 这类基础封装。
   - 所有请求统一携带 OpenClaw context。

2. 实现 tools sync。
   - 从 vulcan-host 获取 LuaSkills 工具清单。
   - 生成 `contracts.tools`。
   - 生成 runtime registry 映射。
   - 提供 OpenClaw command 或外部脚本触发同步。

3. 实现 tools runtime proxy。
   - `api.registerTool` 注册每个同步工具。
   - tool handler 自动附加 `sessionKey/sessionId/agentId/workspaceDir`。
   - 调用 vulcan-host gRPC。
   - 处理预算、错误、禁用状态。

4. 实现 memory plugin MVP。
   - 注册 `kind: "memory"`。
   - 实现 `registerMemoryCapability`。
   - 映射 `memory_search` 和 `memory_get`。
   - 根据 vulcan-host 返回的 VMM enabled 状态决定是否启用。

5. 实现 hook 注入。
   - `before_prompt_build` 做 precheck/active recall。
   - `agent_end` 做 postaction/writeback。
   - `before_tool_call` 做特殊工具参数补齐，例如替换 `VULCANMEM_ID`。

6. 最后再考虑 sidecar 和 MCP 降级。
   - 单 dispatcher 仅作调试/降级。
   - MCP 仅用于无插件宿主或极低配接入。

## 七、关键风险

### 7.1 动态工具刷新仍需要同步边界

OpenClaw 能做 registry refresh，但工具所有权来自 manifest。LuaSkills install/uninstall/update 后，应明确提示：

- 已同步工具 manifest。
- 需要刷新 OpenClaw registry。
- 必要时需要重启 Gateway 或新开回合。

不要承诺无感即时热插拔。

### 7.2 memory-core 替换需要用户明确配置

如果 Vulcan 使用 canonical `memory_search/memory_get`，需要用户选择 Vulcan 作为 active memory slot。否则可能与 memory-core 或其他 memory 插件冲突。

### 7.3 prompt injection 可能被宿主配置关闭

OpenClaw 支持 `hooks.allowPromptInjection=false` 禁止 prompt 注入。插件应在 status/diagnostics 中报告该状态，否则用户会误以为 VMM precheck 不生效。

### 7.4 不建议先做 context-engine

Context engine 能完整接管上下文组装，但它是更重的宿主级能力，且存在 slot/排他语义。Vulcan 初期目标是记忆和工具接入，因此优先 memory plugin + hooks，等需要接管压缩、上下文预算、长期编排时再考虑 context engine。

## 八、最终建议

OpenClaw 插件可以开始实现，而且优先级建议高于 Claude Code 类 MCP-only 宿主。原因是它能同时给到：

- 原生工具注册。
- 工具调用前后 hook。
- prompt 注入 hook。
- memory capability。
- sessionKey/sessionId 上下文。
- 插件 registry refresh。

这基本覆盖 Vulcan 完整模式所需的关键能力。唯一需要接受的边界是工具列表需要通过 manifest 同步，而不是完全运行时任意新增。
