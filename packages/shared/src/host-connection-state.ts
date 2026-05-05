// Shared vulcan-host connectivity state for OpenClaw plugins.
// 本文件负责为 OpenClaw 插件维护共享的 vulcan-host 连通性状态。

import net from "node:net";
import type { ResolvedVulcanConfig } from "./types.js";

// DEFAULT_PROBE_TIMEOUT_MS keeps one TCP reachability probe bounded so degraded calls fail fast.
// DEFAULT_PROBE_TIMEOUT_MS 用于限制单次 TCP 可达性探测时长，确保降级态调用能快速失败。
const DEFAULT_PROBE_TIMEOUT_MS = 800;

// RECONNECT_BACKOFF_STEPS_MS spaces repeated reconnect attempts so temporary outages do not thrash the Gateway.
// RECONNECT_BACKOFF_STEPS_MS 用于拉开重复重连尝试的时间间隔，避免临时故障持续冲击 Gateway。
const RECONNECT_BACKOFF_STEPS_MS = [1_000, 3_000, 10_000, 30_000] as const;

// GLOBAL_CONNECTION_STATE_KEY keeps one process-wide connectivity store shared by memory and tools plugins.
// GLOBAL_CONNECTION_STATE_KEY 用于保存一份进程级连接状态存储，让 memory 与 tools 插件共享同一份状态。
const GLOBAL_CONNECTION_STATE_KEY = Symbol.for("vulcan.openclaw.host-connection.state");

// VulcanCapabilitySurface identifies which host-facing capability should own the unavailable message shown to AI.
// VulcanCapabilitySurface 用于标识哪一类宿主能力应当生成面向 AI 的失联提示文本。
export type VulcanCapabilitySurface = "memory" | "luaskills" | "binding" | "host";

// VulcanHostConnectionPhase describes the coarse connectivity lifecycle visible to plugin callers.
// VulcanHostConnectionPhase 描述插件调用方可见的粗粒度连接生命周期状态。
export type VulcanHostConnectionPhase = "unknown" | "connected" | "probing" | "degraded";

// VulcanHostConnectionSnapshot is the read-only connectivity view consumed by hooks and tools.
// VulcanHostConnectionSnapshot 是 hooks 与工具消费的只读连接视图。
export interface VulcanHostConnectionSnapshot {
  phase: VulcanHostConnectionPhase;
  target: string;
  disconnectEpoch: number;
  retryAttempt: number;
  lastError?: string | undefined;
  lastFailureAt?: number | undefined;
  lastConnectedAt?: number | undefined;
  nextRetryAt?: number | undefined;
}

// VulcanHostConnectionLogger describes the lightweight logger surface reused by reconnect scheduling helpers.
// VulcanHostConnectionLogger 描述重连调度辅助函数复用的轻量日志接口。
export interface VulcanHostConnectionLogger {
  debug?: ((message: string) => void) | undefined;
  info?: ((message: string) => void) | undefined;
  warn?: ((message: string) => void) | undefined;
}

// VulcanHostReconnectOptions carries optional logging and force flags for reconnect scheduling paths.
// VulcanHostReconnectOptions 为重连调度路径承载可选日志与强制执行标记。
export interface VulcanHostReconnectOptions {
  logger?: VulcanHostConnectionLogger | undefined;
  force?: boolean | undefined;
}

// VulcanHostConnectionState keeps mutable retry bookkeeping that should never leak directly to callers.
// VulcanHostConnectionState 保存不应直接暴露给调用方的可变重试簿记状态。
interface VulcanHostConnectionState extends VulcanHostConnectionSnapshot {
  timer: NodeJS.Timeout | null;
  probePromise: Promise<VulcanHostConnectionSnapshot> | null;
}

// peekVulcanHostConnectionSnapshot returns the latest shared connectivity snapshot without mutating retry state.
// peekVulcanHostConnectionSnapshot 返回最新的共享连接快照，但不会修改重试状态。
export function peekVulcanHostConnectionSnapshot(
  config: ResolvedVulcanConfig,
): VulcanHostConnectionSnapshot {
  return snapshotForState(getOrCreateState(config));
}

// isVulcanHostConnectionUnavailable reports whether callers should degrade immediately instead of attempting live gRPC work.
// isVulcanHostConnectionUnavailable 用于报告调用方是否应立即降级，而不是继续尝试实时 gRPC 工作。
export function isVulcanHostConnectionUnavailable(config: ResolvedVulcanConfig): boolean {
  const state = getOrCreateState(config);
  return state.phase === "probing" || state.phase === "degraded";
}

// markVulcanHostConnected resets reconnect bookkeeping after one successful host contact or probe.
// markVulcanHostConnected 在一次成功的宿主访问或探测之后重置重连簿记状态。
export function markVulcanHostConnected(
  config: ResolvedVulcanConfig,
  logger?: VulcanHostConnectionLogger,
): VulcanHostConnectionSnapshot {
  const state = getOrCreateState(config);
  const recovered = state.phase === "degraded" || state.phase === "probing";
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  state.phase = "connected";
  state.retryAttempt = 0;
  state.lastError = undefined;
  state.lastConnectedAt = Date.now();
  state.nextRetryAt = undefined;
  if (recovered) {
    logger?.info?.(`vulcan-host connectivity recovered: ${state.target}`);
  }
  return snapshotForState(state);
}

// markVulcanHostTransportFailure records one transport-level failure and starts the shared reconnect loop when needed.
// markVulcanHostTransportFailure 记录一次传输层失败，并在需要时启动共享重连循环。
export function markVulcanHostTransportFailure(
  config: ResolvedVulcanConfig,
  error: unknown,
  options: VulcanHostReconnectOptions = {},
): VulcanHostConnectionSnapshot {
  const state = getOrCreateState(config);
  const message = normalizeErrorMessage(error);
  if (state.phase === "connected" || state.phase === "unknown") {
    state.disconnectEpoch += 1;
  }
  state.phase = "degraded";
  state.lastError = message;
  state.lastFailureAt = Date.now();
  state.retryAttempt = Math.max(1, state.retryAttempt + 1);
  ensureVulcanHostReconnectScheduled(config, options);
  return snapshotForState(state);
}

// ensureVulcanHostReconnectScheduled starts or preserves one background reconnect probe loop for the shared target.
// ensureVulcanHostReconnectScheduled 启动或保留一条面向共享目标的后台重连探测循环。
export function ensureVulcanHostReconnectScheduled(
  config: ResolvedVulcanConfig,
  options: VulcanHostReconnectOptions = {},
): VulcanHostConnectionSnapshot {
  const state = getOrCreateState(config);
  if (state.probePromise) {
    return snapshotForState(state);
  }
  if (state.timer && !options.force) {
    return snapshotForState(state);
  }
  if (state.timer && options.force) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  const delayMs = options.force ? 0 : backoffDelayForAttempt(state.retryAttempt);
  state.nextRetryAt = Date.now() + delayMs;
  options.logger?.debug?.(
    `vulcan-host reconnect scheduled in ${delayMs}ms for ${state.target} (${state.lastError ?? "no error message"}).`,
  );
  state.timer = setTimeout(() => {
    state.timer = null;
    void probeVulcanHostConnectivity(config, options.logger);
  }, delayMs);
  return snapshotForState(state);
}

// buildVulcanCapabilityUnavailableMessage returns one concise user-facing failure message for one degraded capability surface.
// buildVulcanCapabilityUnavailableMessage 为指定的降级能力表面返回一条简洁的面向用户失败消息。
export function buildVulcanCapabilityUnavailableMessage(
  capability: VulcanCapabilitySurface,
): string {
  if (capability === "memory") {
    return "Vulcan Memory 服务未启动或暂不可达，请稍后重试。";
  }
  if (capability === "luaskills") {
    return "Vulcan LuaSkills 服务未启动或暂不可达，请稍后重试。";
  }
  if (capability === "binding") {
    return "Vulcan 绑定管理服务未启动或暂不可达，请稍后重试。";
  }
  return "Vulcan 服务未启动或暂不可达，请稍后重试。";
}

// isVulcanHostTransportError detects whether one thrown error came from endpoint reachability or gRPC transport failure.
// isVulcanHostTransportError 用于识别抛出的错误是否来自端点可达性或 gRPC 传输层故障。
export function isVulcanHostTransportError(error: unknown): boolean {
  const code = typeof error === "object" && error && "code" in error ? (error as { code?: unknown }).code : undefined;
  if (code === 14 || code === "14") {
    return true;
  }
  const normalized = normalizeErrorMessage(error).toLowerCase();
  return (
    normalized.includes("vulcan-host is currently disconnected") ||
    normalized.includes("unavailable") ||
    normalized.includes("econnrefused") ||
    normalized.includes("etimedout") ||
    normalized.includes("enotfound") ||
    normalized.includes("ehostunreach") ||
    normalized.includes("socket closed") ||
    normalized.includes("no connection established") ||
    normalized.includes("connection dropped") ||
    normalized.includes("deadline exceeded") ||
    normalized.includes("failed to connect") ||
    normalized.includes("connect error")
  );
}

// probeVulcanHostConnectivity performs one bounded TCP reachability probe and updates shared state for later callers.
// probeVulcanHostConnectivity 执行一次有界的 TCP 可达性探测，并为后续调用方更新共享状态。
async function probeVulcanHostConnectivity(
  config: ResolvedVulcanConfig,
  logger?: VulcanHostConnectionLogger,
): Promise<VulcanHostConnectionSnapshot> {
  const state = getOrCreateState(config);
  if (state.probePromise) {
    return await state.probePromise;
  }
  state.phase = "probing";
  state.probePromise = (async () => {
    const reachable = await probeTcpReachability(config.endpoint, DEFAULT_PROBE_TIMEOUT_MS);
    if (reachable) {
      return markVulcanHostConnected(config, logger);
    }
    state.phase = "degraded";
    state.lastFailureAt = Date.now();
    state.lastError = state.lastError || `vulcan-host endpoint ${state.target} is still unreachable.`;
    state.retryAttempt = Math.max(1, state.retryAttempt + 1);
    ensureVulcanHostReconnectScheduled(config, { logger });
    return snapshotForState(state);
  })();
  try {
    return await state.probePromise;
  } finally {
    state.probePromise = null;
  }
}

// getOrCreateState resolves the shared mutable state bucket for one normalized target.
// getOrCreateState 解析指定规范化目标对应的共享可变状态桶。
function getOrCreateState(config: ResolvedVulcanConfig): VulcanHostConnectionState {
  const store = resolveGlobalStore();
  const key = buildConfigKey(config);
  const existing = store.get(key);
  if (existing) {
    return existing;
  }
  const created: VulcanHostConnectionState = {
    phase: "unknown",
    target: describeStateTarget(config),
    disconnectEpoch: 0,
    retryAttempt: 0,
    timer: null,
    probePromise: null,
  };
  store.set(key, created);
  return created;
}

// resolveGlobalStore resolves or initializes the process-wide connectivity-state map.
// resolveGlobalStore 解析或初始化进程级连接状态映射表。
function resolveGlobalStore(): Map<string, VulcanHostConnectionState> {
  const globalRecord = globalThis as typeof globalThis & {
    [GLOBAL_CONNECTION_STATE_KEY]?: Map<string, VulcanHostConnectionState>;
  };
  if (!globalRecord[GLOBAL_CONNECTION_STATE_KEY]) {
    globalRecord[GLOBAL_CONNECTION_STATE_KEY] = new Map<string, VulcanHostConnectionState>();
  }
  return globalRecord[GLOBAL_CONNECTION_STATE_KEY]!;
}

// buildConfigKey creates one deterministic singleton key for the actual remote host endpoint shared by every OpenClaw plugin surface.
// buildConfigKey 为所有 OpenClaw 插件表面共用的实际远端 host endpoint 构造确定性的单例键。
function buildConfigKey(config: ResolvedVulcanConfig): string {
  return config.endpoint.trim().toLowerCase();
}

// describeStateTarget formats one compact human-readable endpoint string for logs and diagnostics.
// describeStateTarget 为日志与诊断信息格式化一条紧凑可读的 endpoint 字符串。
function describeStateTarget(config: ResolvedVulcanConfig): string {
  return config.endpoint.trim();
}

// snapshotForState clones the public state shape so callers never receive mutable references.
// snapshotForState 克隆公开状态结构，避免调用方直接拿到可变引用。
function snapshotForState(state: VulcanHostConnectionState): VulcanHostConnectionSnapshot {
  return {
    phase: state.phase,
    target: state.target,
    disconnectEpoch: state.disconnectEpoch,
    retryAttempt: state.retryAttempt,
    ...(state.lastError ? { lastError: state.lastError } : {}),
    ...(state.lastFailureAt ? { lastFailureAt: state.lastFailureAt } : {}),
    ...(state.lastConnectedAt ? { lastConnectedAt: state.lastConnectedAt } : {}),
    ...(state.nextRetryAt ? { nextRetryAt: state.nextRetryAt } : {}),
  };
}

// backoffDelayForAttempt chooses one bounded reconnect delay based on the latest transport-failure streak.
// backoffDelayForAttempt 基于最近一次传输失败连击选择一条有界重连延迟。
function backoffDelayForAttempt(attempt: number): number {
  if (attempt <= 1) {
    return RECONNECT_BACKOFF_STEPS_MS[0] ?? 1_000;
  }
  return RECONNECT_BACKOFF_STEPS_MS[Math.min(RECONNECT_BACKOFF_STEPS_MS.length - 1, attempt - 1)] ?? 30_000;
}

// normalizeErrorMessage flattens unknown error shapes into a stable single-line message for logs and prompts.
// normalizeErrorMessage 将未知错误形态压平成稳定的单行文本，供日志与提示使用。
function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  return String(error);
}

// probeTcpReachability performs a lightweight connect/destroy cycle against the configured host:port endpoint.
// probeTcpReachability 对配置的 host:port 端点执行轻量连接与销毁循环。
function probeTcpReachability(endpoint: string, timeoutMs: number): Promise<boolean> {
  const target = parseEndpointTarget(endpoint);
  if (!target) {
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(target.port, target.host);
  });
}

// parseEndpointTarget converts one loose grpc endpoint into a concrete host/port pair for TCP probing.
// parseEndpointTarget 把宽松的 grpc endpoint 转换成 TCP 探测所需的确定 host/port 组合。
function parseEndpointTarget(endpoint: string): { host: string; port: number } | null {
  try {
    const normalized = endpoint.includes("://") ? endpoint : `http://${endpoint}`;
    const url = new URL(normalized);
    const port = Number.parseInt(url.port, 10);
    if (!url.hostname || !Number.isFinite(port) || port <= 0) {
      return null;
    }
    return { host: url.hostname, port };
  } catch {
    return null;
  }
}
