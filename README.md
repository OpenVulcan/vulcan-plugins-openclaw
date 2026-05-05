# vulcan-plugins-openclaw

Vulcan OpenClaw Plugins provides native OpenClaw adapters for Vulcan LuaSkills tools and Vulcan Memory Mesh memory flows.

本仓库提供 Vulcan LuaSkills 工具与 Vulcan Memory Mesh 记忆流程的 OpenClaw 原生插件适配层。

## Packages

- `packages/shared`: shared configuration, OpenClaw context conversion, gRPC client, result normalization, and generated manifest helpers.
- `packages/vulcan-tools`: normal tool plugin. It exposes a fallback dispatcher and generated per-tool LuaSkills proxies.
- `packages/vulcan-memory`: memory plugin. It owns the OpenClaw memory slot, exposes canonical `memory_search` / `memory_get`, keeps grouped VMM compatibility tools, and drives full-mode precheck/postaction hooks.

## Requirements

- `vulcan-host` / `vulcan-mcp-client` gRPC must be reachable. The default endpoint is `127.0.0.1:19202`.
- `VULCAN_HOST_PROTO_PATH` should point to `vulcan-mcp-client/proto/v1/mcp_service.proto` unless the default workspace path exists. The plugin now auto-discovers the sibling `vmm.proto` in the same directory for native memory flows.
- OpenClaw currently reads `openclaw.plugin.json#contracts.tools` from plugin registry metadata, so LuaSkills tool id changes require local sync and registry refresh.

## Install

```powershell
cd D:\projects\vulcan-plugins-openclaw
pnpm install
pnpm build
pnpm check
pnpm prepare:linked-install
```

If you want one local install flow that also writes OpenClaw config, enables the required hooks, pins the memory slot, and turns on vulcan-host runtime autostart, use:

如果你希望用一条本地安装流程同时完成 OpenClaw 配置写入、必需 hooks 开启、memory slot 绑定，以及 vulcan-host 运行时自动拉起，请直接使用：

```powershell
cd D:\projects\vulcan-plugins-openclaw
pnpm install:openclaw-local
```

This one-shot installer performs:

这条一键安装流程会自动完成：

- `pnpm sync:tools`
- `pnpm sync:memory`
- `pnpm build`
- `pnpm prepare:linked-install`
- writes `~/.openclaw/openclaw.json`
- enables `vulcan-tools` and `vulcan-memory`
- enables `hooks.allowPromptInjection=true` and `hooks.allowConversationAccess=true`
- sets `plugins.slots.memory = "vulcan-memory"`
- enables `plugins.entries.vulcan-tools.config.host.autoStart=true`
- auto-detects a local `vulcan-mcp` binary when possible
- refreshes the OpenClaw plugin registry
- restarts the OpenClaw Gateway

`openclaw plugins install --link` requires compiled runtime output. Build the workspace again after changing plugin runtime code so `packages/*/dist/index.js` exists before installation.
OpenClaw also rejects workspace or deploy directories whose `node_modules` contain symlinks escaping the install root, so use the generated standalone artifact directories instead of raw workspace package paths.

## OpenClaw Config

For a normal local OpenClaw installation, prefer linked package install instead of `plugins.load.paths`. The exact config file location depends on your OpenClaw setup.

```powershell
cd D:\projects\vulcan-plugins-openclaw
openclaw plugins install --link D:\projects\vulcan-plugins-openclaw\artifacts\openclaw-linked-install\vulcan-tools
openclaw plugins install --link D:\projects\vulcan-plugins-openclaw\artifacts\openclaw-linked-install\vulcan-memory
openclaw plugins registry --refresh
```

If OpenClaw blocks `vulcan-tools` during `install --link` because the local host bootstrap uses `child_process`, use `pnpm install:openclaw-local` instead. That path writes `plugins.load.paths`, refreshes the registry, and keeps the runtime behavior aligned with the linked-install artifacts without requiring the stricter package install scanner to pass.

如果 OpenClaw 因为 `vulcan-tools` 的本地主机自启动 bootstrap 使用了 `child_process` 而拦截 `install --link`，请改用 `pnpm install:openclaw-local`。这条路径会直接写入 `plugins.load.paths`、刷新注册表，并保持运行时与 linked-install 产物一致，不再依赖更严格的包安装扫描通过。

Then enable both plugin entries in OpenClaw config:

```json
{
  "plugins": {
    "load": {
      "paths": [
        "D:/projects/vulcan-plugins-openclaw/artifacts/openclaw-linked-install/vulcan-tools",
        "D:/projects/vulcan-plugins-openclaw/artifacts/openclaw-linked-install/vulcan-memory"
      ]
    },
    "entries": {
      "vulcan-tools": {
        "enabled": true,
        "config": {
          "endpoint": "127.0.0.1:19202",
          "protoPath": "D:/projects/vulcan-mcp-client/proto/v1/mcp_service.proto"
        }
      },
      "vulcan-memory": {
        "enabled": true,
        "hooks": {
          "allowPromptInjection": true,
          "allowConversationAccess": true
        },
        "config": {
          "endpoint": "127.0.0.1:19202",
          "protoPath": "D:/projects/vulcan-mcp-client/proto/v1/mcp_service.proto",
          "bindings": {
            "defaultUserId": 1,
            "defaultProjectId": 1,
            "agentProjects": {
              "my-main-agent-id": 42
            }
          },
          "memory": {
            "autoRecall": true,
            "autoPostAction": true,
            "recallTopK": 5,
            "implicitMemoryTurns": 5,
            "profileRefreshTurns": 5
          }
        }
      }
    },
    "slots": {
      "memory": "vulcan-memory"
    }
  }
}
```

Hook policy notes:

- `hooks.allowPromptInjection=true` keeps `before_prompt_build` available for Vulcan memory recall and VMM `PreCheck`. OpenClaw currently allows this by default, but setting it explicitly avoids future config drift.
- `hooks.allowConversationAccess=true` is required for non-bundled plugins to receive `agent_end` conversation payloads. Without it, `memory.autoPostAction=true` still will not execute writeback.
- `bindings.defaultUserId` and `bindings.defaultProjectId` are optional. When neither config nor persisted binding state provides ids, Vulcan falls back to VMM `user_id=1` and `project_id=1`.
- `bindings.agentProjects` is optional. It lets one OpenClaw main agent use a dedicated `project_id`; when no override exists, that agent falls back to the shared default project binding.
- `memory.autoRecall=true` enables automatic recall injection ahead of the active user turn.
- `memory.autoPostAction=true` enables VMM `PostAction` writeback after closed turns. If you only want recall and do not want automatic memory writeback yet, set it back to `false`.
- `memory.implicitMemoryTurns` controls how many later committed turns one fresh hidden recall snapshot may continue to survive before it disappears automatically. Default `5`.
- `memory.profileRefreshTurns` controls how many later closed committed turns should pass before the hidden profile bundle refreshes again. Set it to `0` if you want scope-stable bundle caching without periodic refresh. Default `5`.
- After changing hook policy or memory writeback settings, restart or reload the OpenClaw Gateway so the typed hook registry is rebuilt with the new policy.

Autostart notes:

自动启动说明：

- OpenClaw native plugin install already persists `enabled=true`, but that does not start `vulcan-host` for you.
- `vulcan-tools.config.host.autoStart=true` lets the `vulcan-tools` runtime register one background bootstrap service that first probes `endpoint`, then launches `vulcan-mcp` only when the endpoint is unreachable.
- The runtime autostart owner is intentionally `vulcan-tools` only, so `vulcan-memory` does not race to spawn a second host process.
- If local binary auto-discovery fails, set `plugins.entries.vulcan-tools.config.host.command` manually to the `vulcan-mcp` executable path.

## Binding Management

OpenClaw does not provide the OpenCode TUI binding flow, so `vulcan-memory` now exposes dedicated tools for real VMM id management:

- `vulcan_vmm_get_bindings`
- `vulcan_vmm_list_users`
- `vulcan_vmm_bind_default_user`
- `vulcan_vmm_list_projects`
- `vulcan_vmm_bind_default_project`
- `vulcan_vmm_bind_agent_project`
- `vulcan_vmm_clear_agent_project`

These tools persist runtime changes to `~/.openclaw/plugins/vulcan-bindings.json`.

Their descriptions and JSON schemas are now intended to come from `vulcan-host` through the same VMM descriptor sync flow used by compatibility memory tools. If the currently running `vulcan-host` instance has not restarted onto the new binding-descriptor RPC yet, `pnpm sync:memory` will temporarily continue with memory descriptors only and the binding tools will fall back to their local built-in schema/description defaults.

Binding rules:

- Default user: use the persisted/configured default `user_id`; otherwise fall back to `1`.
- Default project: use the persisted/configured default `project_id`; otherwise fall back to `1`.
- Agent project override: when one main `agentId` has a dedicated `project_id`, that agent uses it instead of the shared default project.
- No project path derivation: OpenClaw no longer guesses VMM users or projects from workspace, channel, or session labels.

## LuaSkills Tool Sync

`vulcan-tools` always registers `vulcan_luaskill_call` as a dispatcher fallback. First-class LuaSkills tools require a generated static manifest because OpenClaw does not dynamically mutate `contracts.tools` at runtime.

```powershell
cd D:\projects\vulcan-plugins-openclaw
pnpm sync:tools
openclaw plugins registry --refresh
```

After LuaSkills `install`, `update`, or `uninstall`, run the sync command again. If the agent still sees the old tool list, restart or reload the OpenClaw Gateway so plugin source and manifest metadata are read again.

## VMM Descriptor Sync

`vulcan-memory` now exposes canonical `memory_search` / `memory_get` plus stable grouped compatibility names `vulcan_memory_search` / `vulcan_memory_get`. The compatibility tools reuse VMM-owned descriptions and schemas synchronized from vulcan-host:

```powershell
cd D:\projects\vulcan-plugins-openclaw
pnpm sync:memory
openclaw plugins registry --refresh
```

`pnpm sync:memory` also rewrites `packages/vulcan-memory/openclaw.plugin.json#contracts.tools` so canonical and compatibility memory tools stay visible to OpenClaw's cold plugin registry.

If vulcan-host reports VMM disabled, canonical and compatibility memory tools both return a tool-level disabled error instead of silently pretending recall is available.

## Commands

Inside OpenClaw, use:

- `/vulcan status`
- `/vulcan luaskills`
- `/vulcan sync`
- `/vulcan list`
- `/vulcan install <source> [sourceType]`
- `/vulcan update <skillId>`
- `/vulcan uninstall <skillId>`
- `/vulcan reload`

Lifecycle commands intentionally stay as commands, not model tools. They can change tool ids, so the command output reminds the operator to run `pnpm sync:tools`, refresh the registry, and restart/reload Gateway when needed.

## Memory Behavior

`memory_search` and `memory_get` now form the primary OpenClaw memory surface. They are backed by a native `MemorySearchManager` that resolves one real VMM `user_id/project_id` binding before every memory flow.

`vulcan_memory_search` and `vulcan_memory_get` remain available for grouped VMM-style inspection when you want raw hit grouping, memory ids, or source turn ids.

`before_prompt_build` now uses a split injection strategy:

- hidden profile bundle: injected through `prependSystemContext`, cached per session, and refreshed after a bounded number of later closed committed turns or when the bound `user_id/project_id` changes.
- short-lived recall: injected through `prependContext`, refreshed on new real turns, and retained for a bounded number of later turns through one single-slot recall cache.

`before_prompt_build` still prefers VMM `PreCheck` when a stable session/workmem identity exists, and falls back to grouped search recall when only lower-fidelity host identity is available.

`agent_end` writeback is disabled by default. If `memory.autoPostAction=true`, the plugin uses VMM `PostAction` with session scope instead of direct `vmm_memory_write`. Non-bundled plugins must also set `plugins.entries.vulcan-memory.hooks.allowConversationAccess=true`, otherwise OpenClaw blocks the hook before our writeback logic runs.

When `autoPostAction` is enabled, `vulcan-memory` now applies a conservative closed-turn gate. Interrupted turns, approval-gated replies, follow-up asks, and plan-only responses are skipped so VMM only receives stable `user -> assistant` turn pairs.

The plugin now also registers `session_start` and `session_end` so profile cache and short-lived recall state are initialized and cleared along with the OpenClaw session lifecycle.

## vulcan-host Notes

The current plugin can already complete the OpenClaw native memory takeover by:

- Resolving agent/session context locally in the plugin.
- Resolving real VMM `user_id/project_id` from default bindings plus optional per-agent project overrides.
- Using `BuildHostAdapterRuntime` only for normalized `session/workmem` readiness and degradation diagnostics.

For later cross-host unification, vulcan-host should still grow a host-aware VMM relay layer that can accept trusted host context and return or execute against resolved `user_id/project_id/session_id` directly. That future layer matters more for Claude Code / Qwen / Hermes parity than for the OpenClaw plugin's current native memory path.
