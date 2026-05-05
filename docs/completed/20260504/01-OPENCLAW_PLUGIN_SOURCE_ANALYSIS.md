# OpenClaw 插件接入源码分析与方案计划

## 任务目标

基于最新 OpenClaw 源代码，分析 OpenClaw 插件体系、工具注册能力、记忆注入与写回链路、session 身份获取方式以及动态刷新边界，判断 Vulcan/OpenClaw 插件应如何接入 vulcan-host、LuaSkills tools 与 VMM 记忆能力，并为后续在 `D:\projects\vulcan-openclaw-plugins` 中实现插件打下工程基础。

## 详细执行步骤

1. 强制更新 `D:\projects\OpenClaw` 到远端最新代码，确保分析基于最新源码。
2. 阅读 OpenClaw 仓库根目录与相关模块的项目说明、AGENTS 约束、包管理配置和入口结构。
3. 定位 OpenClaw 的插件加载、扩展注册、tool 注册、MCP 接入、hook 或事件生命周期相关源码。
4. 定位 OpenClaw 的记忆实现，包括记忆检索、上下文注入、会话状态、写回或总结链路。
5. 对比当前 OpenCode 插件已经验证过的能力模型，判断 OpenClaw 是否适合复用 vulcan-host HostAdapterService、LuaSkillsService 与 VMM 状态门控。
6. 明确 OpenClaw 中工具问题的解决路径，包括静态注册、动态注册、重启要求、MCP 降级或原生插件模式。
7. 明确 OpenClaw 中记忆问题的解决路径，包括是否能获取 session_id、是否支持 precheck/postaction、是否能限时注入指定回合、是否应接入 OpenClaw 原生记忆。
8. 形成插件工程建议，包括目录结构、首批实现目标、需要从 OpenCode 插件抽取或复制的公共能力，以及暂不实现的边界。

## 技术选型

- 以 OpenClaw 最新源码作为唯一判断依据，不依赖旧印象。
- 优先选择 OpenClaw 原生插件/扩展机制；若原生能力不足，再考虑 MCP 降级模式。
- 工具元信息继续以 vulcan-host 为中心来源，插件侧只做宿主适配和注册。
- VMM 记忆能力优先通过 vulcan-host 中转，避免插件直接连接 VMM。
- 对无法动态注册 tools 或无法限时注入的能力，明确标记为宿主限制并设计降级策略。

## 验收标准

1. OpenClaw 已更新到远端最新提交，并记录当前分支和提交号。
2. 明确 OpenClaw 是否支持原生插件、工具注册、动态工具刷新、MCP、hook/precheck/postaction。
3. 明确 OpenClaw 记忆链路的关键文件与数据流。
4. 明确 Vulcan OpenClaw 插件第一阶段应实现的能力边界。
5. 给出是否需要抽取公共 TS core、直接复制 OpenCode 适配层、或先独立实现的建议。
6. 输出后续实现计划，能直接交给下一轮开发执行。

## 执行变更总结

### 1. 核心修复与调整概述

已将 `D:\projects\OpenClaw` 强制更新到远端最新 `main`，当前最新提交为 `feb9a5af6a fix(plugins): scope commands to channels`，工作区保持干净。基于最新源码和 OpenClaw 官方仓库内文档，完成了工具注册、插件 manifest、memory capability、prompt/tool hooks、session context、MCP 降级边界的对比分析，并沉淀 OpenClaw 版本的 Vulcan 插件接入建议。

核心结论为：OpenClaw 适合走原生插件完整模式，工具层采用“vulcan-host 同步工具清单 + manifest 静态声明 + runtime per-tool proxy”，记忆层采用 `kind: "memory"` 插件 + `registerMemoryCapability` + hooks，通过 vulcan-host gRPC 中转 VMM。MCP 与单 dispatcher 仅保留为低保真降级路径。

### 2. 📂文件变更清单

- 新增：`D:\projects\vulcan-openclaw-plugins\docs\analysis\20260504-openclaw-memory-tools-integration.md`
- 修改：`D:\projects\vulcan-openclaw-plugins\docs\plan\20260504-01-OPENCLAW_PLUGIN_SOURCE_ANALYSIS.md`
- 删除：无

### 3. 💻关键代码调整详情

本轮未修改 OpenClaw 或插件源码，主要完成源码更新与方案沉淀。关键分析结果包括：

- OpenClaw 工具注册受 `contracts.tools` 约束，不支持任意未知工具的纯运行时动态新增。
- LuaSkills 工具应由 vulcan-host 提供完整工具描述与参数 schema，OpenClaw 插件只负责同步 manifest、注册 per-tool proxy、补齐 session 上下文并转发调用。
- OpenClaw memory 插件可以通过 `registerMemoryCapability` 接入原生记忆体系，比纯 MCP 模式更适合解决 VMM 记忆检索、注入和写回问题。
- OpenClaw hooks 可以覆盖 `before_prompt_build`、`agent_turn_prepare`、`before_tool_call`、`after_tool_call`、`agent_end` 等关键阶段，具备实现 precheck、postaction、参数补齐和指定会话注入的基础。
- `sessionKey` 更适合作为 Vulcan workmem/session 稳定标识，`sessionId` 更适合作为当前 OpenClaw 会话实例标识。

### 4. ⚠️遗留问题与注意事项

- OpenClaw 的工具列表同步需要接受 manifest 边界：LuaSkills install/uninstall/update 后应重新同步 manifest，并提示执行 registry refresh 或重启 Gateway。
- 如果 Vulcan memory 插件复用 `memory_search`、`memory_get`，需要用户配置 OpenClaw active memory slot，避免与 memory-core 冲突。
- 如果 OpenClaw 配置禁用 prompt injection，VMM precheck/active recall hook 将无法注入上下文，插件后续需要提供诊断信息。
- 暂不建议第一阶段实现 context-engine 接管；应先完成 memory plugin + tools proxy + hooks 的最小闭环。
