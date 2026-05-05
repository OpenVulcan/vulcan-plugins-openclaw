// Configuration resolution for Vulcan OpenClaw plugins.
// 本文件负责解析 Vulcan OpenClaw 插件配置。

import type { ResolvedVulcanConfig, VulcanOpenClawPluginConfig } from "./types.js";

// DEFAULT_ENDPOINT is the vulcan-host gRPC address used by the Rust runtime.
// DEFAULT_ENDPOINT 是 Rust 运行时默认使用的 vulcan-host gRPC 地址。
const DEFAULT_ENDPOINT = "127.0.0.1:19202";

// DEFAULT_CLIENT_NAME keeps vulcan-host budget/profile matching stable for OpenClaw.
// DEFAULT_CLIENT_NAME 让 vulcan-host 对 OpenClaw 的预算与画像匹配保持稳定。
const DEFAULT_CLIENT_NAME = "openclaw";

// DEFAULT_CLIENT_VERSION identifies this adapter while the package is still pre-release.
// DEFAULT_CLIENT_VERSION 用于在当前预发布阶段标识这个适配器。
const DEFAULT_CLIENT_VERSION = "0.1.0";

// DEFAULT_HOST_READY_TIMEOUT_MS bounds how long host autostart waits for the gRPC endpoint to become reachable.
// DEFAULT_HOST_READY_TIMEOUT_MS 用于限制 host 自启动等待 gRPC 端点可达的最长时间。
const DEFAULT_HOST_READY_TIMEOUT_MS = 15_000;

// DEFAULT_BINDING_USER_ID keeps memory-capable hosts operational before explicit VMM binding is configured.
// DEFAULT_BINDING_USER_ID 在显式 VMM 绑定尚未配置前，保持记忆型宿主仍可运行。
const DEFAULT_BINDING_USER_ID = "1";

// DEFAULT_BINDING_PROJECT_ID keeps memory-capable hosts operational before explicit VMM binding is configured.
// DEFAULT_BINDING_PROJECT_ID 在显式 VMM 绑定尚未配置前，保持记忆型宿主仍可运行。
const DEFAULT_BINDING_PROJECT_ID = "1";

// DEFAULT_IMPLICIT_MEMORY_TURNS keeps short-lived recall warm for a bounded number of later turns.
// DEFAULT_IMPLICIT_MEMORY_TURNS 让短期 recall 在有限的后续轮次内保持保温。
const DEFAULT_IMPLICIT_MEMORY_TURNS = 5;

// DEFAULT_PROFILE_REFRESH_TURNS refreshes the hidden profile bundle after a bounded number of accepted committed turns.
// DEFAULT_PROFILE_REFRESH_TURNS 在有限的已接纳 committed turn 数之后刷新隐藏画像 bundle。
const DEFAULT_PROFILE_REFRESH_TURNS = 5;

// asRecord safely narrows unknown plugin config into a plain object.
// asRecord 将未知插件配置安全收窄为普通对象。
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// readBoolean reads a boolean config value with a default fallback.
// readBoolean 读取布尔配置值，并在缺失时使用默认值。
function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

// readNumber reads a positive numeric config value with a default fallback.
// readNumber 读取正数配置值，并在缺失或非法时使用默认值。
function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

// readNonNegativeInteger reads one non-negative integer config value with a default fallback.
// readNonNegativeInteger 读取一个非负整数配置值，并在缺失或非法时使用默认值。
function readNonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.max(0, Math.floor(value))
    : fallback;
}

// readString reads a non-empty string config value with a default fallback.
// readString 读取非空字符串配置值，并在缺失时使用默认值。
function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

// readOptionalString reads one optional non-empty string without forcing a fallback placeholder.
// readOptionalString 读取一个可选非空字符串，而不是强行写入回退占位值。
function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// readStringArray normalizes a loose string-array config into trimmed non-empty strings.
// readStringArray 把宽松的字符串数组配置归一化为裁剪后的非空字符串列表。
function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

// readStringRecord normalizes a loose env-like object into a stable string map.
// readStringRecord 把宽松的类环境变量对象归一化为稳定的字符串映射。
function readStringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value);
  const next: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(record)) {
    const key = typeof rawKey === "string" ? rawKey.trim() : "";
    if (!key) {
      continue;
    }
    if (typeof rawValue === "string" && rawValue.trim()) {
      next[key] = rawValue;
      continue;
    }
    if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
      next[key] = String(rawValue);
      continue;
    }
    if (typeof rawValue === "boolean") {
      next[key] = rawValue ? "true" : "false";
    }
  }
  return next;
}

// normalizePluginConfig converts OpenClaw's loose pluginConfig object into a typed config.
// normalizePluginConfig 将 OpenClaw 松散的 pluginConfig 对象转换为类型化配置。
export function normalizePluginConfig(value: unknown): VulcanOpenClawPluginConfig {
  const root = asRecord(value);
  const host = asRecord(root.host);
  const bindings = asRecord(root.bindings);
  const tools = asRecord(root.tools);
  const memory = asRecord(root.memory);
  return {
    endpoint: typeof root.endpoint === "string" ? root.endpoint : undefined,
    protoPath: typeof root.protoPath === "string" ? root.protoPath : undefined,
    clientName: typeof root.clientName === "string" ? root.clientName : undefined,
    clientVersion: typeof root.clientVersion === "string" ? root.clientVersion : undefined,
    enabled: typeof root.enabled === "boolean" ? root.enabled : undefined,
    host: {
      autoStart: typeof host.autoStart === "boolean" ? host.autoStart : undefined,
      command: typeof host.command === "string" ? host.command : undefined,
      args: Array.isArray(host.args) ? host.args.filter((entry) => typeof entry === "string") : undefined,
      cwd: typeof host.cwd === "string" ? host.cwd : undefined,
      readyTimeoutMs: typeof host.readyTimeoutMs === "number" ? host.readyTimeoutMs : undefined,
      env:
        host.env && typeof host.env === "object" && !Array.isArray(host.env)
          ? (host.env as Record<string, string | number | boolean>)
          : undefined,
    },
    bindings: {
      defaultUserId:
        typeof bindings.defaultUserId === "string" || typeof bindings.defaultUserId === "number"
          ? (bindings.defaultUserId as string | number)
          : undefined,
      defaultProjectId:
        typeof bindings.defaultProjectId === "string" || typeof bindings.defaultProjectId === "number"
          ? (bindings.defaultProjectId as string | number)
          : undefined,
      agentProjects:
        bindings.agentProjects && typeof bindings.agentProjects === "object" && !Array.isArray(bindings.agentProjects)
          ? (bindings.agentProjects as Record<string, string | number>)
          : undefined,
    },
    tools: {
      enabled: typeof tools.enabled === "boolean" ? tools.enabled : undefined,
      dispatcherEnabled:
        typeof tools.dispatcherEnabled === "boolean" ? tools.dispatcherEnabled : undefined,
      timeoutMs: typeof tools.timeoutMs === "number" ? tools.timeoutMs : undefined,
    },
    memory: {
      enabled: typeof memory.enabled === "boolean" ? memory.enabled : undefined,
      autoRecall: typeof memory.autoRecall === "boolean" ? memory.autoRecall : undefined,
      autoPostAction:
        typeof memory.autoPostAction === "boolean" ? memory.autoPostAction : undefined,
      recallTopK: typeof memory.recallTopK === "number" ? memory.recallTopK : undefined,
      implicitMemoryTurns:
        typeof memory.implicitMemoryTurns === "number" ? memory.implicitMemoryTurns : undefined,
      profileRefreshTurns:
        typeof memory.profileRefreshTurns === "number" ? memory.profileRefreshTurns : undefined,
      timeoutMs: typeof memory.timeoutMs === "number" ? memory.timeoutMs : undefined,
    },
  };
}

// resolveVulcanConfig merges OpenClaw plugin config and environment variables.
// resolveVulcanConfig 合并 OpenClaw 插件配置与环境变量。
export function resolveVulcanConfig(value: unknown): ResolvedVulcanConfig {
  const config = normalizePluginConfig(value);
  return {
    endpoint: readString(
      config.endpoint ?? process.env.VULCAN_HOST_GRPC_ENDPOINT,
      DEFAULT_ENDPOINT,
    ),
    protoPath: config.protoPath ?? process.env.VULCAN_HOST_PROTO_PATH,
    clientName: readString(config.clientName, DEFAULT_CLIENT_NAME),
    clientVersion: readString(config.clientVersion, DEFAULT_CLIENT_VERSION),
    enabled: readBoolean(config.enabled, true),
    host: {
      autoStart: readBoolean(config.host?.autoStart, false),
      command: readOptionalString(config.host?.command ?? process.env.VULCAN_HOST_COMMAND),
      args: readStringArray(config.host?.args),
      cwd: readOptionalString(config.host?.cwd ?? process.env.VULCAN_HOST_CWD),
      readyTimeoutMs: readNumber(config.host?.readyTimeoutMs, DEFAULT_HOST_READY_TIMEOUT_MS),
      env: readStringRecord(config.host?.env),
    },
    bindings: {
      defaultUserId: readBindingId(config.bindings?.defaultUserId, DEFAULT_BINDING_USER_ID),
      defaultProjectId: readBindingId(config.bindings?.defaultProjectId, DEFAULT_BINDING_PROJECT_ID),
      agentProjects: readBindingMap(config.bindings?.agentProjects),
    },
    tools: {
      enabled: readBoolean(config.tools?.enabled, true),
      dispatcherEnabled: readBoolean(config.tools?.dispatcherEnabled, true),
      timeoutMs: readNumber(config.tools?.timeoutMs, 30_000),
    },
    memory: {
      enabled: readBoolean(config.memory?.enabled, true),
      autoRecall: readBoolean(config.memory?.autoRecall, true),
      autoPostAction: readBoolean(config.memory?.autoPostAction, false),
      recallTopK: readNumber(config.memory?.recallTopK, 5),
      implicitMemoryTurns: readNonNegativeInteger(
        config.memory?.implicitMemoryTurns,
        DEFAULT_IMPLICIT_MEMORY_TURNS,
      ),
      profileRefreshTurns: readNonNegativeInteger(
        config.memory?.profileRefreshTurns,
        DEFAULT_PROFILE_REFRESH_TURNS,
      ),
      timeoutMs: readNumber(config.memory?.timeoutMs, 15_000),
    },
  };
}

// readBindingId normalizes one plugin-config binding id into a positive-decimal string with fallback.
// readBindingId 把插件配置中的单个绑定 ID 归一化为正整数字符串，并在缺失时使用回退值。
function readBindingId(value: unknown, fallback: string): string {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return String(Math.trunc(value));
  }
  if (typeof value === "string" && /^[1-9]\d*$/u.test(value.trim())) {
    return value.trim();
  }
  return fallback;
}

// readBindingMap normalizes one loose agent->project binding object into a stable string map.
// readBindingMap 把宽松的 agent->project 绑定对象归一化为稳定的字符串映射。
function readBindingMap(value: unknown): Record<string, string> {
  const record = asRecord(value);
  const next: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(record)) {
    const agentId = typeof rawKey === "string" ? rawKey.trim() : "";
    if (!agentId) {
      continue;
    }
    if (typeof rawValue === "number" && Number.isFinite(rawValue) && rawValue > 0) {
      next[agentId] = String(Math.trunc(rawValue));
      continue;
    }
    if (typeof rawValue === "string" && /^[1-9]\d*$/u.test(rawValue.trim())) {
      next[agentId] = rawValue.trim();
    }
  }
  return next;
}
