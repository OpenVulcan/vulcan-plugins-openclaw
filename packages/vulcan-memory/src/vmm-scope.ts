// Scope resolution helpers for binding OpenClaw runtime identity to real Vulcan Memory Mesh ids.
// 本文件负责把 OpenClaw 运行时身份绑定到真实的 Vulcan Memory Mesh 业务 ID。

import type {
  ResolvedVulcanBindings,
  ResolvedVulcanConfig,
  VulcanHostAdapterRuntime,
  VulcanHostClient,
  VulcanHostContext,
  VulcanVmmResolvedProject,
  VulcanVmmResolvedUser,
} from "@vulcan-plugins-openclaw/shared";
import { resolveEffectiveVulcanBindings } from "@vulcan-plugins-openclaw/shared";

// VulcanResolvedMemoryScope carries the resolved runtime plus the effective VMM binding set used by all memory flows.
// VulcanResolvedMemoryScope 承载所有记忆链路都会使用的已解析运行时与最终 VMM 绑定集合。
export interface VulcanResolvedMemoryScope {
  runtime: VulcanHostAdapterRuntime;
  sessionId?: string | undefined;
  workmemId?: string | undefined;
  identityReady: boolean;
  degradedReasons: string[];
  bindings: ResolvedVulcanBindings;
  user: VulcanVmmResolvedUser;
  project: VulcanVmmResolvedProject;
}

// VulcanResolvedMemoryScopeError preserves normalized runtime and binding diagnostics when VMM scope resolution cannot complete.
// VulcanResolvedMemoryScopeError 在 VMM 作用域解析失败时保留归一化运行时与绑定诊断信息。
export interface VulcanResolvedMemoryScopeError {
  error: string;
  runtime?: VulcanHostAdapterRuntime | undefined;
  sessionId?: string | undefined;
  workmemId?: string | undefined;
  identityReady: boolean;
  degradedReasons: string[];
  bindings?: ResolvedVulcanBindings | undefined;
}

// VulcanResolvedMemoryScopeResult reports either one usable scope or one structured diagnostic failure.
// VulcanResolvedMemoryScopeResult 用于返回可用作用域，或一条结构化诊断失败信息。
export type VulcanResolvedMemoryScopeResult =
  | { scope: VulcanResolvedMemoryScope }
  | VulcanResolvedMemoryScopeError;

// resolveVulcanMemoryScope resolves host runtime state plus the effective user/project bindings required by VMM flows.
// resolveVulcanMemoryScope 解析宿主运行时状态，以及 VMM 链路所需的最终用户/项目绑定。
export async function resolveVulcanMemoryScope(params: {
  client: VulcanHostClient;
  config: ResolvedVulcanConfig;
  context: VulcanHostContext;
  requireSession: boolean;
  purpose: "manager" | "search" | "precheck" | "profile" | "compact" | "postaction" | "status";
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

  // Resolve the durable user/project bindings before touching VMM business RPCs so every flow shares one consistent scope contract.
  // 在触发 VMM 业务 RPC 之前先解析长期用户/项目绑定，确保所有链路共享同一套稳定作用域契约。
  const bindings = await resolveEffectiveVulcanBindings(params.config, params.context.agentId);
  const [user, project] = await Promise.all([
    params.client.resolveVmmUser({
      context: params.context,
      userRef: bindings.effectiveUserId,
      confirmCreate: false,
    }),
    params.client.resolveVmmProject({
      context: params.context,
      projectRef: bindings.effectiveProjectId,
    }),
  ]);

  // Validate the configured numeric ids eagerly so search, precheck, compact, and postaction all fail with one clear binding error.
  // 这里主动校验配置好的数字 ID，确保 search、precheck、compact 与 postaction 都会以一致且清晰的绑定错误失败。
  if (!user.userId.trim()) {
    return {
      error:
        user.message.trim() ||
        `Configured VMM user id ${bindings.effectiveUserId} could not be resolved. Bind one valid user before using Vulcan memory.`,
      runtime,
      sessionId,
      workmemId: runtime.workmemId,
      identityReady: runtime.identityReady,
      degradedReasons,
      bindings,
    };
  }
  if (!project.projectId.trim()) {
    return {
      error:
        project.message.trim() ||
        `Configured VMM project id ${bindings.effectiveProjectId} could not be resolved. Bind one valid project before using Vulcan memory.`,
      runtime,
      sessionId,
      workmemId: runtime.workmemId,
      identityReady: runtime.identityReady,
      degradedReasons,
      bindings,
    };
  }

  return {
    scope: {
      runtime,
      sessionId,
      workmemId: runtime.workmemId,
      identityReady: runtime.identityReady,
      degradedReasons,
      bindings,
      user,
      project,
    },
  };
}

// dedupeStrings preserves the first occurrence of each degradation reason.
// dedupeStrings 保留每条降级原因的首次出现顺序。
function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
