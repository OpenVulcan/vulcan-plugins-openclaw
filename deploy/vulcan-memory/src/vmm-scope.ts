// Scope resolution helpers for bridging OpenClaw runtime identity into Vulcan Memory Mesh coordinates.
// 本文件负责把 OpenClaw 运行时身份桥接成 Vulcan Memory Mesh 所需的作用域坐标。

import { createHash } from "node:crypto";
import path from "node:path";
import type {
  VulcanHostAdapterRuntime,
  VulcanHostClient,
  VulcanHostContext,
  VulcanVmmResolvedProject,
  VulcanVmmResolvedUser,
} from "@vulcan-plugins-openclaw/shared";

// VMM_HOST_TEAM_NAME reserves one deterministic team namespace for host-managed projects.
// VMM_HOST_TEAM_NAME 为宿主管理项目预留一个确定性的 team 命名空间。
const VMM_HOST_TEAM_NAME = "Hosts";

// VMM_OPENCLAW_SPACE_NAME reserves one deterministic space namespace for OpenClaw-derived projects.
// VMM_OPENCLAW_SPACE_NAME 为 OpenClaw 派生项目预留一个确定性的 space 命名空间。
const VMM_OPENCLAW_SPACE_NAME = "OpenClaw";

// HASH_LENGTH keeps generated user/project references short while still collision-resistant enough for local routing.
// HASH_LENGTH 让生成的用户/项目引用保持简短，同时对本地路由拥有足够的抗碰撞性。
const HASH_LENGTH = 10;

// MAX_SEGMENT_LENGTH avoids creating overly long VMM path segments from workspace or channel labels.
// MAX_SEGMENT_LENGTH 避免从 workspace 或频道标签生成过长的 VMM 路径段。
const MAX_SEGMENT_LENGTH = 48;

// VulcanResolvedMemoryScope carries the fully resolved VMM identities needed by search, precheck, and postaction flows.
// VulcanResolvedMemoryScope 承载 search、precheck 与 postaction 流程所需的完整 VMM 身份。
export interface VulcanResolvedMemoryScope {
  runtime: VulcanHostAdapterRuntime;
  sessionId?: string | undefined;
  workmemId?: string | undefined;
  identityReady: boolean;
  degradedReasons: string[];
  userRef: string;
  user: VulcanVmmResolvedUser;
  projectPath: string;
  project: VulcanVmmResolvedProject;
}

// VulcanResolvedMemoryScopeError preserves normalized runtime diagnostics when VMM scope resolution cannot complete.
// VulcanResolvedMemoryScopeError 在 VMM 作用域解析失败时保留归一化运行时诊断信息。
export interface VulcanResolvedMemoryScopeError {
  error: string;
  runtime?: VulcanHostAdapterRuntime | undefined;
  sessionId?: string | undefined;
  workmemId?: string | undefined;
  identityReady: boolean;
  degradedReasons: string[];
  userRef?: string | undefined;
  projectPath?: string | undefined;
}

// VulcanResolvedMemoryScopeResult reports either one usable scope or one structured diagnostic failure.
// VulcanResolvedMemoryScopeResult 用于返回可用作用域，或一条结构化诊断失败信息。
export type VulcanResolvedMemoryScopeResult =
  | { scope: VulcanResolvedMemoryScope }
  | VulcanResolvedMemoryScopeError;

// resolveVulcanMemoryScope resolves the host runtime, stable VMM user, and stable VMM project in one pass.
// resolveVulcanMemoryScope 在一次流程中解析宿主运行时、稳定 VMM 用户与稳定 VMM 项目。
export async function resolveVulcanMemoryScope(params: {
  client: VulcanHostClient;
  context: VulcanHostContext;
  requireSession: boolean;
  purpose: "manager" | "search" | "precheck" | "postaction" | "status";
}): Promise<VulcanResolvedMemoryScopeResult> {
  const runtime = await params.client.buildHostAdapterRuntime(params.context);
  const sessionId = runtime.sessionId ?? runtime.workmemId ?? params.context.sessionId ?? params.context.sessionKey;
  const degradedReasons = dedupeStrings(runtime.degradedReasons);
  if (runtime.isError) {
    return {
      error: runtime.message?.trim() || "Host adapter runtime initialization failed.",
      runtime,
      sessionId,
      workmemId: runtime.workmemId,
      identityReady: runtime.identityReady,
      degradedReasons,
    };
  }
  if (!runtime.vmmEnabled) {
    return {
      error: runtime.message?.trim() || runtime.vmmStatus.trim() || "VMM backend is disabled.",
      runtime,
      sessionId,
      workmemId: runtime.workmemId,
      identityReady: runtime.identityReady,
      degradedReasons,
    };
  }
  if (params.requireSession && !sessionId) {
    return {
      error: `VMM ${params.purpose} requires a session or WorkMem identity, but OpenClaw did not provide one.`,
      runtime,
      sessionId,
      workmemId: runtime.workmemId,
      identityReady: runtime.identityReady,
      degradedReasons: dedupeStrings([...degradedReasons, "missing-session-or-workmem"]),
    };
  }

  // Build deterministic user/project references so OpenClaw can use VMM before vulcan-host grows a host-aware scope relay.
  // 构建确定性的用户/项目引用，让 OpenClaw 在 vulcan-host 尚未提供宿主感知 scope relay 前也能使用 VMM。
  const userRef = buildVmmUserRef(params.context, runtime, sessionId);
  const projectPath = buildVmmProjectPath(params.context, runtime, sessionId);
  const [user, project] = await Promise.all([
    params.client.resolveVmmUser({
      context: params.context,
      userRef,
      confirmCreate: true,
    }),
    params.client.ensureVmmProject({
      context: params.context,
      projectPath,
      confirmCreate: true,
    }),
  ]);
  if (!user.userId.trim()) {
    return {
      error: user.message.trim() || "VMM user resolution returned an empty user id.",
      runtime,
      sessionId,
      workmemId: runtime.workmemId,
      identityReady: runtime.identityReady,
      degradedReasons,
      userRef,
      projectPath,
    };
  }
  if (!project.projectId.trim()) {
    return {
      error: project.message.trim() || "VMM project resolution returned an empty project id.",
      runtime,
      sessionId,
      workmemId: runtime.workmemId,
      identityReady: runtime.identityReady,
      degradedReasons,
      userRef,
      projectPath,
    };
  }
  return {
    scope: {
      runtime,
      sessionId,
      workmemId: runtime.workmemId,
      identityReady: runtime.identityReady,
      degradedReasons,
      userRef,
      user,
      projectPath: project.displayPath.trim() || projectPath,
      project,
    },
  };
}

// buildVmmUserRef creates one deterministic user reference from the best trusted host identifiers currently available.
// buildVmmUserRef 基于当前可用的最佳受信任宿主标识创建一个确定性的用户引用。
function buildVmmUserRef(
  context: VulcanHostContext,
  runtime: VulcanHostAdapterRuntime,
  sessionId: string | undefined,
): string {
  const candidate =
    pickFirstText(
      context.requesterSenderId,
      context.senderId,
      context.agentAccountId,
      context.accountId,
      sessionId,
      runtime.workmemId,
      context.sessionKey,
      context.agentId,
      context.workspaceDir,
    ) ?? "openclaw-anonymous";
  return buildNamespacedIdentity("user", candidate);
}

// buildVmmProjectPath creates one canonical Team/Space/Project path from workspace-first host signals.
// buildVmmProjectPath 基于 workspace 优先的宿主信号创建一条标准 Team/Space/Project 路径。
function buildVmmProjectPath(
  context: VulcanHostContext,
  runtime: VulcanHostAdapterRuntime,
  sessionId: string | undefined,
): string {
  const workspaceDir = pickFirstText(context.workspaceDir);
  if (workspaceDir) {
    const workspaceName = slugifySegment(path.basename(workspaceDir), "workspace");
    return [
      VMM_HOST_TEAM_NAME,
      VMM_OPENCLAW_SPACE_NAME,
      `workspace-${workspaceName}-${shortHash(workspaceDir)}`,
    ].join("/");
  }

  const channelSeed = pickFirstText(
    context.messageChannel,
    context.channelName,
    context.channelId,
    context.conversationId,
    context.messageThreadId,
    context.threadParentId,
  );
  if (channelSeed) {
    return [
      VMM_HOST_TEAM_NAME,
      VMM_OPENCLAW_SPACE_NAME,
      `channel-${slugifySegment(channelSeed, "channel")}-${shortHash(channelSeed)}`,
    ].join("/");
  }

  const sessionSeed = pickFirstText(sessionId, runtime.workmemId, context.sessionKey, context.agentId) ?? "default";
  return [
    VMM_HOST_TEAM_NAME,
    VMM_OPENCLAW_SPACE_NAME,
    `session-${slugifySegment(sessionSeed, "session")}-${shortHash(sessionSeed)}`,
  ].join("/");
}

// buildNamespacedIdentity keeps generated durable identifiers human-readable while preserving uniqueness.
// buildNamespacedIdentity 让生成的长期标识保持可读，同时保留唯一性。
function buildNamespacedIdentity(kind: "user", raw: string): string {
  const slug = slugifySegment(raw, kind);
  return `openclaw-${kind}-${slug}-${shortHash(raw)}`;
}

// pickFirstText selects the first non-empty compact text value from a candidate list.
// pickFirstText 从候选列表中选出第一个非空紧凑文本值。
function pickFirstText(...values: Array<string | undefined>): string | undefined {
  return values.map((value) => value?.trim()).find(Boolean);
}

// slugifySegment normalizes one raw label into a VMM-safe path segment without removing its human meaning.
// slugifySegment 把原始标签归一化为 VMM 安全路径段，同时尽量保留其人类可读含义。
function slugifySegment(value: string, fallback: string): string {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, MAX_SEGMENT_LENGTH);
  return slug || fallback;
}

// shortHash creates a compact deterministic suffix used to avoid collisions across similarly named channels or workspaces.
// shortHash 创建紧凑且确定性的后缀，用于避免相似频道或工作区之间发生碰撞。
function shortHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, HASH_LENGTH);
}

// dedupeStrings preserves the first occurrence of each degradation reason.
// dedupeStrings 保留每条降级原因的首次出现顺序。
function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
