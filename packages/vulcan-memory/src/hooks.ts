// Prompt and lifecycle hooks for full-mode Vulcan memory integration.
// 本文件实现 Vulcan 记忆完整模式接入所需的 prompt 与生命周期 hooks。

import {
  buildHookHostContext,
  createVulcanHostClient,
  type ResolvedVulcanConfig,
  type VulcanHostContext,
  type VulcanVmmMemorySearchHit,
  type VulcanVmmTurnTimelineItem,
} from "@vulcan-plugins-openclaw/shared";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { searchVulcanMemoryEntries } from "./manager.js";
import {
  clearActiveRecall,
  consumeActiveRecallForNewTurn,
  deleteSessionMemoryState,
  getOrCreateSessionMemoryState,
  incrementCommittedTurnCount,
  markSessionTurn,
  peekActiveRecallLines,
  replaceActiveRecall,
  startSessionMemoryState,
  type VulcanProfileBundleState,
  type VulcanSessionMemoryState,
} from "./session-state.js";
import {
  resolveVulcanMemoryScope,
  type VulcanResolvedMemoryScope,
  type VulcanResolvedMemoryScopeResult,
} from "./vmm-scope.js";

// MAX_RECALL_QUERY_CHARS bounds the prompt text forwarded to VMM precheck so recall remains focused and transport-safe.
// MAX_RECALL_QUERY_CHARS 用于限制转发给 VMM precheck 的 prompt 文本长度，保持 recall 聚焦且传输安全。
const MAX_RECALL_QUERY_CHARS = 2_000;

// MAX_TURN_FINGERPRINT_CHARS keeps user-turn fingerprints compact while still distinguishing most follow-up prompts.
// MAX_TURN_FINGERPRINT_CHARS 用于保持用户 turn 指纹足够紧凑，同时仍能区分大多数 follow-up prompt。
const MAX_TURN_FINGERPRINT_CHARS = 400;

// MAX_FALLBACK_PREVIEW_CHARS keeps fallback grouped-search previews readable inside one bounded recall slot.
// MAX_FALLBACK_PREVIEW_CHARS 用于把降级 grouped-search 预览控制在可读范围内，适配单槽 recall。
const MAX_FALLBACK_PREVIEW_CHARS = 220;

// POSTACTION_BLOCKED_STATE_RE matches OpenClaw-visible blocked or approval-gated terminal texts that should never be persisted as durable VMM memories.
// POSTACTION_BLOCKED_STATE_RE 匹配 OpenClaw 可见的阻断态或审批门控终态文本，这些回合绝不应该被持久化为稳定 VMM 记忆。
const POSTACTION_BLOCKED_STATE_RE =
  /\b(?:task needs follow-up|background task blocked|command did not run|approval (?:timed out|was denied|is required|request failed)|exec approval is required|blocked by sandbox|sandbox\b.*\b(?:blocked|denied|forbidden|disabled|not allowed)|approval-pending)\b/i;

// POSTACTION_FOLLOW_UP_REQUEST_RE detects assistant turns that are still asking for confirmation, approval, or extra user input instead of delivering a closed result.
// POSTACTION_FOLLOW_UP_REQUEST_RE 用于识别仍在索取确认、审批或补充输入的 assistant 回合，这类回合并未产出闭合结果。
const POSTACTION_FOLLOW_UP_REQUEST_RE =
  /\b(?:let me know|please confirm|please approve|reply with:?\s*\/approve|do you want me to|should I|can you confirm|could you confirm|once you confirm|waiting for approval|need(?:s)? your approval|need(?:s)? follow-up|what would you like me to|which .* would you like|before I continue)\b/i;

// POSTACTION_PLAN_ONLY_PROMISE_RE captures plan-only language that indicates the assistant described next steps but did not yet finish the turn.
// POSTACTION_PLAN_ONLY_PROMISE_RE 捕获纯计划性语言，用于识别 assistant 只是描述下一步而尚未真正完成回合的情况。
const POSTACTION_PLAN_ONLY_PROMISE_RE =
  /\b(?:i(?:'ll| will)|let me|i(?:'m| am)\s+going to|first[, ]+i(?:'ll| will)|next[, ]+i(?:'ll| will)|then[, ]+i(?:'ll| will)|i can do that)\b/i;

// POSTACTION_RESULT_SIGNAL_RE captures completion-oriented wording that usually means the assistant already delivered a stable result rather than a pending plan.
// POSTACTION_RESULT_SIGNAL_RE 捕获偏完成态的表达，用于识别 assistant 更像是在交付稳定结果而不是停留在待执行计划。
const POSTACTION_RESULT_SIGNAL_RE =
  /\b(?:done|finished|implemented|updated|fixed|changed|ran|verified|found|here(?:'s| is) what|root cause|result|summary|completed|resolved|wrote|built|restarted|synced|installed|uninstalled)\b/i;

// POSTACTION_PLAN_HEADING_RE detects structured planning headings that usually appear in incomplete or follow-up turns.
// POSTACTION_PLAN_HEADING_RE 用于识别结构化计划标题，这类标题通常出现在未闭合或待继续的回合中。
const POSTACTION_PLAN_HEADING_RE = /^(?:plan|steps?|next steps?)\s*:/i;

// POSTACTION_BULLET_RE detects bullet-heavy assistant outputs so the planning-only heuristic can distinguish checklists from completed summaries.
// POSTACTION_BULLET_RE 用于识别项目符号密集输出，帮助 planning-only 启发式区分“待办清单”和“完成总结”。
const POSTACTION_BULLET_RE = /^(?:[-*•]\s+|\d+[.)]\s+)/u;

// registerVulcanMemoryHooks registers lifecycle, recall, compaction, and postaction hooks for OpenClaw hosts that use full-mode Vulcan memory.
// registerVulcanMemoryHooks 为使用完整模式 Vulcan 记忆的 OpenClaw 宿主注册生命周期、recall、compaction 与 postaction hooks。
export function registerVulcanMemoryHooks(
  api: OpenClawPluginApi,
  config: ResolvedVulcanConfig,
): void {
  api.on(
    "session_start",
    async (event, ctx) => await handleSessionStart(api, config, event, ctx),
    { timeoutMs: config.memory.timeoutMs },
  );
  api.on(
    "session_end",
    async (event, ctx) => await handleSessionEnd(api, config, event, ctx),
    { timeoutMs: config.memory.timeoutMs },
  );
  api.on(
    "before_prompt_build",
    async (event, ctx) => await handleBeforePromptBuild(api, config, event, ctx),
    { timeoutMs: config.memory.timeoutMs },
  );
  api.on(
    "after_compaction",
    async (event, ctx) => await handleAfterCompaction(api, config, event, ctx),
    { timeoutMs: config.memory.timeoutMs },
  );
  api.on("agent_end", async (event, ctx) => {
    await handleAgentEnd(api, config, event, ctx);
  });
}

// handleSessionStart initializes runtime-only profile and recall state as soon as OpenClaw opens a new session shell.
// handleSessionStart 在 OpenClaw 打开新 session 外壳时立即初始化仅运行时存在的画像与 recall 状态。
async function handleSessionStart(
  api: OpenClawPluginApi,
  config: ResolvedVulcanConfig,
  event: unknown,
  ctx: Record<string, unknown>,
): Promise<void> {
  if (!config.enabled || !config.memory.enabled) {
    return;
  }
  const eventRecord = asRecord(event);
  const hostContext = buildHookHostContext(eventRecord, ctx, config);
  const sessionStateKey = resolveSessionStateKey(hostContext);
  if (!sessionStateKey) {
    return;
  }

  // Carry forward only the stable hidden profile cache across resumed sessions.
  // 跨恢复 session 仅继承稳定的隐藏画像缓存。
  startSessionMemoryState({
    sessionKey: sessionStateKey,
    resumedFrom: resolveResumeSessionStateKey(eventRecord),
  });
  api.logger.debug?.(`vulcan-memory: session_start initialized state for ${sessionStateKey}.`);
}

// handleSessionEnd clears the in-memory state snapshot so abandoned sessions do not keep stale recall/profile caches alive.
// handleSessionEnd 清理内存态快照，避免废弃 session 长期保留过期的 recall 或画像缓存。
async function handleSessionEnd(
  api: OpenClawPluginApi,
  config: ResolvedVulcanConfig,
  event: unknown,
  ctx: Record<string, unknown>,
): Promise<void> {
  if (!config.enabled || !config.memory.enabled) {
    return;
  }
  const eventRecord = asRecord(event);
  const hostContext = buildHookHostContext(eventRecord, ctx, config);
  const sessionStateKey = resolveSessionStateKey(hostContext);
  if (!sessionStateKey) {
    return;
  }
  deleteSessionMemoryState(sessionStateKey);
  api.logger.debug?.(`vulcan-memory: session_end cleared state for ${sessionStateKey}.`);
}

// handleBeforePromptBuild injects durable profile bundle context and bounded short-lived recall ahead of the active OpenClaw turn.
// handleBeforePromptBuild 在当前 OpenClaw 回合前注入持久画像 bundle 上下文与有界短期 recall。
async function handleBeforePromptBuild(
  api: OpenClawPluginApi,
  config: ResolvedVulcanConfig,
  event: unknown,
  ctx: Record<string, unknown>,
): Promise<{ prependContext?: string; prependSystemContext?: string } | undefined> {
  if (!config.enabled || !config.memory.enabled) {
    return undefined;
  }
  const eventRecord = asRecord(event);
  const hostContext = buildHookHostContext(eventRecord, ctx, config);
  const sessionStateKey = resolveSessionStateKey(hostContext);
  const query = extractRecallQuery(eventRecord);
  const turnKey = buildPromptTurnKey(eventRecord, query);
  const sessionState = sessionStateKey ? getOrCreateSessionMemoryState(sessionStateKey) : undefined;
  const openedNewTurn =
    sessionState && turnKey ? markSessionTurn(sessionState, turnKey) : sessionState ? false : true;

  try {
    const client = createVulcanHostClient(config);
    const resolved = await resolveVulcanMemoryScope({
      client,
      config,
      context: hostContext,
      requireSession: false,
      purpose: "profile",
    });
    if (!("scope" in resolved)) {
      api.logger.warn?.(`vulcan-memory: before_prompt_build skipped because scope resolution failed: ${resolved.error}`);
      return buildCachedInjectionOnScopeFailure({
        config,
        state: sessionState,
        openedNewTurn,
        error: resolved.error,
      });
    }

    // Reconcile cached state against the latest resolved binding signature before any injection is attempted.
    // 在开始注入之前，先用最新解析出的绑定签名对齐缓存状态。
    reconcileSessionScopeState(sessionState, resolved.scope);

    const prependSystemContext = await buildProfileBundleInjection({
      api,
      client,
      config,
      state: sessionState,
      scope: resolved.scope,
      hostContext,
    });
    const prependContext = await buildRecallInjection({
      api,
      client,
      config,
      state: sessionState,
      scope: resolved.scope,
      hostContext,
      query,
      turnKey,
      openedNewTurn,
    });
    if (!prependSystemContext && !prependContext) {
      return undefined;
    }
    return {
      ...(prependContext ? { prependContext } : {}),
      ...(prependSystemContext ? { prependSystemContext } : {}),
    };
  } catch (error) {
    api.logger.warn?.(`vulcan-memory: before_prompt_build injection skipped: ${String(error)}`);
    return undefined;
  }
}

// handleAfterCompaction acknowledges the new OpenClaw compact boundary so later VMM recall can reopen only compacted-away turns.
// handleAfterCompaction 确认 OpenClaw 新产生的 compact 边界，让后续 VMM 召回只重新开放已被压缩的 turn。
async function handleAfterCompaction(
  api: OpenClawPluginApi,
  config: ResolvedVulcanConfig,
  event: unknown,
  ctx: Record<string, unknown>,
): Promise<void> {
  if (!config.enabled || !config.memory.enabled) {
    return;
  }
  const eventRecord = asRecord(event);
  const compactedCount = readFiniteNumber(eventRecord.compactedCount, 0);
  if (compactedCount <= 0) {
    return;
  }
  try {
    const client = createVulcanHostClient(config);
    const hostContext = buildHookHostContext(eventRecord, ctx, config);

    // Resolve one stable VMM scope before acknowledging the compaction boundary, so the compact marker lands in the same session/user/project coordinates as recall.
    // 在确认压缩边界之前先解析稳定的 VMM 作用域，确保 compact 标记落在与 recall 相同的 session/user/project 坐标上。
    const resolved = await resolveVulcanMemoryScope({
      client,
      config,
      context: hostContext,
      requireSession: true,
      purpose: "compact",
    });
    if (!("scope" in resolved)) {
      api.logger.warn?.(`vulcan-memory: after_compaction skipped: ${resolved.error}`);
      return;
    }
    if (!resolved.scope.sessionId) {
      api.logger.warn?.("vulcan-memory: after_compaction skipped because no stable session id was resolved.");
      return;
    }
    const response = await client.chatCompactVmm({
      context: hostContext,
      sessionId: resolved.scope.sessionId,
      userId: resolved.scope.user.userId,
      projectId: resolved.scope.project.projectId,
    });
    if (!response.accepted) {
      api.logger.warn?.("vulcan-memory: ChatCompact request was rejected by VMM.");
    }
  } catch (error) {
    api.logger.warn?.(`vulcan-memory: after_compaction sync skipped: ${String(error)}`);
  }
}

// handleAgentEnd records one closed committed turn for profile refresh cadence and optionally forwards the turn to VMM PostAction.
// handleAgentEnd 记录一次闭合 committed turn 以驱动画像刷新节奏，并在启用时把该回合转发给 VMM PostAction。
async function handleAgentEnd(
  api: OpenClawPluginApi,
  config: ResolvedVulcanConfig,
  event: unknown,
  ctx: Record<string, unknown>,
): Promise<void> {
  if (!config.enabled || !config.memory.enabled) {
    return;
  }
  const eventRecord = asRecord(event);
  const payload = buildPostActionPayload(eventRecord);
  if (!payload) {
    return;
  }

  const hostContext = buildHookHostContext(eventRecord, ctx, config);
  const sessionStateKey = resolveSessionStateKey(hostContext);
  const sessionState = sessionStateKey ? getOrCreateSessionMemoryState(sessionStateKey) : undefined;
  if (sessionState) {
    incrementCommittedTurnCount(sessionState);
  }

  try {
    const client = createVulcanHostClient(config);
    const profileScopeResult = await resolveVulcanMemoryScope({
      client,
      config,
      context: hostContext,
      requireSession: false,
      purpose: "profile",
    });
    if ("scope" in profileScopeResult && sessionState) {
      reconcileSessionScopeState(sessionState, profileScopeResult.scope);
      await maybeRefreshProfileBundleAfterCommittedTurn({
        api,
        client,
        config,
        state: sessionState,
        scope: profileScopeResult.scope,
        hostContext,
      });
    }

    if (!config.memory.autoPostAction) {
      return;
    }

    // PostAction still requires one stable session identity, even though profile refresh can work with user/project scope only.
    // 即使画像刷新只需要 user/project 作用域，PostAction 仍然必须依赖稳定的 session 身份。
    const resolved =
      "scope" in profileScopeResult && profileScopeResult.scope.sessionId
        ? profileScopeResult
        : await resolveVulcanMemoryScope({
            client,
            config,
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

// buildCachedInjectionOnScopeFailure reuses only safe cached profile/recall state when runtime scope resolution transiently fails.
// buildCachedInjectionOnScopeFailure 仅在运行时作用域解析发生暂时性失败时复用安全的缓存画像与 recall 状态。
function buildCachedInjectionOnScopeFailure(params: {
  config: ResolvedVulcanConfig;
  state: VulcanSessionMemoryState | undefined;
  openedNewTurn: boolean;
  error: string;
}): { prependContext?: string; prependSystemContext?: string } | undefined {
  if (!params.state || !shouldReuseCachedInjectionOnScopeFailure(params.error)) {
    return undefined;
  }
  const carriedLines = params.config.memory.autoRecall
    ? params.openedNewTurn
      ? consumeActiveRecallForNewTurn(params.state)
      : peekActiveRecallLines(params.state)
    : [];
  const prependSystemContext = params.state.profileBundle?.bundleText
    ? renderImplicitProfileBundleSystem(params.state.profileBundle.bundleText)
    : undefined;
  const prependContext = carriedLines.length > 0 ? buildPrecheckContext(carriedLines) : undefined;
  if (!prependSystemContext && !prependContext) {
    return undefined;
  }
  return {
    ...(prependContext ? { prependContext } : {}),
    ...(prependSystemContext ? { prependSystemContext } : {}),
  };
}

// shouldReuseCachedInjectionOnScopeFailure rejects clearly invalid binding/session failures while still allowing transient transport failures to fall back to cached state.
// shouldReuseCachedInjectionOnScopeFailure 会拒绝明显的绑定或 session 非法失败，但允许暂时性的传输失败回退到缓存状态。
function shouldReuseCachedInjectionOnScopeFailure(error: string): boolean {
  const normalized = error.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return !(
    normalized.includes("configured vmm user id") ||
    normalized.includes("configured vmm project id") ||
    normalized.includes("vmm backend is disabled") ||
    normalized.includes("requires a session or workmem identity")
  );
}

// reconcileSessionScopeState clears stale recall and profile cache whenever the resolved user/project binding signature changes.
// reconcileSessionScopeState 会在解析出的 user/project 绑定签名变化时清理陈旧的 recall 与画像缓存。
function reconcileSessionScopeState(
  state: VulcanSessionMemoryState | undefined,
  scope: VulcanResolvedMemoryScope,
): void {
  if (!state) {
    return;
  }
  const signature = buildProfileBundleSignature(scope.user.userId, scope.project.projectId);
  if (state.profileBundle?.signature && state.profileBundle.signature !== signature) {
    state.profileBundle = undefined;
    clearActiveRecall(state);
  }
}

// buildProfileBundleInjection resolves the hidden bundle cache for the current user/project scope and returns one system-context block when available.
// buildProfileBundleInjection 解析当前 user/project 作用域下的隐藏 bundle 缓存，并在可用时返回一段 system 上下文。
async function buildProfileBundleInjection(params: {
  api: OpenClawPluginApi;
  client: ReturnType<typeof createVulcanHostClient>;
  config: ResolvedVulcanConfig;
  state: VulcanSessionMemoryState | undefined;
  scope: VulcanResolvedMemoryScope;
  hostContext: VulcanHostContext;
}): Promise<string | undefined> {
  const signature = buildProfileBundleSignature(params.scope.user.userId, params.scope.project.projectId);
  const cachedBundle = params.state?.profileBundle;
  const shouldRefresh = shouldRefreshProfileBundle({
    cachedBundle,
    signature,
    committedTurnCount: params.state?.committedTurnCount ?? 0,
    refreshTurns: params.config.memory.profileRefreshTurns,
  });

  let bundleText = cachedBundle?.bundleText?.trim() ?? "";
  if (shouldRefresh) {
    try {
      const response = await params.client.getVmmProfileBundle({
        context: params.hostContext,
        userId: params.scope.user.userId,
        projectId: params.scope.project.projectId,
        includeExplanation: true,
      });
      bundleText = response.combinedText.trim();
      if (params.state) {
        params.state.profileBundle = {
          signature,
          userId: params.scope.user.userId,
          projectId: params.scope.project.projectId,
          bundleText,
          traceId: response.traceId,
          fetchedAt: Date.now(),
          fetchedAtCommittedTurnCount: params.state.committedTurnCount,
        };
      }
    } catch (error) {
      params.api.logger.warn?.(`vulcan-memory: profile bundle fetch skipped: ${String(error)}`);
      if (cachedBundle?.signature !== signature && params.state) {
        params.state.profileBundle = undefined;
        bundleText = "";
      }
    }
  }
  return bundleText ? renderImplicitProfileBundleSystem(bundleText) : undefined;
}

// maybeRefreshProfileBundleAfterCommittedTurn refreshes the hidden profile bundle only after enough closed turns have accumulated.
// maybeRefreshProfileBundleAfterCommittedTurn 仅在累计了足够多的闭合回合后刷新隐藏画像 bundle。
async function maybeRefreshProfileBundleAfterCommittedTurn(params: {
  api: OpenClawPluginApi;
  client: ReturnType<typeof createVulcanHostClient>;
  config: ResolvedVulcanConfig;
  state: VulcanSessionMemoryState;
  scope: VulcanResolvedMemoryScope;
  hostContext: VulcanHostContext;
}): Promise<void> {
  const cachedBundle = params.state.profileBundle;
  if (!cachedBundle) {
    return;
  }
  const signature = buildProfileBundleSignature(params.scope.user.userId, params.scope.project.projectId);
  const shouldRefresh = shouldRefreshProfileBundle({
    cachedBundle,
    signature,
    committedTurnCount: params.state.committedTurnCount,
    refreshTurns: params.config.memory.profileRefreshTurns,
  });
  if (!shouldRefresh) {
    return;
  }
  try {
    const response = await params.client.getVmmProfileBundle({
      context: params.hostContext,
      userId: params.scope.user.userId,
      projectId: params.scope.project.projectId,
      includeExplanation: true,
    });
    params.state.profileBundle = {
      signature,
      userId: params.scope.user.userId,
      projectId: params.scope.project.projectId,
      bundleText: response.combinedText.trim(),
      traceId: response.traceId,
      fetchedAt: Date.now(),
      fetchedAtCommittedTurnCount: params.state.committedTurnCount,
    };
  } catch (error) {
    params.api.logger.warn?.(`vulcan-memory: profile bundle refresh skipped: ${String(error)}`);
  }
}

// shouldRefreshProfileBundle decides whether the cached bundle is missing, out-of-scope, or stale enough to justify one refresh.
// shouldRefreshProfileBundle 用于判断缓存 bundle 是否缺失、作用域失配，或已经陈旧到需要刷新。
function shouldRefreshProfileBundle(params: {
  cachedBundle: VulcanProfileBundleState | undefined;
  signature: string;
  committedTurnCount: number;
  refreshTurns: number;
}): boolean {
  if (!params.cachedBundle) {
    return true;
  }
  if (params.cachedBundle.signature !== params.signature) {
    return true;
  }
  if (params.refreshTurns <= 0) {
    return false;
  }
  const turnsSinceFetch = Math.max(
    0,
    params.committedTurnCount - params.cachedBundle.fetchedAtCommittedTurnCount,
  );
  return turnsSinceFetch >= params.refreshTurns;
}

// buildRecallInjection drives one bounded single-slot recall state machine that favors fresh recall and falls back to carried recall only when no better hit exists.
// buildRecallInjection 驱动一个有界的单槽 recall 状态机，在有新 recall 时优先使用新结果，只有没有更好命中时才回退到保温 recall。
async function buildRecallInjection(params: {
  api: OpenClawPluginApi;
  client: ReturnType<typeof createVulcanHostClient>;
  config: ResolvedVulcanConfig;
  state: VulcanSessionMemoryState | undefined;
  scope: VulcanResolvedMemoryScope;
  hostContext: VulcanHostContext;
  query: string | undefined;
  turnKey: string;
  openedNewTurn: boolean;
}): Promise<string | undefined> {
  if (!params.config.memory.autoRecall) {
    return undefined;
  }

  // Keep one bounded recall slot instead of accumulating multiple generations, which keeps the hidden context size predictable on no-TUI hosts.
  // 这里保留一个有界 recall 槽位，而不是累计多代 recall，以保持无 TUI 宿主的隐藏上下文体积可预测。
  const carriedLines = params.state
    ? params.openedNewTurn
      ? consumeActiveRecallForNewTurn(params.state)
      : peekActiveRecallLines(params.state)
    : [];
  if (!params.query) {
    return carriedLines.length > 0 ? buildPrecheckContext(carriedLines) : undefined;
  }

  const freshLines = params.openedNewTurn
    ? await fetchFreshRecallLines({
        api: params.api,
        client: params.client,
        config: params.config,
        scope: params.scope,
        hostContext: params.hostContext,
        query: params.query,
      })
    : [];
  if (freshLines.length > 0) {
    if (params.state && params.config.memory.implicitMemoryTurns > 0) {
      replaceActiveRecall(
        params.state,
        params.turnKey,
        freshLines,
        params.config.memory.implicitMemoryTurns,
      );
    }
    return buildPrecheckContext(freshLines);
  }
  return carriedLines.length > 0 ? buildPrecheckContext(carriedLines) : undefined;
}

// fetchFreshRecallLines prefers VMM precheck for session-bound runs and falls back to grouped search only when session identity is unavailable.
// fetchFreshRecallLines 优先在具备 session 身份时走 VMM precheck，仅在 session 身份不可用时才退回 grouped search。
async function fetchFreshRecallLines(params: {
  api: OpenClawPluginApi;
  client: ReturnType<typeof createVulcanHostClient>;
  config: ResolvedVulcanConfig;
  scope: VulcanResolvedMemoryScope;
  hostContext: VulcanHostContext;
  query: string;
}): Promise<string[]> {
  if (params.scope.sessionId) {
    const response = await params.client.preCheckVmm({
      context: params.hostContext,
      sessionId: params.scope.sessionId,
      userId: params.scope.user.userId,
      projectId: params.scope.project.projectId,
      userContent: params.query,
      recallMode: "session_compact",
    });
    if (!response.shouldInject || response.contextItems.length === 0) {
      return [];
    }
    return dedupeTextLines(response.contextItems.map((item) => item.text));
  }

  // Some host runs still lack a stable session identity, so grouped search remains the safe degraded recall path.
  // 某些宿主运行仍缺少稳定 session 身份，因此分组检索仍然是安全的降级 recall 路径。
  const fallback = await searchVulcanMemoryEntries({
    client: params.client,
    config: params.config,
    context: params.hostContext,
    queries: [params.query],
    topK: params.config.memory.recallTopK,
  });
  if ("error" in fallback) {
    params.api.logger.warn?.(`vulcan-memory: grouped recall skipped: ${fallback.error}`);
    return [];
  }
  return buildFallbackRecallItems(fallback.hitsByQuery);
}

// buildFallbackRecallItems compacts grouped VMM hits into concise recall segments that fit the single-slot OpenClaw recall cache.
// buildFallbackRecallItems 把分组 VMM 命中压缩成简洁的 recall 片段，适配 OpenClaw 的单槽 recall 缓存。
function buildFallbackRecallItems(
  hitsByQuery: Array<{ query: string; hits: VulcanVmmMemorySearchHit[] }>,
): string[] {
  const items: string[] = [];
  for (const group of hitsByQuery) {
    for (const hit of group.hits) {
      const summary = compactInline(hit.abstract || hit.detailsPreview || `Memory ${hit.memoryId}`);
      if (!summary) {
        continue;
      }
      items.push(`[${group.query}] ${summary}`);
    }
  }
  return dedupeTextLines(items);
}

// resolveSessionStateKey derives the strongest available session key used by the plugin-owned in-memory state store.
// resolveSessionStateKey 推导插件内存状态存储所使用的最强 session 键。
function resolveSessionStateKey(context: VulcanHostContext): string | undefined {
  return normalizeOptionalString(context.sessionKey ?? context.sessionId ?? context.rootSessionId);
}

// resolveResumeSessionStateKey derives the predecessor key from session_start payloads so resumed sessions can inherit stable profile cache.
// resolveResumeSessionStateKey 从 session_start 载荷中推导前驱键，让恢复后的 session 可以继承稳定画像缓存。
function resolveResumeSessionStateKey(event: Record<string, unknown>): string | undefined {
  return normalizeOptionalString(event.resumedFrom);
}

// buildProfileBundleSignature creates the stable cache key for one user/project pair.
// buildProfileBundleSignature 为一组 user/project 组合创建稳定的缓存键。
function buildProfileBundleSignature(userId: string, projectId: string): string {
  return `${userId.trim()}::${projectId.trim()}`;
}

// renderImplicitProfileBundleSystem turns the hidden VMM profile bundle into a stable system-context block.
// renderImplicitProfileBundleSystem 把隐藏的 VMM 画像 bundle 转换成稳定的 system 上下文区块。
function renderImplicitProfileBundleSystem(bundleText: string): string {
  return [
    "## Persistent Profile Bundle",
    "The following profile bundle is the latest persisted background context for the current user and project scope.",
    "Sections may appear as [TEAM], [SPACE], [PROJECT], and [USER].",
    "Treat it as hidden durable background context, and let explicit user instructions in the current turn override it when they conflict.",
    "",
    bundleText.trim(),
  ].join("\n");
}

// buildPromptTurnKey builds one compact but stable fingerprint for the current prompt-build pass so repeated retries do not reopen recall windows.
// buildPromptTurnKey 为当前 prompt-build 构造一个紧凑且稳定的指纹，避免重复重试误开新的 recall 窗口。
function buildPromptTurnKey(event: Record<string, unknown>, query: string | undefined): string {
  const messages = Array.isArray(event.messages) ? event.messages : [];
  const latestUser = findLatestRoleMessage(event, "user");
  const latestUserId = normalizeOptionalString(
    latestUser.messageId ?? latestUser.id ?? latestUser.turnId ?? latestUser.createdAt,
  );
  const latestUserText =
    extractContentText(latestUser.content).trim() ||
    normalizeOptionalString(event.prompt) ||
    query ||
    "";
  return [
    String(messages.length),
    latestUserId ?? hashText(latestUserText.slice(0, MAX_TURN_FINGERPRINT_CHARS)),
  ]
    .filter(Boolean)
    .join("::");
}

// extractRecallQuery chooses the safest current prompt text as the VMM recall seed.
// extractRecallQuery 选择最安全的当前 prompt 文本作为 VMM recall 种子。
function extractRecallQuery(event: Record<string, unknown>): string | undefined {
  const prompt = typeof event.prompt === "string" ? event.prompt.trim() : "";
  if (prompt) {
    return prompt.slice(0, MAX_RECALL_QUERY_CHARS);
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
  const content = extractContentText(lastUser?.content).trim();
  return content ? content.slice(0, MAX_RECALL_QUERY_CHARS) : undefined;
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
  if (event.success !== true) {
    return null;
  }
  const userContent = extractRoleMessageText(event, "user", 4_000);
  const assistantContent = extractRoleMessageText(event, "assistant", 6_000);
  if (!userContent || !assistantContent) {
    return null;
  }
  if (!isClosedAssistantResultTurn(event, assistantContent)) {
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

// isClosedAssistantResultTurn keeps postaction writeback limited to stable, closed assistant turns instead of approvals, follow-up asks, or plan-only narration.
// isClosedAssistantResultTurn 将 postaction 写回限制在稳定闭合的 assistant 回合，避免审批、追问或纯计划叙述进入长期记忆。
function isClosedAssistantResultTurn(
  event: Record<string, unknown>,
  assistantContent: string,
): boolean {
  const lastAssistant = findLatestRoleMessage(event, "assistant");
  const stopReason = typeof lastAssistant.stopReason === "string" ? lastAssistant.stopReason : "";
  if (stopReason === "toolUse" || stopReason === "error") {
    return false;
  }
  if (hasBlockedOrApprovalSignals(event, assistantContent)) {
    return false;
  }
  if (isFollowUpAssistantTurn(assistantContent)) {
    return false;
  }
  if (isPlanningOnlyAssistantTurn(assistantContent)) {
    return false;
  }
  return true;
}

// hasBlockedOrApprovalSignals scans the assistant text and nearby tool results for explicit blocked or approval-gated messages surfaced by OpenClaw.
// hasBlockedOrApprovalSignals 扫描 assistant 文本与附近工具结果，识别 OpenClaw 已显式暴露的阻断态或审批门控消息。
function hasBlockedOrApprovalSignals(
  event: Record<string, unknown>,
  assistantContent: string,
): boolean {
  const candidateTexts = [assistantContent, ...extractRecentToolLikeTexts(event, 4)];
  return candidateTexts.some((text) => POSTACTION_BLOCKED_STATE_RE.test(text));
}

// isFollowUpAssistantTurn rejects assistant turns that still ask the operator for approval, confirmation, or a next-step choice.
// isFollowUpAssistantTurn 会拒绝仍在向操作者索要审批、确认或下一步选择的 assistant 回合。
function isFollowUpAssistantTurn(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  if (POSTACTION_FOLLOW_UP_REQUEST_RE.test(trimmed)) {
    return true;
  }
  return trimmed.endsWith("?") && !POSTACTION_RESULT_SIGNAL_RE.test(trimmed);
}

// isPlanningOnlyAssistantTurn rejects checklist or promise-style replies that describe intended work but do not yet represent a durable completed outcome.
// isPlanningOnlyAssistantTurn 会拒绝清单式或承诺式回复，这些回复描述的是计划执行内容，而不是可沉淀的完成结果。
function isPlanningOnlyAssistantTurn(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 1_200 || trimmed.includes("```")) {
    return false;
  }
  if (POSTACTION_RESULT_SIGNAL_RE.test(trimmed)) {
    return false;
  }
  if (!POSTACTION_PLAN_ONLY_PROMISE_RE.test(trimmed)) {
    return false;
  }
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const hasPlanHeading = POSTACTION_PLAN_HEADING_RE.test(lines[0] ?? "");
  const bulletCount = lines.filter((line) => POSTACTION_BULLET_RE.test(line)).length;
  return hasPlanHeading || bulletCount >= 2 || !trimmed.includes("?");
}

// extractRecentToolLikeTexts pulls nearby tool outputs from the agent_end transcript so postaction gating can see approval denials and blocked task statuses.
// extractRecentToolLikeTexts 从 agent_end 转录中提取附近工具输出，让 postaction gate 能识别审批拒绝与任务阻断状态。
function extractRecentToolLikeTexts(event: Record<string, unknown>, limit: number): string[] {
  const messages = Array.isArray(event.messages) ? event.messages : [];
  const results: string[] = [];
  for (let index = messages.length - 1; index >= 0 && results.length < limit; index -= 1) {
    const record = asRecord(messages[index]);
    if (!isToolLikeMessage(record)) {
      continue;
    }
    const text = extractContentText(
      record.content ?? record.result ?? record.output ?? record.toolOutput ?? record.details,
    ).trim();
    if (text) {
      results.push(text);
    }
  }
  return results;
}

// isToolLikeMessage identifies persisted tool or tool-result transcript entries across the slightly different role/type shapes OpenClaw may emit.
// isToolLikeMessage 识别 OpenClaw 可能发出的多种 role/type 形态下的工具或工具结果转录条目。
function isToolLikeMessage(record: Record<string, unknown>): boolean {
  const normalizedRole = typeof record.role === "string" ? record.role.trim().toLowerCase() : "";
  const normalizedType = typeof record.type === "string" ? record.type.trim().toLowerCase() : "";
  return (
    normalizedRole === "tool" ||
    normalizedRole === "toolresult" ||
    normalizedRole === "tool_result" ||
    normalizedType === "toolresult" ||
    normalizedType === "tool_result" ||
    normalizedType === "tool_result_error"
  );
}

// findLatestRoleMessage retrieves the last message of a given role from hook payloads so gating decisions can inspect the terminal user/assistant pair directly.
// findLatestRoleMessage 从 hook 载荷中提取指定角色的最后一条消息，便于 gating 直接检查终态 user/assistant 配对。
function findLatestRoleMessage(
  event: Record<string, unknown>,
  role: "assistant" | "user",
): Record<string, unknown> {
  const messages = Array.isArray(event.messages) ? event.messages : [];
  const message = [...messages].reverse().find((entry) => {
    const record = asRecord(entry);
    return record.role === role;
  });
  return asRecord(message);
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

// dedupeTextLines trims one list of recall segments into stable unique text blocks.
// dedupeTextLines 把一组 recall 片段裁剪并去重成稳定的唯一文本块。
function dedupeTextLines(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

// compactInline keeps fallback grouped-search snippets short enough to fit one bounded recall slot.
// compactInline 保持降级 grouped-search 片段足够紧凑，以便装入一个有界 recall 槽位。
function compactInline(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= MAX_FALLBACK_PREVIEW_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_FALLBACK_PREVIEW_CHARS - 3)}...`;
}

// hashText creates one compact deterministic fingerprint from user text so retries can be deduplicated without persisting the full prompt.
// hashText 基于用户文本创建一个紧凑的确定性指纹，让重试去重时不必持久保存完整 prompt。
function hashText(value: string): string {
  let hash = 0;
  for (const codePoint of value) {
    hash = (hash * 31 + codePoint.charCodeAt(0)) >>> 0;
  }
  return hash.toString(36);
}

// normalizeOptionalString preserves non-empty strings while discarding all other values.
// normalizeOptionalString 保留非空字符串，并丢弃其他值。
function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// asRecord safely narrows unknown hook payloads into plain objects.
// asRecord 将未知 hook 载荷安全收窄为普通对象。
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// readFiniteNumber preserves finite numeric hook fields and falls back when compaction metadata is absent or invalid.
// readFiniteNumber 保留有限数值型 hook 字段，并在压缩元数据缺失或非法时使用回退值。
function readFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
