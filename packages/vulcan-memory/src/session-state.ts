// Session-scoped runtime state for OpenClaw profile injection and short-lived recall retention.
// 本文件负责 OpenClaw 画像注入与短期 recall 保温所需的 session 级运行时状态。

// SESSION_STATE_IDLE_TTL_MS bounds how long one inactive session state stays resident before opportunistic pruning.
// SESSION_STATE_IDLE_TTL_MS 用于限制一次非活跃 session 状态在机会性清理前最多常驻多久。
const SESSION_STATE_IDLE_TTL_MS = 6 * 60 * 60 * 1000;

// VulcanProfileBundleState keeps one fetched hidden profile bundle plus the committed-turn checkpoint used for periodic refresh.
// VulcanProfileBundleState 保存一份已获取的隐藏画像 bundle，以及定期刷新所需的 committed turn 检查点。
export interface VulcanProfileBundleState {
  signature: string;
  userId: string;
  projectId: string;
  bundleText: string;
  traceId?: string | undefined;
  fetchedAt: number;
  fetchedAtCommittedTurnCount: number;
}

// VulcanActiveRecallState keeps one bounded short-lived recall slot so OpenClaw can reuse recent recall without requerying every follow-up pass.
// VulcanActiveRecallState 保存一个有界的短期 recall 槽位，让 OpenClaw 在后续若干轮内复用最近召回，而不必每次都重复检索。
export interface VulcanActiveRecallState {
  generation: number;
  sourceTurnKey: string;
  lines: string[];
  remainingTurns: number;
  createdAt: number;
  lastInjectedAt: number;
}

// VulcanSessionMemoryState groups all runtime-only profile and recall state tracked per OpenClaw session.
// VulcanSessionMemoryState 汇总每个 OpenClaw session 跟踪的全部运行时画像与 recall 状态。
export interface VulcanSessionMemoryState {
  sessionKey: string;
  committedTurnCount: number;
  lastTouchedAt: number;
  lastTurnKey?: string | undefined;
  lastDisconnectNoticeEpoch?: number | undefined;
  profileBundle?: VulcanProfileBundleState | undefined;
  activeRecall?: VulcanActiveRecallState | undefined;
}

// sessionStateStore keeps per-session runtime state in memory because OpenClaw already provides explicit session lifecycle hooks.
// sessionStateStore 把每个 session 的运行时状态保存在内存中，因为 OpenClaw 已经提供了明确的 session 生命周期 hooks。
const sessionStateStore = new Map<string, VulcanSessionMemoryState>();

// nextRecallGeneration monotonically bumps recall generations so later updates can clearly supersede earlier cached recall.
// nextRecallGeneration 单调递增 recall generation，让后续更新能明确替换掉更早的缓存 recall。
let nextRecallGeneration = 1;

// lastGlobalDisconnectNoticeToken keeps one process-level one-shot token for disconnect notices emitted without any session identity.
// lastGlobalDisconnectNoticeToken 为没有任何 session 身份的断连提示保留一份进程级一次性令牌。
let lastGlobalDisconnectNoticeToken: string | undefined;

// getOrCreateSessionMemoryState returns one live session state and opportunistically prunes long-idle snapshots.
// getOrCreateSessionMemoryState 返回一份存活中的 session 状态，并机会性清理长时间空闲的快照。
export function getOrCreateSessionMemoryState(sessionKey: string): VulcanSessionMemoryState {
  pruneIdleSessionStates();
  const normalizedKey = normalizeSessionKey(sessionKey);
  const existing = sessionStateStore.get(normalizedKey);
  if (existing) {
    existing.lastTouchedAt = Date.now();
    return existing;
  }
  const created: VulcanSessionMemoryState = {
    sessionKey: normalizedKey,
    committedTurnCount: 0,
    lastTouchedAt: Date.now(),
  };
  sessionStateStore.set(normalizedKey, created);
  return created;
}

// peekSessionMemoryState returns one existing session state without creating new entries.
// peekSessionMemoryState 返回一份已存在的 session 状态，但不会创建新条目。
export function peekSessionMemoryState(
  sessionKey: string | undefined,
): VulcanSessionMemoryState | undefined {
  const normalizedKey = normalizeSessionKey(sessionKey);
  if (!normalizedKey) {
    return undefined;
  }
  return sessionStateStore.get(normalizedKey);
}

// startSessionMemoryState initializes one fresh session state and optionally carries forward durable profile cache from a resumed predecessor.
// startSessionMemoryState 初始化一份新的 session 状态，并在恢复场景下按需继承前一个 session 的持久画像缓存。
export function startSessionMemoryState(params: {
  sessionKey: string;
  resumedFrom?: string | undefined;
}): VulcanSessionMemoryState {
  pruneIdleSessionStates();
  const normalizedKey = normalizeSessionKey(params.sessionKey);
  const resumedState = peekSessionMemoryState(params.resumedFrom);
  const nextState: VulcanSessionMemoryState = {
    sessionKey: normalizedKey,
    committedTurnCount: 0,
    lastTouchedAt: Date.now(),
    profileBundle: resumedState?.profileBundle ? { ...resumedState.profileBundle } : undefined,
  };
  sessionStateStore.set(normalizedKey, nextState);
  return nextState;
}

// deleteSessionMemoryState removes one session state snapshot after session_end or hard reset events.
// deleteSessionMemoryState 在 session_end 或硬重置事件后移除一份 session 状态快照。
export function deleteSessionMemoryState(sessionKey: string | undefined): void {
  const normalizedKey = normalizeSessionKey(sessionKey);
  if (!normalizedKey) {
    return;
  }
  sessionStateStore.delete(normalizedKey);
}

// clearAllSessionMemoryStates drops every runtime snapshot, mainly for tests or future plugin unload cleanup.
// clearAllSessionMemoryStates 丢弃全部运行时快照，主要供测试或未来插件卸载清理使用。
export function clearAllSessionMemoryStates(): void {
  sessionStateStore.clear();
  lastGlobalDisconnectNoticeToken = undefined;
}

// markSessionTurn records the latest turn key and reports whether this prompt-build pass opened a new real turn boundary.
// markSessionTurn 记录最新 turn key，并报告这次 prompt-build 是否开启了新的真实 turn 边界。
export function markSessionTurn(state: VulcanSessionMemoryState, turnKey: string): boolean {
  state.lastTouchedAt = Date.now();
  if (state.lastTurnKey === turnKey) {
    return false;
  }
  state.lastTurnKey = turnKey;
  return true;
}

// consumeActiveRecallForNewTurn returns the currently warmed recall lines for this turn and decrements the remaining-turn budget for later turns.
// consumeActiveRecallForNewTurn 返回本轮可继续使用的保温 recall 行，并同步递减留给后续轮次的预算。
export function consumeActiveRecallForNewTurn(state: VulcanSessionMemoryState): string[] {
  const activeRecall = state.activeRecall;
  if (!activeRecall || activeRecall.remainingTurns <= 0) {
    state.activeRecall = undefined;
    return [];
  }
  const lines = [...activeRecall.lines];
  activeRecall.remainingTurns = Math.max(0, activeRecall.remainingTurns - 1);
  activeRecall.lastInjectedAt = Date.now();
  if (activeRecall.remainingTurns <= 0) {
    state.activeRecall = undefined;
  }
  return lines;
}

// peekActiveRecallLines returns the active recall lines without consuming the remaining-turn budget.
// peekActiveRecallLines 返回当前激活的 recall 行，但不会消耗剩余轮次预算。
export function peekActiveRecallLines(state: VulcanSessionMemoryState): string[] {
  const activeRecall = state.activeRecall;
  if (!activeRecall || activeRecall.remainingTurns <= 0) {
    return [];
  }
  return [...activeRecall.lines];
}

// replaceActiveRecall rewrites the single active recall slot so new recall can safely supersede stale context and avoid context explosion.
// replaceActiveRecall 重写当前唯一的 recall 槽位，让新 recall 能安全替换旧上下文，避免上下文膨胀。
export function replaceActiveRecall(
  state: VulcanSessionMemoryState,
  turnKey: string,
  lines: string[],
  turns: number,
): VulcanActiveRecallState | undefined {
  const normalizedLines = dedupeNormalizedLines(lines);
  if (normalizedLines.length === 0 || turns <= 0) {
    state.activeRecall = undefined;
    return undefined;
  }
  const recall: VulcanActiveRecallState = {
    generation: nextRecallGeneration++,
    sourceTurnKey: turnKey,
    lines: normalizedLines,
    remainingTurns: Math.max(0, Math.floor(turns)),
    createdAt: Date.now(),
    lastInjectedAt: Date.now(),
  };
  state.activeRecall = recall;
  state.lastTouchedAt = Date.now();
  return recall;
}

// clearActiveRecall removes the single active recall slot after expiry, scope changes, or explicit degradation fallback.
// clearActiveRecall 在 recall 过期、作用域变化或显式降级回退后移除唯一的 recall 槽位。
export function clearActiveRecall(state: VulcanSessionMemoryState): void {
  state.activeRecall = undefined;
  state.lastTouchedAt = Date.now();
}

// incrementCommittedTurnCount advances the stable committed-turn counter used by profile refresh cadence.
// incrementCommittedTurnCount 推进用于画像刷新节奏的稳定 committed turn 计数器。
export function incrementCommittedTurnCount(state: VulcanSessionMemoryState): number {
  state.committedTurnCount += 1;
  state.lastTouchedAt = Date.now();
  return state.committedTurnCount;
}

// shouldInjectDisconnectNotice reports whether the current disconnect epoch still needs one user-facing warning in this session.
// shouldInjectDisconnectNotice 用于报告当前断连 epoch 是否仍需要在该 session 内注入一次面向用户的提示。
export function shouldInjectDisconnectNotice(
  state: VulcanSessionMemoryState | undefined,
  disconnectEpoch: number,
  noticeScopeKey = "global",
): boolean {
  if (disconnectEpoch <= 0) {
    return false;
  }
  if (!state) {
    return lastGlobalDisconnectNoticeToken !== buildDisconnectNoticeToken(noticeScopeKey, disconnectEpoch);
  }
  return state.lastDisconnectNoticeEpoch !== disconnectEpoch;
}

// markDisconnectNoticeInjected records that one disconnect epoch has already emitted its one-shot prompt for this session.
// markDisconnectNoticeInjected 用于记录某个断连 epoch 已经在当前 session 中发出过一次性提示。
export function markDisconnectNoticeInjected(
  state: VulcanSessionMemoryState | undefined,
  disconnectEpoch: number,
  noticeScopeKey = "global",
): void {
  if (disconnectEpoch <= 0) {
    return;
  }
  if (!state) {
    lastGlobalDisconnectNoticeToken = buildDisconnectNoticeToken(noticeScopeKey, disconnectEpoch);
    return;
  }
  state.lastDisconnectNoticeEpoch = disconnectEpoch;
  state.lastTouchedAt = Date.now();
}

// buildDisconnectNoticeToken combines one disconnect epoch with one host-connection scope so global fallback notices do not collide across targets.
// buildDisconnectNoticeToken 将断连 epoch 与宿主连接作用域组合起来，避免全局回退提示在不同目标之间互相冲突。
function buildDisconnectNoticeToken(noticeScopeKey: string, disconnectEpoch: number): string {
  return `${noticeScopeKey}::${disconnectEpoch}`;
}

// normalizeSessionKey trims one maybe-empty session key so state maps never key on whitespace noise.
// normalizeSessionKey 裁剪可能为空的 session key，避免状态映射误落到空白键上。
function normalizeSessionKey(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

// pruneIdleSessionStates evicts stale in-memory state so long-running gateways do not accumulate abandoned sessions forever.
// pruneIdleSessionStates 驱逐陈旧的内存态，避免长时间运行的 Gateway 永久堆积废弃 session。
function pruneIdleSessionStates(): void {
  const cutoff = Date.now() - SESSION_STATE_IDLE_TTL_MS;
  for (const [sessionKey, state] of sessionStateStore.entries()) {
    if (state.lastTouchedAt < cutoff) {
      sessionStateStore.delete(sessionKey);
    }
  }
}

// dedupeNormalizedLines compacts one loose recall line list into stable trimmed unique lines.
// dedupeNormalizedLines 把宽松的 recall 行列表压缩成稳定的裁剪后唯一文本行。
function dedupeNormalizedLines(lines: string[]): string[] {
  return [...new Set(lines.map((line) => line.trim()).filter(Boolean))];
}
