// Native memory capability bridge for the Vulcan OpenClaw memory plugin.
// 本文件实现 Vulcan OpenClaw memory 插件的原生记忆能力桥接。

import {
  buildBaseHostContext,
  createVulcanHostClient,
  type ResolvedVulcanConfig,
} from "@vulcan-plugins-openclaw/shared";
import type { MemoryPluginCapability, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { closeAllVulcanMemoryManagers, getOrCreateVulcanMemoryManager } from "./manager.js";

// createVulcanMemoryCapability exposes a real OpenClaw memory runtime backed by vulcan-host and VMM.
// createVulcanMemoryCapability 暴露一个由 vulcan-host 与 VMM 驱动的真实 OpenClaw 记忆运行时。
export function createVulcanMemoryCapability(
  api: OpenClawPluginApi,
  config: ResolvedVulcanConfig,
): MemoryPluginCapability {
  return {
    promptBuilder: ({ availableTools }) => buildVulcanMemoryPrompt(config, availableTools),
    runtime: {
      async getMemorySearchManager(params) {
        if (!config.enabled || !config.memory.enabled) {
          return {
            manager: null,
            error: "Vulcan memory is disabled by plugin configuration.",
          };
        }
        const client = createVulcanHostClient(config);
        const workspaceDir = resolveWorkspaceDir(api, params.cfg, params.agentId);
        const manager = getOrCreateVulcanMemoryManager({
          client,
          config,
          baseContext: {
            ...buildBaseHostContext(config, "memory-runtime"),
            agentId: params.agentId,
            ...(workspaceDir ? { workspaceDir } : {}),
          },
        });
        return { manager };
      },
      resolveMemoryBackendConfig() {
        return { backend: "builtin" };
      },
      async closeAllMemorySearchManagers() {
        await closeAllVulcanMemoryManagers();
      },
    },
  };
}

// buildVulcanMemoryPrompt returns stable model guidance once one supported Vulcan memory tool surface is available.
// buildVulcanMemoryPrompt 在可用的 Vulcan 记忆工具表面出现后返回稳定模型指导。
function buildVulcanMemoryPrompt(
  config: ResolvedVulcanConfig,
  availableTools: Set<string>,
): string[] {
  if (!config.enabled || !config.memory.enabled) {
    return [];
  }
  if (availableTools.has("vulcan_memory_search")) {
    return [
      "Vulcan memory owns the active OpenClaw memory slot. Use `vulcan_memory_search` before answering when prior project facts, decisions, requirements, bugs, user preferences, or source-turn context may matter. Use `vulcan_memory_get` when grouped recall results expose one or more non-zero source_turn_id values and you need structured turn details. Treat `memory_search` and `memory_get` only as legacy bridge tools when one workflow still requires the standard OpenClaw names.",
    ];
  }
  if (!availableTools.has("memory_search")) {
    return [];
  }
  return [
    "Vulcan memory owns the active OpenClaw memory slot. Use `memory_search` before answering when prior project facts, decisions, requirements, bugs, user preferences, or source-turn context may matter. Use `memory_get` to inspect a returned path. When explicit Vulcan tools later become available in this runtime, prefer `vulcan_memory_search` and `vulcan_memory_get` instead of this legacy bridge pair.",
  ];
}

// resolveWorkspaceDir prefers OpenClaw runtime helpers and falls back to lightweight config inspection when unavailable.
// resolveWorkspaceDir 优先使用 OpenClaw runtime helper，在不可用时退回到轻量配置探测。
function resolveWorkspaceDir(
  api: OpenClawPluginApi,
  cfg: Record<string, unknown>,
  agentId: string,
): string | undefined {
  const runtimeWorkspace = api.runtime?.agent?.resolveAgentWorkspaceDir?.(cfg, agentId);
  if (runtimeWorkspace?.trim()) {
    return runtimeWorkspace.trim();
  }
  const root = asRecord(cfg);
  const agents = asRecord(root.agents);
  const defaults = asRecord(agents.defaults);
  const agentConfig = asRecord(agents[agentId]);
  const explicitWorkspace = readOptionalString(agentConfig.workspace);
  if (explicitWorkspace) {
    return explicitWorkspace;
  }
  const defaultWorkspace = readOptionalString(defaults.workspace);
  return defaultWorkspace ? `${defaultWorkspace}/${agentId}` : undefined;
}

// asRecord safely narrows unknown config values into plain objects.
// asRecord 将未知配置值安全收窄为普通对象。
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// readOptionalString preserves non-empty strings while discarding all other config values.
// readOptionalString 保留非空字符串，并丢弃其他配置值。
function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
