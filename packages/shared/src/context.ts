// OpenClaw context conversion helpers for vulcan-host requests.
// 本文件提供面向 vulcan-host 请求的 OpenClaw 上下文转换工具。

import type {
  OpenClawPluginToolContext,
  PluginCommandContext,
} from "openclaw/plugin-sdk/plugin-entry";
import type { ResolvedVulcanConfig, VulcanHostContext } from "./types.js";

// createRequestId creates a compact correlation id for diagnostics without implying session state.
// createRequestId 创建紧凑诊断关联 ID，但不表达会话状态。
export function createRequestId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// buildBaseHostContext creates the shared trusted identity part used by every vulcan-host call.
// buildBaseHostContext 创建每个 vulcan-host 调用都会使用的共享受信任身份部分。
export function buildBaseHostContext(
  config: ResolvedVulcanConfig,
  requestPrefix: string,
): VulcanHostContext {
  return {
    clientName: config.clientName,
    clientVersion: config.clientVersion,
    requestId: createRequestId(requestPrefix),
    hostKind: "openclaw",
  };
}

// buildToolHostContext converts OpenClaw tool context into Vulcan session context.
// buildToolHostContext 将 OpenClaw 工具上下文转换为 Vulcan 会话上下文。
export function buildToolHostContext(
  ctx: OpenClawPluginToolContext,
  config: ResolvedVulcanConfig,
): VulcanHostContext {
  return {
    ...buildBaseHostContext(config, "tool"),
    sessionKey: readOptionalString(ctx.sessionKey),
    sessionId: readOptionalString(ctx.sessionId),
    agentId: readOptionalString(ctx.agentId),
    workspaceDir: readOptionalString(ctx.workspaceDir),
    channelId: readOptionalText(ctx.messageChannel),
    messageChannel: readOptionalText(ctx.messageChannel),
    agentAccountId: readOptionalString(ctx.agentAccountId),
    requesterSenderId: readOptionalString(ctx.requesterSenderId),
  };
}

// buildCommandHostContext converts OpenClaw command context into Vulcan session context.
// buildCommandHostContext 将 OpenClaw 命令上下文转换为 Vulcan 会话上下文。
export function buildCommandHostContext(
  ctx: PluginCommandContext,
  config: ResolvedVulcanConfig,
): VulcanHostContext {
  return {
    ...buildBaseHostContext(config, "command"),
    sessionKey: readOptionalString(ctx.sessionKey),
    sessionId: readOptionalString(ctx.sessionId),
    channelId: readOptionalString(ctx.channelId),
    channelName: readOptionalString(ctx.channel),
    conversationId:
      readOptionalText(ctx.messageThreadId) ??
      readOptionalString(ctx.threadParentId) ??
      readOptionalString(ctx.channelId),
    senderId: readOptionalString(ctx.senderId),
    accountId: readOptionalString(ctx.accountId),
    messageThreadId: readOptionalText(ctx.messageThreadId),
    threadParentId: readOptionalString(ctx.threadParentId),
  };
}

// buildHookHostContext converts a typed hook payload into Vulcan session context.
// buildHookHostContext 将 typed hook 载荷转换为 Vulcan 会话上下文。
export function buildHookHostContext(
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
  config: ResolvedVulcanConfig,
): VulcanHostContext {
  return {
    ...buildBaseHostContext(config, "hook"),
    sessionKey: readOptionalString(ctx.sessionKey ?? event.sessionKey),
    sessionId: readOptionalString(ctx.sessionId ?? event.sessionId),
    agentId: readOptionalString(ctx.agentId ?? event.agentId),
    workspaceDir: readOptionalString(ctx.workspaceDir ?? event.workspaceDir),
    channelId: readOptionalString(ctx.channelId ?? event.channelId ?? ctx.messageChannel),
    channelName: readOptionalString(ctx.channel ?? event.channel),
    messageChannel: readOptionalString(ctx.messageChannel ?? event.messageChannel),
    conversationId:
      readOptionalText(ctx.messageThreadId ?? event.messageThreadId) ??
      readOptionalString(ctx.threadParentId ?? event.threadParentId) ??
      readOptionalString(ctx.channelId ?? event.channelId),
    rootSessionId: readOptionalString(ctx.rootSessionId ?? event.rootSessionId),
    agentAccountId: readOptionalString(ctx.agentAccountId ?? event.agentAccountId),
    requesterSenderId: readOptionalString(ctx.requesterSenderId ?? event.requesterSenderId),
    senderId: readOptionalString(ctx.senderId ?? event.senderId),
    accountId: readOptionalString(ctx.accountId ?? event.accountId),
    messageThreadId: readOptionalText(ctx.messageThreadId ?? event.messageThreadId),
    threadParentId: readOptionalString(ctx.threadParentId ?? event.threadParentId),
    runId: readOptionalString(ctx.runId ?? event.runId),
    turnId: readOptionalString(ctx.turnId ?? event.turnId),
    userMessage: readOptionalString(event.prompt ?? event.userMessage),
  };
}

// readOptionalString preserves non-empty strings and drops all other values.
// readOptionalString 保留非空字符串，并丢弃其他值。
function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// readOptionalText preserves compact string-like identifiers, including numeric ids converted to text.
// readOptionalText 保留紧凑的字符串型标识，并支持把数字 ID 转成文本。
function readOptionalText(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return readOptionalString(value);
}
