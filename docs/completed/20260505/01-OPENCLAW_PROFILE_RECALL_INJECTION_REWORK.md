# OpenClaw 画像与 Recall 注入链路重构计划

## 任务目标

本轮任务目标是在 `vulcan-openclaw-plugins` 中重构 OpenClaw 的记忆注入链路，参考 OpenCode 现有实现方式，形成更稳定的“双状态机”方案：

1. 为画像 bundle 建立稳定的 session 级缓存与刷新策略。
2. 为 precheck recall 建立短期轮次保温状态机，支持限定轮次自动隐藏。
3. 接入 `session_start` / `session_end` 生命周期，用于初始化、续用与清理注入状态。
4. 保持 `before_prompt_build` 为主注入点，并合理使用 OpenClaw 的一次性注入能力作为 recall 的辅助续投通道。
5. 保证现有 `after_compaction`、`agent_end` 链路不被破坏，并与新的画像 / recall 状态保持一致。

## 详细执行步骤

1. 梳理当前 OpenClaw 插件已有的 `before_prompt_build`、`after_compaction`、`agent_end` 逻辑，确认最小改动范围。
2. 设计并新增 session 级状态模块，至少覆盖：
   - 画像缓存状态
   - recall 保温状态
   - 成功提交轮次计数
   - session 级标记与最近更新时间
3. 为 `hooks.ts` 增加 `session_start` 与 `session_end` 注册和处理逻辑。
4. 改造 `before_prompt_build`：
   - 画像走 `prependSystemContext`
   - recall 走 `prependContext`
   - recall 只在新的真实 turn 触发新检索，其余轮次优先复用短期缓存
5. 改造 `agent_end` 成功写回后的后处理：
   - 递增成功提交轮次
   - 按配置阈值刷新画像 bundle
   - 清理或续写 recall 状态
6. 评估并接入 `enqueueNextTurnInjection` 的最小辅助实现，仅用于 recall 的下一轮续投，不作为主状态真相源。
7. 执行项目级检查，逐项对照计划补齐遗漏，并记录变更总结。

## 技术选型

1. 状态存储优先沿用插件侧可控的 session 级本地状态，不依赖宿主提供轮次状态机。
2. 画像刷新基准参考 OpenCode，按“成功提交给 VMM 的 committed turn 数”计数，而不是单纯按 prompt build 次数计数。
3. recall 保温语义参考 OpenCode 的 `remainingTurns` 模型，避免多重注入导致上下文膨胀。
4. OpenClaw 的一次性注入只作为 recall 的辅助投递能力，不承担画像长期注入或轮次数状态管理。

## 验收标准

1. OpenClaw 插件已注册 `session_start` / `session_end`，并能管理 session 级状态。
2. 画像 bundle 已支持：
   - system 注入
   - 首次获取
   - 绑定变化刷新
   - 按成功提交轮次阈值刷新
   - 不需要时自动隐藏
3. recall 已支持：
   - 当前轮 precheck 注入
   - 限定轮次保温
   - 超出轮次自动隐藏
   - follow-up / merged 场景优先复用而不是重复检索
4. 构建与检查命令通过，且不破坏现有 OpenClaw memory slot、工具注册与 compaction / postaction 链路。

## 执行变更总结

### 1. 核心修复与调整概述

本轮已完成 OpenClaw 记忆注入链路重构，形成“画像 bundle + 单槽 recall”双状态机方案：

- 为 `vulcan-memory` 新增 `session_start` / `session_end` 生命周期接入，建立 session 级运行时状态。
- 画像 bundle 改为通过 `before_prompt_build -> prependSystemContext` 注入，并按 `profileRefreshTurns` 与绑定签名变化进行刷新。
- recall 改为通过 `before_prompt_build -> prependContext` 注入，并通过单槽 `implicitMemoryTurns` 机制做有界保温，避免多代 recall 叠加造成上下文膨胀。
- `agent_end` 现在会记录闭合 committed turn 计数；即使未开启 `autoPostAction`，画像也可以按轮次节奏刷新，不会永久停留在首次拉取结果。
- 对 `vulcan-host` 暂时不可用的场景增加了安全降级：若只是临时传输失败，会优先复用安全缓存；若是绑定错误、VMM 禁用或缺少 session 身份，则不会继续注入陈旧内容。

### 2. 📂 文件变更清单

新增文件：

- `packages/vulcan-memory/src/session-state.ts`

修改文件：

- `packages/shared/src/types.ts`
- `packages/shared/src/config.ts`
- `packages/shared/src/vulcan-host-client.ts`
- `packages/shared/src/grpc-vulcan-host-client.ts`
- `packages/vulcan-memory/src/hooks.ts`
- `packages/vulcan-memory/src/vmm-scope.ts`
- `packages/vulcan-memory/openclaw.plugin.json`
- `README.md`

### 3. 💻 关键代码调整详情

- 在共享类型与客户端层新增画像 bundle 契约，补齐 `GetProfileBundle` 调用能力，使 OpenClaw 可以直接消费 VMM 的 `combined_text`。
- 在 `session-state.ts` 中实现：
  - 画像 bundle 缓存
  - 单槽 recall 缓存
  - committed turn 计数
  - session 生命周期初始化与清理
- 在 `hooks.ts` 中重构 `before_prompt_build`：
  - 使用 `resolveVulcanMemoryScope(..., requireSession: false, purpose: "profile")` 统一解析 user/project 绑定
  - 画像链走 system 注入
  - recall 链走 context 注入
  - 新 recall 会覆盖旧 recall，而不是多代累积
- 在 `hooks.ts` 中增强 `agent_end`：
  - 闭合 committed turn 计数前移
  - 画像刷新与 `PostAction` 写回解耦
  - 原有闭合回合 gate 逻辑保留
- 在插件 schema 与 README 中补齐：
  - `memory.implicitMemoryTurns`
  - `memory.profileRefreshTurns`
  - 新的画像 / recall 注入行为说明

### 4. ⚠️ 遗留问题与注意事项

- 本轮已完成 `pnpm check`、`pnpm build`、`pnpm prepare:linked-install`、`openclaw gateway restart` 与运行时 `inspect` 验证，但尚未在真实对话流中逐项跑完“画像刷新阈值命中”“recall 第 5 轮消失”“VMM 暂时断连时安全复用缓存”等端到端样本。
- 当前方案刻意没有把 OpenClaw 的 `enqueueNextTurnInjection` 作为主路径。原因是它更适合一次性续投，而当前 recall 还需要和“每轮新 precheck”共存，直接作为主状态源容易与新召回叠加。
- recall 当前采用单槽覆盖策略，这是有意为之，目标是优先满足“防止上下文爆炸”的约束；如果后续确认 OpenClaw 侧也需要更贴近 OpenCode 的多槽 carry-over，再单独扩展。
