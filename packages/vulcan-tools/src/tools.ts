// Tool definitions for the Vulcan LuaSkills OpenClaw plugin.
// 本文件定义 Vulcan LuaSkills OpenClaw 插件的工具。

import {
  buildVulcanCapabilityUnavailableMessage,
  buildToolHostContext,
  createVulcanHostClient,
  ensureVulcanHostReconnectScheduled,
  errorToolResult,
  isVulcanHostConnectionUnavailable,
  isVulcanHostTransportError,
  normalizeVulcanToolResult,
  peekVulcanHostConnectionSnapshot,
  type JsonObject,
  type ResolvedVulcanConfig,
  type VulcanToolDescriptor,
} from "@vulcan-plugins-openclaw/shared";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";

// LuaSkillDispatcherSchema describes the fallback dispatcher input shown to the model.
// LuaSkillDispatcherSchema 描述展示给模型的降级 dispatcher 入参。
const LuaSkillDispatcherSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    toolName: {
      type: "string",
      description:
        "Canonical LuaSkills tool name returned by /vulcan luaskills or a previously synchronized Vulcan tool list.",
    },
    arguments: {
      type: "object",
      description:
        "JSON object passed to the target LuaSkills tool. Preserve the target tool's parameter names exactly.",
      additionalProperties: true,
    },
  },
  required: ["toolName"],
} as const;

// LuaSkillDispatcherParams is the normalized dispatcher input used after validation.
// LuaSkillDispatcherParams 是校验后使用的归一化 dispatcher 输入。
interface LuaSkillDispatcherParams {
  toolName: string;
  arguments: JsonObject;
}

// CreateLuaSkillDispatcherToolParams groups dependencies needed to create the dispatcher tool.
// CreateLuaSkillDispatcherToolParams 汇总创建 dispatcher 工具所需的依赖。
interface CreateLuaSkillDispatcherToolParams {
  api: OpenClawPluginApi;
  config: ResolvedVulcanConfig;
  ctx: OpenClawPluginToolContext;
}

// CreateGeneratedLuaSkillToolParams groups dependencies for a first-class LuaSkills proxy.
// CreateGeneratedLuaSkillToolParams 汇总一等 LuaSkills 代理工具所需的依赖。
interface CreateGeneratedLuaSkillToolParams extends CreateLuaSkillDispatcherToolParams {
  descriptor: VulcanToolDescriptor;
}

// LUASKILLS_UNAVAILABLE_MESSAGE keeps one stable failure text for all LuaSkills dispatch surfaces while vulcan-host reconnects.
// LUASKILLS_UNAVAILABLE_MESSAGE 为 vulcan-host 重连期间的所有 LuaSkills 调度表面保留一条稳定失败文本。
const LUASKILLS_UNAVAILABLE_MESSAGE = buildVulcanCapabilityUnavailableMessage("luaskills");

// failFastWhenLuaSkillsDisconnected returns one immediate error result when shared host state is already degraded.
// failFastWhenLuaSkillsDisconnected 会在共享 host 状态已降级时立即返回错误结果。
function failFastWhenLuaSkillsDisconnected(params: CreateLuaSkillDispatcherToolParams) {
  if (!isVulcanHostConnectionUnavailable(params.config)) {
    return null;
  }
  ensureVulcanHostReconnectScheduled(params.config, { logger: params.api.logger });
  params.api.logger.debug?.(
    `vulcan-tools: ${peekVulcanHostConnectionSnapshot(params.config).target} is reconnecting; fail fast for LuaSkills tool call.`,
  );
  return errorToolResult(LUASKILLS_UNAVAILABLE_MESSAGE);
}

// mapLuaSkillsTransportError converts transport failures into one stable unavailable result while keeping business errors untouched.
// mapLuaSkillsTransportError 会把传输失败转换成稳定的不可用结果，同时保留业务错误原文。
function mapLuaSkillsTransportError(
  params: CreateLuaSkillDispatcherToolParams,
  error: unknown,
) {
  if (!isVulcanHostTransportError(error)) {
    return null;
  }
  ensureVulcanHostReconnectScheduled(params.config, { logger: params.api.logger, force: true });
  return errorToolResult(LUASKILLS_UNAVAILABLE_MESSAGE);
}

// createLuaSkillDispatcherTool creates a fallback dynamic LuaSkills dispatcher tool.
// createLuaSkillDispatcherTool 创建一个降级用的 LuaSkills 动态 dispatcher 工具。
export function createLuaSkillDispatcherTool(
  params: CreateLuaSkillDispatcherToolParams,
): AnyAgentTool | null {
  if (!params.config.enabled || !params.config.tools.enabled || !params.config.tools.dispatcherEnabled) {
    return null;
  }
  return {
    name: "vulcan_luaskill_call",
    label: "Vulcan LuaSkill Call",
    description:
      "Fallback dispatcher for calling a LuaSkills tool through vulcan-host. Prefer native per-tool Vulcan tools after the plugin manifest has been synchronized. Use this only when the requested LuaSkills tool is not registered as a first-class OpenClaw tool yet.",
    parameters: LuaSkillDispatcherSchema,
    async execute(_toolCallId, rawParams) {
      const input = readLuaSkillDispatcherParams(rawParams);
      if (!input) {
        return errorToolResult("toolName is required and must be a non-empty string.");
      }
      const unavailable = failFastWhenLuaSkillsDisconnected(params);
      if (unavailable) {
        return unavailable;
      }

      // Forward only after OpenClaw context has been converted, so AI never supplies session ids manually.
      // 只有在转换 OpenClaw 上下文后才转发，确保 AI 永远不需要手动提供 session id。
      try {
        const client = createVulcanHostClient(params.config);
        const response = await client.callLuaSkillTool({
          context: buildToolHostContext(params.ctx, params.config),
          toolName: input.toolName,
          arguments: input.arguments,
        });
        return normalizeVulcanToolResult(response);
      } catch (error) {
        params.api.logger.warn?.(`vulcan-tools: LuaSkill dispatcher failed: ${String(error)}`);
        const unavailable = mapLuaSkillsTransportError(params, error);
        if (unavailable) {
          return unavailable;
        }
        return errorToolResult(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

// createGeneratedLuaSkillTool creates a statically declared per-tool LuaSkills proxy.
// createGeneratedLuaSkillTool 创建一个静态声明的 per-tool LuaSkills 代理工具。
export function createGeneratedLuaSkillTool(
  params: CreateGeneratedLuaSkillToolParams,
): AnyAgentTool | null {
  if (!params.config.enabled || !params.config.tools.enabled) {
    return null;
  }
  return {
    name: params.descriptor.name,
    label: params.descriptor.name,
    description:
      params.descriptor.description ||
      `Call the Vulcan LuaSkills tool "${params.descriptor.name}" through vulcan-host.`,
    parameters: params.descriptor.inputSchema,
    async execute(_toolCallId, rawParams) {
      const args = readGeneratedLuaSkillParams(rawParams);
      const unavailable = failFastWhenLuaSkillsDisconnected(params);
      if (unavailable) {
        return unavailable;
      }

      // Per-tool proxies preserve AI-facing schemas while still injecting trusted OpenClaw context here.
      // per-tool 代理保留面向 AI 的 schema，同时仍在这里注入受信任的 OpenClaw 上下文。
      try {
        const client = createVulcanHostClient(params.config);
        const response = await client.callLuaSkillTool({
          context: buildToolHostContext(params.ctx, params.config),
          toolName: params.descriptor.name,
          arguments: args,
        });
        return normalizeVulcanToolResult(response);
      } catch (error) {
        params.api.logger.warn?.(
          `vulcan-tools: generated LuaSkill tool failed (${params.descriptor.name}): ${String(error)}`,
        );
        const unavailable = mapLuaSkillsTransportError(params, error);
        if (unavailable) {
          return unavailable;
        }
        return errorToolResult(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

// readLuaSkillDispatcherParams validates and normalizes model-provided dispatcher params.
// readLuaSkillDispatcherParams 校验并归一化模型提供的 dispatcher 参数。
function readLuaSkillDispatcherParams(value: unknown): LuaSkillDispatcherParams | null {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  const toolName = typeof record.toolName === "string" ? record.toolName.trim() : "";
  if (!toolName) {
    return null;
  }
  const args =
    record.arguments && typeof record.arguments === "object" && !Array.isArray(record.arguments)
      ? (record.arguments as JsonObject)
      : {};
  return {
    toolName,
    arguments: args,
  };
}

// readGeneratedLuaSkillParams safely narrows model-provided per-tool parameters into JSON object args.
// readGeneratedLuaSkillParams 将模型提供的 per-tool 参数安全收窄为 JSON 对象入参。
function readGeneratedLuaSkillParams(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}
