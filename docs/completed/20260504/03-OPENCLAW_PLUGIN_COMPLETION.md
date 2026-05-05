# OpenClaw 插件完整化补齐计划

## 任务目标

基于已完成的 OpenClaw 插件 MVP，继续补齐“完整接入”所需的关键能力：LuaSkills per-tool manifest 生成、运行时批量注册、VMM 工具描述同步、OpenClaw 刷新提示、可选 postaction 写入骨架，以及更清晰的安装调试文档，避免插件长期停留在 dispatcher-only 与 sidecar-only 状态。

## 详细执行步骤

1. 扩展 shared 层工具注册模型，增加生成用 descriptor、manifest 更新、生成文件读写与注册工具辅助函数。
2. 为 `vulcan-tools` 增加 sync/generate 脚本，从 vulcan-host 获取 LuaSkills 工具清单并写入 `generated/tools.generated.ts` 与 `openclaw.plugin.json#contracts.tools`。
3. 修改 `vulcan-tools` 插件入口，除 dispatcher 外自动注册生成出的 per-tool LuaSkills proxy。
4. 增强 `/vulcan sync` 命令提示，让它明确区分“运行时查询”和“本地生成脚本”，并给出 `openclaw plugins registry --refresh` 与 Gateway 重启要求。
5. 为 `vulcan-memory` 增加 VMM descriptor 同步脚本，后续可将 canonical memory tools 切换到由 vulcan-host 权威 schema 生成。
6. 实现 opt-in `agent_end` postaction 写入骨架：仅当 `memory.autoPostAction=true` 时，将安全裁剪后的回合摘要写入 `vmm_memory_write`，默认关闭。
7. 完善 README，写清 OpenClaw 配置、生成命令、刷新命令、默认 dispatcher 与 per-tool 模式边界。
8. 执行 `pnpm check`，修复静态类型问题。
9. 对照计划追加执行变更总结，并迁移到 `docs/completed/20260504/`。

## 技术选型

- 仍以 vulcan-host gRPC 作为唯一权威来源，不在插件端硬编码 LuaSkills schema。
- 生成文件采用 TypeScript 源码而非 JSON，便于 OpenClaw runtime 直接 import 并注册工具。
- manifest 更新采用本地 Node/TypeScript 脚本完成，因为 OpenClaw 的 `contracts.tools` 是冷读取静态声明。
- postaction 写入默认关闭，防止未实测情况下污染 VMM；但代码路径要完整、可配置启用。
- 保留 dispatcher 作为降级路径，但 per-tool proxy 作为主路径。

## 验收标准

1. `vulcan-tools` 支持生成 `generated/tools.generated.ts` 并更新 manifest。
2. `vulcan-tools` 启动时可注册 dispatcher 与所有生成的 per-tool proxy。
3. `vulcan-memory` 具备 VMM 工具描述同步基础，且 sidecar 工具仍可用。
4. `agent_end` postaction 写入路径存在且默认关闭。
5. README 明确安装、生成、刷新与重启路径。
6. `pnpm check` 通过。

## 执行变更总结

### 1. 核心修复与调整概述

本次补齐了 OpenClaw 插件从 MVP 骨架走向可用接入层所缺失的关键闭环：新增共享生成工具，支持从 vulcan-host 获取 LuaSkills 与 VMM descriptor 后生成 TypeScript 静态模块；`vulcan-tools` 支持 dispatcher 与 per-tool proxy 并存，并可同步 `openclaw.plugin.json#contracts.tools`；`vulcan-memory` 支持 VMM descriptor 同步、运行时优先使用生成 schema/description，并实现默认关闭的 `agent_end` postaction 写入路径。README 也补充了安装、同步、registry 刷新与 Gateway 重启说明。

### 2. 📂文件变更清单

- 新增：`packages/shared/src/generation.ts`
- 新增：`packages/vulcan-tools/src/generated/tools.generated.ts`
- 新增：`packages/vulcan-tools/src/sync.ts`
- 新增：`packages/vulcan-memory/src/generated/vmm-tools.generated.ts`
- 新增：`packages/vulcan-memory/src/sync-vmm-tools.ts`
- 修改：`packages/shared/src/index.ts`
- 修改：`packages/vulcan-tools/src/index.ts`
- 修改：`packages/vulcan-tools/src/tools.ts`
- 修改：`packages/vulcan-tools/src/commands.ts`
- 修改：`packages/vulcan-memory/src/tools.ts`
- 修改：`packages/vulcan-memory/src/hooks.ts`
- 修改：`packages/vulcan-memory/src/index.ts`
- 修改：`packages/vulcan-memory/src/memory-capability.ts`
- 修改：`packages/vulcan-memory/openclaw.plugin.json`
- 修改：`package.json`
- 修改：`pnpm-lock.yaml`
- 修改：`README.md`

### 3. 💻关键代码调整详情

- `renderGeneratedDescriptorModule`、`updateManifestTools` 等共享方法负责统一生成工具描述模块与更新 OpenClaw 静态 manifest，避免每个插件重复实现 JSON 写入与去重逻辑。
- `pnpm sync:tools` 会调用 vulcan-host 的 LuaSkills gRPC 列表接口，生成 `GENERATED_LUASKILL_TOOLS`，并把 dispatcher 与生成工具名一起写入 `contracts.tools`。
- `vulcan-tools` 启动时除 `vulcan_luaskill_call` dispatcher 外，会遍历 `GENERATED_LUASKILL_TOOLS` 注册一等工具代理，调用时自动注入 OpenClaw 会话上下文。
- `/vulcan sync` 现在明确区分“运行时查询”和“本地生成脚本”，生命周期命令也会提示执行 `pnpm sync:tools`、`openclaw plugins registry --refresh` 与 Gateway 重启或重载。
- `pnpm sync:memory` 会调用 vulcan-host 的 VMM descriptor 列表接口，生成 `GENERATED_VMM_MEMORY_TOOLS`，供 memory sidecar 工具优先复用权威 schema 与描述。
- `agent_end` hook 在 `memory.autoPostAction=true` 时会检查 VMM 启用状态，并通过 `vmm_memory_write` 写入裁剪后的回合摘要；默认仍关闭，避免未确认策略下污染长期记忆。

### 4. ⚠️遗留问题与注意事项

- 本轮只执行了 `pnpm check` 静态验证，没有进行真实 OpenClaw Gateway 与 vulcan-host 联调。
- 生成文件当前是空 seed 文件；需要在 vulcan-host 运行时执行 `pnpm sync:tools` 与 `pnpm sync:memory` 才会写入真实 descriptor。
- `vulcan-memory` 当前仍采用 sidecar 工具与 hook 接入，尚未接入 OpenClaw 原生 `MemorySearchManager`。
- `autoPostAction` 默认关闭是刻意设计；开启前需要确认写入策略、分类策略与审计方式。
