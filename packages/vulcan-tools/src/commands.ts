// Command handlers for Vulcan tool management inside OpenClaw.
// 本文件实现 OpenClaw 内的 Vulcan 工具管理命令。

import {
  buildVulcanCapabilityUnavailableMessage,
  buildCommandHostContext,
  createVulcanHostClient,
  describeClientTarget,
  ensureVulcanHostReconnectScheduled,
  isVulcanHostConnectionUnavailable,
  isVulcanHostTransportError,
  type ResolvedVulcanConfig,
  type VulcanToolDescriptor,
} from "@vulcan-plugins-openclaw/shared";
import type {
  OpenClawPluginApi,
  PluginCommandContext,
  PluginCommandResult,
} from "openclaw/plugin-sdk/plugin-entry";

// VulcanCommandAction is the normalized first token accepted by /vulcan.
// VulcanCommandAction 是 /vulcan 接受的归一化首个参数。
type VulcanCommandAction =
  | "status"
  | "luaskills"
  | "sync"
  | "list"
  | "install"
  | "update"
  | "uninstall"
  | "reload"
  | "help";

// HOST_UNAVAILABLE_MESSAGE keeps one stable command-facing message when vulcan-host is currently offline.
// HOST_UNAVAILABLE_MESSAGE 为 vulcan-host 当前离线时保留一条稳定的命令面消息。
const HOST_UNAVAILABLE_MESSAGE = buildVulcanCapabilityUnavailableMessage("host");

// registerVulcanCommands registers operator-facing commands instead of exposing lifecycle as tools.
// registerVulcanCommands 注册面向操作者的命令，而不是把生命周期操作暴露成工具。
export function registerVulcanCommands(
  api: OpenClawPluginApi,
  config: ResolvedVulcanConfig,
): void {
  api.registerCommand({
    name: "vulcan",
    description: "Inspect and manage Vulcan LuaSkills through vulcan-host.",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => await handleVulcanCommand(api, config, ctx),
  });
}

// handleVulcanCommand dispatches a compact command grammar for status and lifecycle actions.
// handleVulcanCommand 分发一套紧凑命令语法，用于状态检查与生命周期操作。
async function handleVulcanCommand(
  api: OpenClawPluginApi,
  config: ResolvedVulcanConfig,
  ctx: PluginCommandContext,
): Promise<PluginCommandResult> {
  const tokens = tokenizeArgs(ctx.args);
  const action = normalizeAction(tokens[0]);
  const client = createVulcanHostClient(config);
  const context = buildCommandHostContext(ctx, config);
  if (isVulcanHostConnectionUnavailable(config) && action !== "help") {
    ensureVulcanHostReconnectScheduled(config, { logger: api.logger });
    return { text: `${HOST_UNAVAILABLE_MESSAGE}\n\n当前目标：${describeClientTarget(config)}` };
  }
  try {
    if (action === "status") {
      const [health, vmm] = await Promise.all([client.health(context), client.getVmmStatus(context)]);
      return {
        text: [
          "# Vulcan Status",
          `- target: ${describeClientTarget(config)}`,
          `- host: ${health.ok ? "ok" : "unavailable"} ${health.version ?? ""}`.trim(),
          `- vmm: ${vmm.enabled ? "enabled" : "disabled"} ${vmm.status}`.trim(),
        ].join("\n"),
      };
    }
    if (action === "luaskills" || action === "sync") {
      const tools = await client.listLuaSkillTools(context);
      return {
        text: formatToolSyncResult(tools, action === "sync"),
      };
    }
    if (action === "list") {
      const response = await client.listInstalledLuaSkills(context);
      return { text: response.text || response.message || "No LuaSkills inventory returned." };
    }
    if (action === "install") {
      const source = tokens[1];
      if (!source) {
        return { text: "Usage: /vulcan install <source> [sourceType]" };
      }
      const response = await client.runLuaSkillLifecycle({
        action: "install",
        source,
        sourceType: tokens[2],
        context,
      });
      return { text: appendRefreshNotice(response.text || response.message || "") };
    }
    if (action === "update" || action === "uninstall") {
      const skillId = tokens[1];
      if (!skillId) {
        return { text: `Usage: /vulcan ${action} <skillId>` };
      }
      const response = await client.runLuaSkillLifecycle({ action, skillId, context });
      return { text: appendRefreshNotice(response.text || response.message || "") };
    }
    if (action === "reload") {
      const response = await client.reloadRuntimeConfigs(context);
      return { text: response.text || response.message || "Runtime configs reloaded." };
    }
    return { text: buildUsage() };
  } catch (error) {
    api.logger.warn?.(`vulcan-tools: command failed: ${String(error)}`);
    if (isVulcanHostTransportError(error)) {
      ensureVulcanHostReconnectScheduled(config, { logger: api.logger, force: true });
      return { text: `${HOST_UNAVAILABLE_MESSAGE}\n\n当前目标：${describeClientTarget(config)}` };
    }
    return { text: `Vulcan command failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// tokenizeArgs splits command args without attempting shell-level quoting.
// tokenizeArgs 拆分命令参数，但不尝试实现 shell 级引用语法。
function tokenizeArgs(args: string | undefined): string[] {
  return (args ?? "").split(/\s+/u).map((token) => token.trim()).filter(Boolean);
}

// normalizeAction maps empty or unknown tokens to help.
// normalizeAction 将空值或未知 token 映射到 help。
function normalizeAction(value: string | undefined): VulcanCommandAction {
  const normalized = (value ?? "help").toLowerCase();
  if (
    normalized === "status" ||
    normalized === "luaskills" ||
    normalized === "sync" ||
    normalized === "list" ||
    normalized === "install" ||
    normalized === "update" ||
    normalized === "uninstall" ||
    normalized === "reload"
  ) {
    return normalized;
  }
  return "help";
}

// formatToolSyncResult renders LuaSkills tool descriptors and OpenClaw refresh guidance.
// formatToolSyncResult 渲染 LuaSkills 工具描述和 OpenClaw 刷新提示。
function formatToolSyncResult(tools: VulcanToolDescriptor[], includeSyncNotice: boolean): string {
  const lines = [
    "# Vulcan LuaSkills Tools",
    tools.length === 0 ? "No dynamic LuaSkills tools are currently exposed." : "",
    ...tools.map((tool) => `- ${tool.name}: ${tool.description || "(no description)"}`),
  ].filter(Boolean);
  if (includeSyncNotice) {
    lines.push(
      "",
      "This command only queries the live vulcan-host inventory. To make these tools first-class OpenClaw tools, run `pnpm sync:tools` in the plugin repository, then run `openclaw plugins registry --refresh`.",
      "If OpenClaw still shows the old tool set, restart/reload the Gateway because source and manifest changes are cold-read by the plugin runtime.",
    );
  }
  return lines.join("\n");
}

// appendRefreshNotice adds the OpenClaw refresh requirement after lifecycle-changing operations.
// appendRefreshNotice 在改变生命周期的操作后补充 OpenClaw 刷新要求。
function appendRefreshNotice(text: string): string {
  return [
    text.trim() || "LuaSkills lifecycle operation completed.",
    "",
    "LuaSkills tool ids may have changed. Run `/vulcan sync` to inspect the live inventory, run `pnpm sync:tools` in the plugin repository to update generated OpenClaw contracts, then run `openclaw plugins registry --refresh` and restart/reload the Gateway if needed.",
  ].join("\n");
}

// buildUsage renders the command help text.
// buildUsage 渲染命令帮助文本。
function buildUsage(): string {
  return [
    "# Vulcan Command",
    "- /vulcan status",
    "- /vulcan luaskills",
    "- /vulcan sync",
    "- /vulcan list",
    "- /vulcan install <source> [sourceType]",
    "- /vulcan update <skillId>",
    "- /vulcan uninstall <skillId>",
    "- /vulcan reload",
  ].join("\n");
}
