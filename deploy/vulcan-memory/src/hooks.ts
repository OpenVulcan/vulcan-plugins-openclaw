// Prompt and lifecycle hooks for full-mode Vulcan memory integration.
// 本文件实现 Vulcan 记忆完整模式接入所需的 prompt 与生命周期 hooks。

import {
  buildHookHostContext,
  createVulcanHostClient,
  type ResolvedVulcanConfig,
  type VulcanVmmTurnTimelineItem,
} from "@vulcan-plugins-openclaw/shared";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { formatVulcanMemorySearchText, searchVulcanMemoryEntries } from "./manager.js";
import { resolveVulcanMemoryScope } from "./vmm-scope.js";

// registerVulcanMemoryHooks registers full-mode precheck and postaction hooks for OpenClaw hosts that support them.
// registerVulcanMemoryHooks 为支持完整模式的 OpenClaw 宿主注册 precheck 与 postaction hooks。
export function registerVulcanMemoryHooks(
  api: OpenClawPluginApi,
  config: ResolvedVulcanConfig,
): void {
  api.on(
    "before_prompt_build",
    async (event, ctx) => await handleBeforePromptBuild(api, config, event, ctx),
    { timeoutMs: config.memory.timeoutMs },
  );
  api.on("agent_end", async (event, ctx) => {
    await handleAgentEnd(api, config, event, ctx);
  });
}

// handleBeforePromptBuild prefers VMM precheck and falls back to direct grouped search when session-bound recall is unavailable.
// handleBeforePromptBuild 优先使用 VMM precheck，并在无法进行会话绑定召回时退回到直接分组检索。
async function handleBeforePromptBuild(
  api: OpenClawPluginApi,
  config: ResolvedVulcanConfig,
  event: unknown,
  ctx: Record<string, unknown>,
): Promise<{ prependContext?: string } | undefined> {
  if (!config.enabled || !config.memory.enabled || !config.memory.autoRecall) {
    return undefined;
  }
  const eventRecord = asRecord(event);
  const query = extractRecallQuery(eventRecord);
  if (!query) {
    return undefined;
  }
  try {
    const client = createVulcanHostClient(config);
    const hostContext = buildHookHostContext(eventRecord, ctx, config);
    const resolved = await resolveVulcanMemoryScope({
      client,
      context: hostContext,
      requireSession: true,
      purpose: "precheck",
    });
    if ("scope" in resolved && resolved.scope.sessionId) {
      const response = await client.preCheckVmm({
        context: hostContext,
        sessionId: resolved.scope.sessionId,
        userId: resolved.scope.user.userId,
        projectId: resolved.scope.project.projectId,
        userContent: query,
        recallMode: "session_compact",
      });
      if (!response.shouldInject || response.contextItems.length === 0) {
        return undefined;
      }
      return {
        prependContext: buildPrecheckContext(response.contextItems.map((item) => item.text)),
      };
    }

    // Some host runs still lack a stable session identity, so grouped search remains the safe degraded recall path.
    // 某些宿主运行仍缺少稳定 session 身份，因此分组检索仍然是安全的降级召回路径。
    const fallback = await searchVulcanMemoryEntries({
      client,
      context: hostContext,
      queries: [query],
      topK: config.memory.recallTopK,
    });
    if ("error" in fallback) {
      return undefined;
    }
    return {
      prependContext: [
        "## Vulcan Memory Recall",
        formatVulcanMemorySearchText({ hitsByQuery: fallback.hitsByQuery }),
      ].join("\n\n"),
    };
  } catch (error) {
    api.logger.warn?.(`vulcan-memory: before_prompt_build recall skipped: ${String(error)}`);
    return undefined;
  }
}

// handleAgentEnd appends one durable VMM postaction turn when the operator explicitly enables automatic writeback.
// handleAgentEnd 在操作者显式开启自动写回时追加一条持久化的 VMM postaction turn。
async function handleAgentEnd(
  api: OpenClawPluginApi,
  config: ResolvedVulcanConfig,
  event: unknown,
  ctx: Record<string, unknown>,
): Promise<void> {
  if (!config.enabled || !config.memory.enabled || !config.memory.autoPostAction) {
    return;
  }
  const eventRecord = asRecord(event);
  const payload = buildPostActionPayload(eventRecord);
  if (!payload) {
    return;
  }
  try {
    const client = createVulcanHostClient(config);
    const hostContext = buildHookHostContext(eventRecord, ctx, config);
    const resolved = await resolveVulcanMemoryScope({
      client,
      context: hostContext,
      requireSession: true,
      purpose: "postaction",
    });
    if (!("scope" in resolved) || !resolved.scope.sessionId) {
      return;
    }
    const response = await client.postActionVmm({
      context: hostContext,
      sessionId: resolved.scope.sessionId,
      userId: resolved.scope.user.userId,
      projectId: resolved.scope.project.projectId,
      userContent: payload.userContent,
      assistantContent: payload.assistantContent,
      timeline: payload.timeline,
    });
    if (!response.accepted) {
      api.logger.warn?.("vulcan-memory: postaction request was rejected by VMM.");
    }
  } catch (error) {
    api.logger.warn?.(`vulcan-memory: postaction write skipped: ${String(error)}`);
  }
}

// extractRecallQuery chooses the safest current prompt text as the VMM recall seed.
// extractRecallQuery 选择最安全的当前 prompt 文本作为 VMM 召回种子。
function extractRecallQuery(event: Record<string, unknown>): string | undefined {
  const prompt = typeof event.prompt === "string" ? event.prompt.trim() : "";
  if (prompt) {
    return prompt.slice(0, 2_000);
  }
  const messages = Array.isArray(event.messages) ? event.messages : [];
  const lastUser = [...messages].reverse().find((message) => {
    return Boolean(
      message &&
        typeof message === "object" &&
        !Array.isArray(message) &&
        (message as Record<string, unknown>).role === "user",
    );
  }) as Record<string, unknown> | undefined;
  const content = typeof lastUser?.content === "string" ? lastUser.content.trim() : "";
  return content ? content.slice(0, 2_000) : undefined;
}

// buildPrecheckContext assembles the compact prompt section injected ahead of the active OpenClaw user turn.
// buildPrecheckContext 组装注入到当前 OpenClaw 用户回合前的紧凑提示词片段。
function buildPrecheckContext(items: string[]): string {
  return [
    "## Vulcan Memory Recall",
    items
      .map((item, index) => `${index + 1}. ${item.trim()}`)
      .filter(Boolean)
      .join("\n\n"),
  ].join("\n\n");
}

// buildPostActionPayload extracts one conservative text-only postaction payload from the completed turn event.
// buildPostActionPayload 从已完成回合事件中提取一份保守的纯文本 postaction 载荷。
function buildPostActionPayload(
  event: Record<string, unknown>,
): {
  userContent: string;
  assistantContent: string;
  timeline: VulcanVmmTurnTimelineItem[];
} | null {
  if (event.success === false || event.cancelled === true) {
    return null;
  }
  const userContent = extractRoleMessageText(event, "user", 4_000);
  const assistantContent = extractRoleMessageText(event, "assistant", 6_000);
  if (!userContent && !assistantContent) {
    return null;
  }
  return {
    userContent,
    assistantContent,
    timeline: extractTimelineItems(event),
  };
}

// extractTimelineItems reads a best-effort middle timeline from event payloads without assuming one stable OpenClaw hook schema.
// extractTimelineItems 以尽力而为的方式从事件载荷中读取中间 timeline，不假设存在唯一稳定的 OpenClaw hook 结构。
function extractTimelineItems(event: Record<string, unknown>): VulcanVmmTurnTimelineItem[] {
  const rawTimeline = Array.isArray(event.timeline) ? event.timeline : [];
  return rawTimeline
    .map((entry) => {
      const record = asRecord(entry);
      const type = typeof record.type === "string" && record.type.trim() ? record.type.trim() : "";
      const content = extractContentText(record.content ?? record.text ?? record.outputText).trim();
      return type && content ? { type, content } : null;
    })
    .filter((entry): entry is VulcanVmmTurnTimelineItem => Boolean(entry));
}

// extractRoleMessageText finds the latest message for one role and safely extracts textual content.
// extractRoleMessageText 查找某个角色的最后一条消息，并安全提取文本内容。
function extractRoleMessageText(
  event: Record<string, unknown>,
  role: "assistant" | "user",
  maxChars: number,
): string {
  const messages = Array.isArray(event.messages) ? event.messages : [];
  const message = [...messages].reverse().find((entry) => {
    const record = asRecord(entry);
    return record.role === role;
  });
  const text = extractContentText(asRecord(message).content).trim() || extractRoleFallbackText(event, role);
  return text.slice(0, maxChars);
}

// extractRoleFallbackText reads common hook fallback fields when agent_end does not include normalized messages.
// extractRoleFallbackText 在 agent_end 未携带标准 messages 时读取常见的回退字段。
function extractRoleFallbackText(event: Record<string, unknown>, role: "assistant" | "user"): string {
  if (role === "user") {
    return extractContentText(event.prompt ?? event.userMessage).trim();
  }
  return extractContentText(event.response ?? event.output ?? event.result).trim();
}

// extractContentText supports both string and block-array message content shapes seen in OpenClaw events.
// extractContentText 支持 OpenClaw 事件里常见的字符串与块数组两种消息内容形态。
function extractContentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  const record = asRecord(content);
  if (typeof record.text === "string") {
    return record.text;
  }
  if (typeof record.outputText === "string") {
    return record.outputText;
  }
  const blocks = Array.isArray(content) ? content : [];
  return blocks
    .map((block) => {
      const item = asRecord(block);
      return typeof item.text === "string"
        ? item.text
        : typeof item.outputText === "string"
          ? item.outputText
          : "";
    })
    .filter(Boolean)
    .join("\n");
}

// asRecord safely narrows unknown hook payloads into plain objects.
// asRecord 将未知 hook 载荷安全收窄为普通对象。
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
