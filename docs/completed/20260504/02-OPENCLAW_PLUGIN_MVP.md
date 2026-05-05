# OpenClaw Vulcan 插件 MVP 实现计划

## 任务目标

在 `D:\projects\vulcan-openclaw-plugins` 中落地 OpenClaw 插件的第一版可维护代码骨架，实现面向 vulcan-host 的工具代理、记忆代理、配置读取、会话上下文封装与插件入口，为后续接入真实 gRPC 协议和 LuaSkills 动态同步打基础。

## 详细执行步骤

1. 检查 OpenClaw 最新插件 SDK 文档与示例，确认 `definePluginEntry`、`api.registerTool`、`api.registerCommand`、`api.registerMemoryCapability`、hooks 的实际使用形态。
2. 建立插件仓库基础工程文件，包括 `package.json`、`tsconfig.json`、`.gitignore`、`README.md` 与源码目录。
3. 新增 `packages/shared`，封装 vulcan-host endpoint 配置、OpenClaw 运行上下文转换、禁用状态、工具结果格式与占位 gRPC client。
4. 新增 `packages/vulcan-tools`，实现 OpenClaw 普通插件入口、manifest、工具管理命令与低保真 dispatcher 工具。
5. 新增 `packages/vulcan-memory`，实现 OpenClaw memory 插件入口、manifest、记忆搜索/读取代理工具与 prompt/postaction hook 骨架。
6. 确保所有新增 TypeScript 源码文件、类型、函数和关键逻辑块满足仓库双语注释规范。
7. 执行静态检查或至少 TypeScript 编译检查，记录不能执行的原因。
8. 对照计划自检，追加执行变更总结并迁移到 `docs/completed/20260504/`。

## 技术选型

- 使用 TypeScript ESM，与 OpenClaw 插件 SDK 示例保持一致。
- 第一阶段不直接生成真实 protobuf client，先通过 `VulcanHostClient` 接口和 HTTP/JSON 占位实现隔离协议细节，方便后续替换为真实 gRPC/Connect 客户端。
- 工具层第一版仅提供 `vulcan_luaskill_call` dispatcher、`vulcan_luaskill_list`、`vulcan_luaskill_sync` 控制命令，后续再由 sync 生成 per-tool manifest。
- 记忆层第一版以 `vulcan_memory_search`、`vulcan_memory_get`、hooks 骨架落地，避免立刻与 OpenClaw 默认 `memory_search`/`memory_get` 冲突。
- 所有 VMM 业务枚举和工具 schema 描述均预留从 vulcan-host 获取，不在插件端硬编码解释。

## 验收标准

1. 插件仓库具备可理解的 monorepo/package 结构。
2. tools 插件具备 OpenClaw manifest、入口代码、控制命令和 dispatcher 工具。
3. memory 插件具备 OpenClaw manifest、入口代码、memory capability 占位、prompt/postaction hook 骨架和记忆工具代理。
4. shared 模块能统一读取 endpoint、构建宿主上下文、检查 vulcan-host 状态、格式化 OpenClaw 工具结果。
5. 新增源码满足中英文双语注释规范。
6. 能执行的静态检查完成；若当前缺少依赖或 SDK 类型无法解析，需要明确记录。

## 执行变更总结

### 1. 核心修复与调整概述

已在 `D:\projects\vulcan-openclaw-plugins` 中落地 OpenClaw 插件 MVP 代码。当前结构包含根 workspace、共享层、LuaSkills 工具插件和 Vulcan memory 插件。共享层已经实现基于 `@grpc/grpc-js` 与 `@grpc/proto-loader` 的动态 gRPC 客户端，可调用 `McpService.Call`、`LuaSkillsService` 与 `HostAdapterService`，并默认连接 vulcan-host `127.0.0.1:19202`。

本轮选择 sidecar memory 模式作为第一阶段落点：`vulcan-memory` 先暴露 `vulcan_memory_search` 与 `vulcan_memory_get`，避免立即抢占 OpenClaw 默认 `memory_search/memory_get`。同时注册 `kind: "memory"` 与 memory capability 占位，为下一阶段 canonical memory slot 接入保留路径。`vulcan-tools` 先提供低保真 `vulcan_luaskill_call` dispatcher 与 `/vulcan` 管理命令，per-tool manifest 生成留到下一阶段。

### 2. 📂文件变更清单

- 新增：`D:\projects\vulcan-openclaw-plugins\.gitignore`
- 新增：`D:\projects\vulcan-openclaw-plugins\.npmrc`
- 新增：`D:\projects\vulcan-openclaw-plugins\package.json`
- 新增：`D:\projects\vulcan-openclaw-plugins\pnpm-lock.yaml`
- 新增：`D:\projects\vulcan-openclaw-plugins\pnpm-workspace.yaml`
- 新增：`D:\projects\vulcan-openclaw-plugins\README.md`
- 新增：`D:\projects\vulcan-openclaw-plugins\tsconfig.base.json`
- 新增：`D:\projects\vulcan-openclaw-plugins\tsconfig.json`
- 新增：`D:\projects\vulcan-openclaw-plugins\types\openclaw-sdk.d.ts`
- 新增：`D:\projects\vulcan-openclaw-plugins\packages\shared\package.json`
- 新增：`D:\projects\vulcan-openclaw-plugins\packages\shared\src\config.ts`
- 新增：`D:\projects\vulcan-openclaw-plugins\packages\shared\src\context.ts`
- 新增：`D:\projects\vulcan-openclaw-plugins\packages\shared\src\grpc-vulcan-host-client.ts`
- 新增：`D:\projects\vulcan-openclaw-plugins\packages\shared\src\index.ts`
- 新增：`D:\projects\vulcan-openclaw-plugins\packages\shared\src\results.ts`
- 新增：`D:\projects\vulcan-openclaw-plugins\packages\shared\src\types.ts`
- 新增：`D:\projects\vulcan-openclaw-plugins\packages\shared\src\vulcan-host-client.ts`
- 新增：`D:\projects\vulcan-openclaw-plugins\packages\vulcan-tools\package.json`
- 新增：`D:\projects\vulcan-openclaw-plugins\packages\vulcan-tools\openclaw.plugin.json`
- 新增：`D:\projects\vulcan-openclaw-plugins\packages\vulcan-tools\src\commands.ts`
- 新增：`D:\projects\vulcan-openclaw-plugins\packages\vulcan-tools\src\index.ts`
- 新增：`D:\projects\vulcan-openclaw-plugins\packages\vulcan-tools\src\tools.ts`
- 新增：`D:\projects\vulcan-openclaw-plugins\packages\vulcan-memory\package.json`
- 新增：`D:\projects\vulcan-openclaw-plugins\packages\vulcan-memory\openclaw.plugin.json`
- 新增：`D:\projects\vulcan-openclaw-plugins\packages\vulcan-memory\src\hooks.ts`
- 新增：`D:\projects\vulcan-openclaw-plugins\packages\vulcan-memory\src\index.ts`
- 新增：`D:\projects\vulcan-openclaw-plugins\packages\vulcan-memory\src\memory-capability.ts`
- 新增：`D:\projects\vulcan-openclaw-plugins\packages\vulcan-memory\src\tools.ts`
- 修改：`D:\projects\vulcan-openclaw-plugins\docs\plan\20260504-02-OPENCLAW_PLUGIN_MVP.md`
- 删除：无

### 3. 💻关键代码调整详情

- `packages/shared/src/config.ts`：实现 OpenClaw pluginConfig 与环境变量合并，支持 `VULCAN_HOST_GRPC_ENDPOINT`、`VULCAN_HOST_PROTO_PATH`、工具开关、memory 开关、autoRecall 与超时配置。
- `packages/shared/src/context.ts`：实现 tool、command、hook 三类 OpenClaw 上下文到 Vulcan host context 的转换，自动携带 `sessionKey`、`sessionId`、`agentId`、`workspaceDir` 等信息。
- `packages/shared/src/grpc-vulcan-host-client.ts`：实现动态 gRPC 客户端，支持健康检查、VMM 状态读取、LuaSkills 工具列表、LuaSkills 工具调用、LuaSkills 生命周期操作、MCP tools/call 代理和 VMM memory tool metadata 查询。
- `packages/vulcan-tools/src/tools.ts`：实现 `vulcan_luaskill_call` 降级 dispatcher，模型只传 `toolName` 与 `arguments`，OpenClaw session 信息由插件自动补齐。
- `packages/vulcan-tools/src/commands.ts`：实现 `/vulcan status`、`/vulcan luaskills`、`/vulcan sync`、`/vulcan list`、`/vulcan install`、`/vulcan update`、`/vulcan uninstall`、`/vulcan reload`。
- `packages/vulcan-memory/src/tools.ts`：实现 `vulcan_memory_search` 通过 `McpService.Call -> vmm_memory_search` 中转，`vulcan_memory_get` 通过 `McpService.Call -> vmm_turn_details` 中转。
- `packages/vulcan-memory/src/hooks.ts`：实现 `before_prompt_build` 自动召回并注入 `prependContext`，实现 `agent_end` postaction 占位，当前默认不写入，避免未定稿策略造成噪声记忆。
- `packages/vulcan-memory/src/memory-capability.ts`：注册 memory capability 占位与稳定提示词指导，后续可升级为 canonical `memory_search/memory_get` slot。

### 4. ⚠️遗留问题与注意事项

- per-tool manifest 自动生成尚未实现；当前只有 `vulcan_luaskill_call` dispatcher 是 manifest 声明的工具。
- memory canonical slot 尚未替换 OpenClaw 默认 `memory_search/memory_get`；当前先使用 `vulcan_memory_search/vulcan_memory_get` sidecar 模式。
- `agent_end` postaction 当前只记录占位日志，未调用 VMM 写入；需要等写入策略、摘要粒度和去噪规则确定后再启用。
- 当前动态 gRPC 客户端需要能找到 `mcp_service.proto`。本地默认会尝试 `D:\projects\vulcan-mcp-client\proto\v1\mcp_service.proto`，其他环境需要配置 `VULCAN_HOST_PROTO_PATH` 或插件 `protoPath`。
- 因 npm 当前最新 `openclaw` 版本低于源码版本，仓库通过 `.npmrc` 设置 `auto-install-peers=false`，避免 pnpm 在本地开发时自动拉取不匹配 peer。

### 5. 验证结果

- 已执行：`pnpm install`
- 已执行：`pnpm check`
- 结果：TypeScript 静态检查通过。
