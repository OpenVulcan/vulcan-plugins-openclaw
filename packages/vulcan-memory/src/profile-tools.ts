// Optional profile-adjust tool for OpenClaw's Vulcan memory plugin.
// 本文件实现 OpenClaw 的 Vulcan memory 插件使用的画像调整工具。

import {
  buildToolHostContext,
  buildVulcanCapabilityUnavailableMessage,
  createVulcanHostClient,
  ensureVulcanHostReconnectScheduled,
  errorToolResult,
  isVulcanHostConnectionUnavailable,
  isVulcanHostTransportError,
  jsonToolResult,
  peekVulcanHostConnectionSnapshot,
  type JsonValue,
  type ResolvedVulcanConfig,
  type VulcanVmmProfileAdjustResponse,
} from "@vulcan-plugins-openclaw/shared";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { resolveVulcanMemoryScope } from "./vmm-scope.js";
import { resolveGeneratedDescription, resolveGeneratedSchema } from "./tools.js";

// PROFILE_ADJUST_TOOL_NAME is the canonical host-facing tool id synchronized from vulcan-host.
// PROFILE_ADJUST_TOOL_NAME 是从 vulcan-host 同步下来的标准宿主工具标识。
const PROFILE_ADJUST_TOOL_NAME = "vulcan_profile_adjust";

// ProfileAdjustSchema is the local bootstrap fallback used before descriptor sync has completed.
// ProfileAdjustSchema 是 descriptor 同步完成前使用的本地引导期回退 schema。
const ProfileAdjustSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    scope: {
      type: "string",
      enum: ["user", "project", "team", "space"],
      description:
        "Profile scope to adjust. user and project target the current bound identities directly; team and space reuse the current project binding lineage.",
    },
    instruction: {
      type: "string",
      minLength: 1,
      description:
        "Explicit natural-language correction or addition for the selected long-lived profile. Use this only when the user clearly asks to correct, reinforce, remove, or add durable profile information.",
    },
  },
  required: ["scope", "instruction"],
} as const;

// CreateProfileToolParams groups the dependencies required to build the OpenClaw profile-adjust tool.
// CreateProfileToolParams 汇总构造 OpenClaw 画像调整工具所需的依赖。
interface CreateProfileToolParams {
  api: OpenClawPluginApi;
  config: ResolvedVulcanConfig;
  ctx: OpenClawPluginToolContext;
}

// PROFILE_UNAVAILABLE_MESSAGE keeps one stable operator-facing failure text while vulcan-host reconnects.
// PROFILE_UNAVAILABLE_MESSAGE 为 vulcan-host 重连期间保留一条稳定的面向操作者失败文本。
const PROFILE_UNAVAILABLE_MESSAGE = buildVulcanCapabilityUnavailableMessage("host");

// createVulcanProfileAdjustTool creates the OpenClaw-visible natural-language profile correction tool.
// createVulcanProfileAdjustTool 创建对 OpenClaw 可见的自然语言画像纠偏工具。
export function createVulcanProfileAdjustTool(params: CreateProfileToolParams): AnyAgentTool | null {
  if (!params.config.enabled || !params.config.memory.enabled) {
    return null;
  }
  return {
    name: PROFILE_ADJUST_TOOL_NAME,
    label: "Vulcan Profile Adjust",
    description: resolveGeneratedDescription(
      PROFILE_ADJUST_TOOL_NAME,
      "Adjust one durable VMM profile with an explicit natural-language instruction. The system already performs automatic profile extraction and refresh, so use this tool only when the user clearly asks to correct, reinforce, remove, or add long-lived profile information.",
    ),
    parameters: resolveGeneratedSchema(PROFILE_ADJUST_TOOL_NAME, ProfileAdjustSchema),
    async execute(_toolCallId, rawParams) {
      const input = readProfileAdjustParams(rawParams);
      if (!input) {
        return errorToolResult("scope must be one of user/project/team/space and instruction must be a non-empty string.");
      }
      const unavailable = failFastWhenHostDisconnected(params);
      if (unavailable) {
        return unavailable;
      }
      try {
        const client = createVulcanHostClient(params.config);
        const scopeResult = await resolveVulcanMemoryScope({
          client,
          config: params.config,
          context: buildToolHostContext(params.ctx, params.config),
          requireSession: false,
          purpose: "profile",
        });
        if (!("scope" in scopeResult)) {
          return errorToolResult(scopeResult.error, scopeResult);
        }
        const response = await client.applyVmmProfileInstruction({
          context: buildToolHostContext(params.ctx, params.config),
          userId: scopeResult.scope.user.userId,
          projectId: scopeResult.scope.project.projectId,
          scope: input.scope,
          instruction: input.instruction,
        });
        return jsonToolResult(
          {
            instructionId: response.instructionId,
            scope: input.scope,
            acceptedNodeCount: response.acceptedNodes.length,
            retiredNodeCount: response.retiredNodes.length,
            reviewReason: response.reviewReason,
            traceId: response.traceId ?? "",
            acceptedNodes: response.acceptedNodes,
            retiredNodes: response.retiredNodes,
          } as unknown as JsonValue,
          {
            summary: formatProfileAdjustText(response, input.scope),
          },
        );
      } catch (error) {
        params.api.logger.warn?.(`vulcan-memory: ${PROFILE_ADJUST_TOOL_NAME} failed: ${String(error)}`);
        const degraded = mapProfileTransportError(params, error);
        if (degraded) {
          return degraded;
        }
        return errorToolResult(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

// listVulcanProfileToolNames returns the stable OpenClaw registration list for profile-adjust tools.
// listVulcanProfileToolNames 返回画像调整工具在 OpenClaw 中使用的稳定注册名称列表。
export function listVulcanProfileToolNames(): string[] {
  return [PROFILE_ADJUST_TOOL_NAME];
}

// readProfileAdjustParams validates the AI-facing profile-adjust input.
// readProfileAdjustParams 校验面向 AI 的画像调整输入。
function readProfileAdjustParams(value: unknown): { scope: "user" | "project" | "team" | "space"; instruction: string } | null {
  const record = asRecord(value);
  const scope = typeof record.scope === "string" ? record.scope.trim() : "";
  const instruction = typeof record.instruction === "string" ? record.instruction.trim() : "";
  if (!instruction) {
    return null;
  }
  if (scope !== "user" && scope !== "project" && scope !== "team" && scope !== "space") {
    return null;
  }
  return {
    scope,
    instruction,
  };
}

// failFastWhenHostDisconnected returns one immediate profile-adjust failure when the shared host state is already degraded.
// failFastWhenHostDisconnected 会在共享 host 状态已进入降级态时立即返回一条画像调整失败结果。
function failFastWhenHostDisconnected(params: CreateProfileToolParams) {
  if (!isVulcanHostConnectionUnavailable(params.config)) {
    return null;
  }
  ensureVulcanHostReconnectScheduled(params.config, { logger: params.api.logger });
  params.api.logger.debug?.(
    `vulcan-memory: ${peekVulcanHostConnectionSnapshot(params.config).target} is reconnecting; fail fast for ${PROFILE_ADJUST_TOOL_NAME}.`,
  );
  return errorToolResult(PROFILE_UNAVAILABLE_MESSAGE);
}

// mapProfileTransportError normalizes transport failures into one stable degraded-state tool result while preserving non-transport errors for diagnostics.
// mapProfileTransportError 会把传输层失败归一化为稳定的降级态工具结果，同时保留非传输错误供诊断。
function mapProfileTransportError(params: CreateProfileToolParams, error: unknown) {
  if (!isVulcanHostTransportError(error)) {
    return null;
  }
  ensureVulcanHostReconnectScheduled(params.config, { logger: params.api.logger, force: true });
  return errorToolResult(PROFILE_UNAVAILABLE_MESSAGE);
}

// formatProfileAdjustText renders one concise readable summary for model-side follow-up.
// formatProfileAdjustText 为模型侧后续处理渲染一段简洁可读摘要。
function formatProfileAdjustText(
  response: VulcanVmmProfileAdjustResponse,
  scope: "user" | "project" | "team" | "space",
): string {
  const lines = [
    `Vulcan profile adjustment accepted for ${scope}.`,
    `instruction_id=${response.instructionId || "unknown"}`,
    `accepted_nodes=${response.acceptedNodes.length}`,
    `retired_nodes=${response.retiredNodes.length}`,
  ];
  if (response.reviewReason.trim()) {
    lines.push(`review_reason=${response.reviewReason.trim()}`);
  }
  if (response.traceId?.trim()) {
    lines.push(`trace_id=${response.traceId.trim()}`);
  }
  const acceptedPreview = response.acceptedNodes
    .map((entry) => entry.content.trim())
    .filter(Boolean)
    .slice(0, 3);
  if (acceptedPreview.length > 0) {
    lines.push("accepted_preview:");
    for (const item of acceptedPreview) {
      lines.push(`- ${item}`);
    }
  }
  return lines.join("\n");
}

// asRecord safely narrows unknown tool parameters into a plain object record.
// asRecord 将未知工具参数安全收窄为普通对象记录。
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
