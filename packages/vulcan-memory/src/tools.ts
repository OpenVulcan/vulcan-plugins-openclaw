// Native and compatibility memory tools for bridging OpenClaw memory workflows into Vulcan Memory Mesh.
// 本文件实现把 OpenClaw 记忆工作流桥接到 Vulcan Memory Mesh 的原生与兼容工具。

import {
  buildVulcanCapabilityUnavailableMessage,
  buildToolHostContext,
  createVulcanHostClient,
  ensureVulcanHostReconnectScheduled,
  errorToolResult,
  isVulcanHostConnectionUnavailable,
  isVulcanHostTransportError,
  jsonToolResult,
  peekVulcanHostConnectionSnapshot,
  shouldExposeVulcanToolSurface,
  textToolResult,
  type JsonValue,
  type ResolvedVulcanConfig,
  type VulcanToolDescriptor,
} from "@vulcan-plugins-openclaw/shared";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  formatVulcanMemorySearchText,
  formatVulcanTurnDetailsText,
  getOrCreateVulcanMemoryManager,
  deleteVulcanMemoryEntries,
  loadVulcanTurnDetails,
  searchVulcanMemoryEntries,
} from "./manager.js";
import { GENERATED_VMM_TOOLS } from "./generated/vmm-tools.generated.js";

// MemorySearchSchema follows the legacy bridge memory_search shape so OpenClaw can still expose a standard-name adapter when required.
// MemorySearchSchema 遵循旧式桥接 memory_search 形态，让 OpenClaw 在必要时仍可暴露标准名称适配器。
const MemorySearchSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: {
      type: "string",
      description: "Search query for prior project facts, source-turn context, user preferences, or decisions.",
    },
    maxResults: {
      type: "number",
      description: "Optional maximum hit count. Prefer 3 to 8 for targeted recall.",
    },
    minScore: {
      type: "number",
      description: "Optional minimum synthetic score threshold between 0 and 1.",
    },
    corpus: {
      type: "string",
      enum: ["memory", "sessions", "all", "wiki"],
      description:
        "Restrict results to durable VMM memories or session-backed hits. `all` currently behaves like Vulcan memory-only recall, and `wiki` is unsupported.",
    },
  },
  required: ["query"],
} as const;

// MemoryGetSchema follows the legacy bridge memory_get shape while reading Vulcan pseudo-paths.
// MemoryGetSchema 遵循旧式桥接 memory_get 形态，同时读取 Vulcan 伪路径。
const MemoryGetSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: {
      type: "string",
      description:
        "Pseudo-path returned by memory_search, such as `vulcan-turns/123.md` or `vulcan-memories/456.md`.",
    },
    from: {
      type: "number",
      description: "Optional 1-based start line for paged reads.",
    },
    lines: {
      type: "number",
      description: "Optional line count for paged reads.",
    },
    corpus: {
      type: "string",
      enum: ["memory", "all", "wiki"],
      description: "`wiki` is unsupported by Vulcan memory and will return an unavailable result.",
    },
  },
  required: ["path"],
} as const;

// CompatMemorySearchSchema serves the primary Vulcan-native grouped search surface exposed to OpenClaw models.
// CompatMemorySearchSchema 作为 OpenClaw 模型可见的主 Vulcan 原生分组搜索表面。
const CompatMemorySearchSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    queries: {
      type: "array",
      description:
        "Concrete memory search queries. Prefer 1-3 precise strings; broad scans may use more when triaging.",
      items: { type: "string" },
      minItems: 1,
      maxItems: 16,
    },
    topK: {
      type: "number",
      description: "Optional maximum hit count per query. Prefer 3 to 8 for direct recall.",
    },
  },
  required: ["queries"],
} as const;

// CompatMemoryGetSchema serves the primary Vulcan-native grouped follow-up reader exposed to OpenClaw models.
// CompatMemoryGetSchema 作为 OpenClaw 模型可见的主 Vulcan 原生分组后续读取表面。
const CompatMemoryGetSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    turnIds: {
      type: "array",
      description: "Decimal source_turn_id strings returned by vulcan_memory_search. Skip 0 because it has no source turn.",
      items: { type: "string" },
      minItems: 1,
    },
  },
  required: ["turnIds"],
} as const;

// CompatMemoryDeleteSchema serves the primary Vulcan-native explicit memory-delete surface exposed to OpenClaw models.
// CompatMemoryDeleteSchema 作为 OpenClaw 模型可见的主 Vulcan 原生明确删记忆表面。
const CompatMemoryDeleteSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    memoryIds: {
      type: "array",
      description:
        "Exact durable memory_id strings to delete. Use only ids returned by vulcan_memory_search or PreCheck VMM_ID markers; never use turn_id/source_turn_id.",
      items: {
        type: "string",
        pattern: "^[1-9][0-9]*$",
      },
      minItems: 1,
      maxItems: 16,
    },
    reason: {
      type: "string",
      description:
        "Required audit reason. Use this only after the user explicitly asks to delete, remove, or replace the specific remembered information.",
      minLength: 1,
    },
  },
  required: ["memoryIds", "reason"],
} as const;

// CANONICAL_MEMORY_SEARCH_TOOL is the legacy bridge memory_search descriptor synchronized from vulcan-host.
// CANONICAL_MEMORY_SEARCH_TOOL 是从 vulcan-host 同步下来的旧式桥接 memory_search 描述符。
const CANONICAL_MEMORY_SEARCH_TOOL = "memory_search";

// CANONICAL_MEMORY_GET_TOOL is the legacy bridge memory_get descriptor synchronized from vulcan-host.
// CANONICAL_MEMORY_GET_TOOL 是从 vulcan-host 同步下来的旧式桥接 memory_get 描述符。
const CANONICAL_MEMORY_GET_TOOL = "memory_get";

// COMPAT_MEMORY_SEARCH_TOOL is the primary Vulcan-native grouped search descriptor synchronized from vulcan-host.
// COMPAT_MEMORY_SEARCH_TOOL 是从 vulcan-host 同步下来的主 Vulcan 原生分组搜索描述符。
const COMPAT_MEMORY_SEARCH_TOOL = "vulcan_memory_search";

// COMPAT_MEMORY_GET_TOOL is the primary Vulcan-native grouped read descriptor synchronized from vulcan-host.
// COMPAT_MEMORY_GET_TOOL 是从 vulcan-host 同步下来的主 Vulcan 原生分组读取描述符。
const COMPAT_MEMORY_GET_TOOL = "vulcan_memory_get";

// COMPAT_MEMORY_DELETE_TOOL is the primary Vulcan-native grouped delete descriptor synchronized from vulcan-host.
// COMPAT_MEMORY_DELETE_TOOL 是从 vulcan-host 同步下来的主 Vulcan 原生分组删除描述符。
const COMPAT_MEMORY_DELETE_TOOL = "vmm_memory_delete";

// CreateMemoryToolParams groups dependencies needed to construct OpenClaw memory tools.
// CreateMemoryToolParams 汇总构造 OpenClaw 记忆工具所需的依赖。
interface CreateMemoryToolParams {
  api: OpenClawPluginApi;
  config: ResolvedVulcanConfig;
  ctx: OpenClawPluginToolContext;
}

// MEMORY_UNAVAILABLE_MESSAGE keeps one stable operator-facing failure text for all Vulcan memory surfaces while host reconnect is in progress.
// MEMORY_UNAVAILABLE_MESSAGE 为所有 Vulcan 记忆表面保留一条稳定的面向操作者失败文本，供宿主重连期间复用。
const MEMORY_UNAVAILABLE_MESSAGE = buildVulcanCapabilityUnavailableMessage("memory");

// failFastWhenHostDisconnected returns one immediate memory-tool failure when the shared host state is already degraded.
// failFastWhenHostDisconnected 会在共享 host 状态已进入降级态时立即返回一条记忆工具失败结果。
function failFastWhenHostDisconnected(params: CreateMemoryToolParams) {
  if (!isVulcanHostConnectionUnavailable(params.config)) {
    return null;
  }
  ensureVulcanHostReconnectScheduled(params.config, { logger: params.api.logger });
  params.api.logger.debug?.(
    `vulcan-memory: ${peekVulcanHostConnectionSnapshot(params.config).target} is reconnecting; fail fast for this tool call.`,
  );
  return errorToolResult(MEMORY_UNAVAILABLE_MESSAGE);
}

// mapMemoryTransportError normalizes transport failures into one stable degraded-state tool result while preserving non-transport errors for diagnostics.
// mapMemoryTransportError 会把传输层失败归一化为稳定的降级态工具结果，同时保留非传输错误供诊断。
function mapMemoryTransportError(
  params: CreateMemoryToolParams,
  error: unknown,
): ReturnType<typeof errorToolResult> | null {
  if (!isVulcanHostTransportError(error)) {
    return null;
  }
  ensureVulcanHostReconnectScheduled(params.config, { logger: params.api.logger, force: true });
  return errorToolResult(MEMORY_UNAVAILABLE_MESSAGE);
}

// createMemorySearchTool creates the optional bridge memory_search tool backed by VMM.
// createMemorySearchTool 创建由 VMM 支撑的可选桥接 memory_search 工具。
export function createMemorySearchTool(params: CreateMemoryToolParams): AnyAgentTool | null {
  if (!params.config.enabled || !params.config.memory.enabled) {
    return null;
  }
  if (!shouldExposeVulcanToolSurface({
    runtimeConfig: resolveToolRuntimeConfig(params.ctx),
    agentId: params.ctx.agentId,
    surface: "memory-bridge",
  })) {
    return null;
  }
  return {
    name: "memory_search",
    label: "Legacy Memory Search",
    description: resolveGeneratedDescription(
      CANONICAL_MEMORY_SEARCH_TOOL,
      "Legacy bridge surface for hosts that still require the canonical `memory_search` name. Search durable VMM memories and session-backed source turns before answering when prior project facts, preferences, requirements, bugs, or decisions may matter. Hosts that expose explicit Vulcan tools should prefer `vulcan_memory_search` instead.",
    ),
    parameters: resolveGeneratedSchema(CANONICAL_MEMORY_SEARCH_TOOL, MemorySearchSchema),
    async execute(_toolCallId, rawParams) {
      const input = readCanonicalSearchParams(rawParams);
      if (!input) {
        return errorToolResult("query must be a non-empty string.");
      }
      const unavailable = failFastWhenHostDisconnected(params);
      if (unavailable) {
        return unavailable;
      }
      if (input.corpus === "wiki") {
        return jsonToolResult({
          results: [],
          unavailable: true,
          error: "Vulcan memory does not currently serve wiki-only corpus reads.",
        });
      }
      try {
        const client = createVulcanHostClient(params.config);
        const manager = getOrCreateVulcanMemoryManager({
          client,
          config: params.config,
          baseContext: buildToolHostContext(params.ctx, params.config),
        });
        const results = await manager.search(input.query, {
          maxResults: input.maxResults,
          minScore: input.minScore,
          sessionKey: params.ctx.sessionKey,
          sources: resolveCanonicalSources(input.corpus),
        });
        return jsonToolResult({
          results,
          provider: "vulcan-vmm",
          backend: "builtin",
          total: results.length,
        } as unknown as JsonValue);
      } catch (error) {
        params.api.logger.warn?.(`vulcan-memory: memory_search failed: ${String(error)}`);
        const unavailable = mapMemoryTransportError(params, error);
        if (unavailable) {
          return unavailable;
        }
        return jsonToolResult({
          results: [],
          disabled: true,
          unavailable: true,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

// createMemoryGetTool creates the optional bridge memory_get tool backed by the native VMM manager.
// createMemoryGetTool 创建由原生 VMM manager 支撑的可选桥接 memory_get 工具。
export function createMemoryGetTool(params: CreateMemoryToolParams): AnyAgentTool | null {
  if (!params.config.enabled || !params.config.memory.enabled) {
    return null;
  }
  if (!shouldExposeVulcanToolSurface({
    runtimeConfig: resolveToolRuntimeConfig(params.ctx),
    agentId: params.ctx.agentId,
    surface: "memory-bridge",
  })) {
    return null;
  }
  return {
    name: "memory_get",
    label: "Legacy Memory Get",
    description: resolveGeneratedDescription(
      CANONICAL_MEMORY_GET_TOOL,
      "Legacy bridge surface for hosts that still require the canonical `memory_get` name. Read one exact Vulcan memory pseudo-document returned by `memory_search`, including source turn documents and durable memory previews. Hosts that expose explicit Vulcan tools should prefer `vulcan_memory_get` instead.",
    ),
    parameters: resolveGeneratedSchema(CANONICAL_MEMORY_GET_TOOL, MemoryGetSchema),
    async execute(_toolCallId, rawParams) {
      const input = readCanonicalGetParams(rawParams);
      if (!input) {
        return errorToolResult("path must be a non-empty string.");
      }
      const unavailable = failFastWhenHostDisconnected(params);
      if (unavailable) {
        return unavailable;
      }
      if (input.corpus === "wiki") {
        return jsonToolResult({
          path: input.path,
          text: "",
          unavailable: true,
          error: "Vulcan memory does not currently serve wiki-only reads.",
        });
      }
      try {
        const client = createVulcanHostClient(params.config);
        const manager = getOrCreateVulcanMemoryManager({
          client,
          config: params.config,
          baseContext: buildToolHostContext(params.ctx, params.config),
        });
        const result = await manager.readFile({
          relPath: input.path,
          from: input.from,
          lines: input.lines,
        });
        return jsonToolResult(result as unknown as JsonValue);
      } catch (error) {
        params.api.logger.warn?.(`vulcan-memory: memory_get failed: ${String(error)}`);
        const unavailable = mapMemoryTransportError(params, error);
        if (unavailable) {
          return unavailable;
        }
        return jsonToolResult({
          path: input.path,
          text: "",
          disabled: true,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

// createVulcanMemorySearchTool creates the primary Vulcan-native grouped search tool exposed to OpenClaw models.
// createVulcanMemorySearchTool 创建对 OpenClaw 模型暴露的主 Vulcan 原生分组搜索工具。
export function createVulcanMemorySearchTool(params: CreateMemoryToolParams): AnyAgentTool | null {
  if (!params.config.enabled || !params.config.memory.enabled) {
    return null;
  }
  if (!shouldExposeVulcanToolSurface({
    runtimeConfig: resolveToolRuntimeConfig(params.ctx),
    agentId: params.ctx.agentId,
    surface: "memory-native",
  })) {
    return null;
  }
  return {
    name: "vulcan_memory_search",
    label: "Vulcan Memory Search",
    description: resolveGeneratedDescription(
      COMPAT_MEMORY_SEARCH_TOOL,
      "Primary Vulcan-native memory search surface for the current OpenClaw runtime. Search durable Vulcan Memory Mesh memories when prior project facts, requirements, decisions, bugs, preferences, or durable context may matter. The grouped result format keeps raw hits, memory ids, category labels, and source_turn_id values available for precise follow-up inspection.",
    ),
    parameters: resolveGeneratedSchema(COMPAT_MEMORY_SEARCH_TOOL, CompatMemorySearchSchema),
    async execute(_toolCallId, rawParams) {
      const input = readCompatSearchParams(rawParams, params.config.memory.recallTopK);
      if (!input) {
        return errorToolResult("queries must be a non-empty string array.");
      }
      const unavailable = failFastWhenHostDisconnected(params);
      if (unavailable) {
        return unavailable;
      }
      try {
        const client = createVulcanHostClient(params.config);
        const response = await searchVulcanMemoryEntries({
          client,
          config: params.config,
          context: buildToolHostContext(params.ctx, params.config),
          queries: input.queries,
          topK: input.topK,
        });
        if ("error" in response) {
          return errorToolResult(response.error);
        }
        return textToolResult(
          formatVulcanMemorySearchText({ hitsByQuery: response.hitsByQuery }),
          response,
        );
      } catch (error) {
        params.api.logger.warn?.(`vulcan-memory: grouped search failed: ${String(error)}`);
        const unavailable = mapMemoryTransportError(params, error);
        if (unavailable) {
          return unavailable;
        }
        return errorToolResult(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

// createVulcanMemoryGetTool creates the primary Vulcan-native grouped follow-up reader exposed to OpenClaw models.
// createVulcanMemoryGetTool 创建对 OpenClaw 模型暴露的主 Vulcan 原生分组后续读取工具。
export function createVulcanMemoryGetTool(params: CreateMemoryToolParams): AnyAgentTool | null {
  if (!params.config.enabled || !params.config.memory.enabled) {
    return null;
  }
  if (!shouldExposeVulcanToolSurface({
    runtimeConfig: resolveToolRuntimeConfig(params.ctx),
    agentId: params.ctx.agentId,
    surface: "memory-native",
  })) {
    return null;
  }
  return {
    name: "vulcan_memory_get",
    label: "Vulcan Memory Get",
    description: resolveGeneratedDescription(
      COMPAT_MEMORY_GET_TOOL,
      "Primary Vulcan-native follow-up reader for non-zero source_turn_id values returned by `vulcan_memory_search`. Use this when grouped search results point at one or more real source turns and you need structured turn details instead of pseudo-document reads.",
    ),
    parameters: resolveGeneratedSchema(COMPAT_MEMORY_GET_TOOL, CompatMemoryGetSchema),
    async execute(_toolCallId, rawParams) {
      const input = readCompatGetParams(rawParams);
      if (!input) {
        return errorToolResult("turnIds must be a non-empty string array.");
      }
      const unavailable = failFastWhenHostDisconnected(params);
      if (unavailable) {
        return unavailable;
      }
      try {
        const client = createVulcanHostClient(params.config);
        const turns = await loadVulcanTurnDetails({
          client,
          context: buildToolHostContext(params.ctx, params.config),
          turnIds: input.turnIds,
        });
        return textToolResult(formatVulcanTurnDetailsText(turns), { turns });
      } catch (error) {
        params.api.logger.warn?.(`vulcan-memory: grouped get failed: ${String(error)}`);
        const unavailable = mapMemoryTransportError(params, error);
        if (unavailable) {
          return unavailable;
        }
        return errorToolResult(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

// createVulcanMemoryDeleteTool creates the primary Vulcan-native explicit memory delete tool exposed to OpenClaw models.
// createVulcanMemoryDeleteTool 创建对 OpenClaw 模型暴露的主 Vulcan 原生明确删记忆工具。
export function createVulcanMemoryDeleteTool(params: CreateMemoryToolParams): AnyAgentTool | null {
  if (!params.config.enabled || !params.config.memory.enabled) {
    return null;
  }
  if (!shouldExposeVulcanToolSurface({
    runtimeConfig: resolveToolRuntimeConfig(params.ctx),
    agentId: params.ctx.agentId,
    surface: "memory-native",
  })) {
    return null;
  }
  return {
    name: "vmm_memory_delete",
    label: "VMM Memory Delete",
    description: resolveGeneratedDescription(
      COMPAT_MEMORY_DELETE_TOOL,
      "Delete explicit durable Vulcan memories only after the user clearly asks to delete, remove, or replace specific remembered information. This tool requires exact memory_id values from vulcan_memory_search or PreCheck VMM_ID markers; never delete by turn_id/source_turn_id, never infer ids from text, and never use it for broad cleanup.",
    ),
    parameters: resolveGeneratedSchema(COMPAT_MEMORY_DELETE_TOOL, CompatMemoryDeleteSchema),
    async execute(_toolCallId, rawParams) {
      const input = readCompatDeleteParams(rawParams);
      if (!input) {
        return errorToolResult("memoryIds must be non-empty decimal memory_id strings and reason must be non-empty.");
      }
      const unavailable = failFastWhenHostDisconnected(params);
      if (unavailable) {
        return unavailable;
      }
      try {
        const client = createVulcanHostClient(params.config);
        const response = await deleteVulcanMemoryEntries({
          client,
          config: params.config,
          context: buildToolHostContext(params.ctx, params.config),
          memoryIds: input.memoryIds,
          reason: input.reason,
        });
        if ("error" in response) {
          return errorToolResult(response.error);
        }
        return textToolResult(
          [
            `deleted_memory_ids: ${response.deletedMemoryIds.join(", ") || "none"}`,
            `not_found_memory_ids: ${response.notFoundMemoryIds.join(", ") || "none"}`,
            `deleted_vector_rows: ${response.deletedVectorRows}`,
            response.traceId ? `trace_id: ${response.traceId}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
          response,
        );
      } catch (error) {
        params.api.logger.warn?.(`vulcan-memory: explicit delete failed: ${String(error)}`);
        const unavailable = mapMemoryTransportError(params, error);
        if (unavailable) {
          return unavailable;
        }
        return errorToolResult(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

// readCanonicalSearchParams validates the canonical memory_search input.
// readCanonicalSearchParams 校验 canonical memory_search 输入。
function readCanonicalSearchParams(
  value: unknown,
): { query: string; maxResults?: number | undefined; minScore?: number | undefined; corpus?: string | undefined } | null {
  const record = asRecord(value);
  const query = typeof record.query === "string" ? record.query.trim() : "";
  if (!query) {
    return null;
  }
  return {
    query,
    ...(typeof record.maxResults === "number" && Number.isFinite(record.maxResults)
      ? { maxResults: record.maxResults }
      : {}),
    ...(typeof record.minScore === "number" && Number.isFinite(record.minScore)
      ? { minScore: record.minScore }
      : {}),
    ...(typeof record.corpus === "string" && record.corpus.trim() ? { corpus: record.corpus.trim() } : {}),
  };
}

// readCanonicalGetParams validates the canonical memory_get input.
// readCanonicalGetParams 校验 canonical memory_get 输入。
function readCanonicalGetParams(
  value: unknown,
): { path: string; from?: number | undefined; lines?: number | undefined; corpus?: string | undefined } | null {
  const record = asRecord(value);
  const path = typeof record.path === "string" ? record.path.trim() : "";
  if (!path) {
    return null;
  }
  return {
    path,
    ...(typeof record.from === "number" && Number.isFinite(record.from) ? { from: record.from } : {}),
    ...(typeof record.lines === "number" && Number.isFinite(record.lines) ? { lines: record.lines } : {}),
    ...(typeof record.corpus === "string" && record.corpus.trim() ? { corpus: record.corpus.trim() } : {}),
  };
}

// readCompatSearchParams validates the grouped compatibility search input and applies the configured topK fallback.
// readCompatSearchParams 校验分组兼容搜索输入，并应用配置的 topK 回退值。
function readCompatSearchParams(
  value: unknown,
  defaultTopK: number,
): { queries: string[]; topK: number } | null {
  const record = asRecord(value);
  const queries = Array.isArray(record.queries)
    ? record.queries.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
    : [];
  if (queries.length === 0) {
    return null;
  }
  return {
    queries,
    topK:
      typeof record.topK === "number" && Number.isFinite(record.topK)
        ? Math.max(1, Math.floor(record.topK))
        : Math.max(1, Math.floor(defaultTopK)),
  };
}

// readCompatGetParams validates the grouped compatibility turn-detail input.
// readCompatGetParams 校验分组兼容 turn 详情输入。
function readCompatGetParams(value: unknown): { turnIds: string[] } | null {
  const record = asRecord(value);
  const turnIds = Array.isArray(record.turnIds)
    ? record.turnIds.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
    : [];
  if (turnIds.length === 0) {
    return null;
  }
  return { turnIds };
}

// readCompatDeleteParams validates explicit VMM memory delete input.
// readCompatDeleteParams 校验明确 VMM 记忆删除输入。
function readCompatDeleteParams(value: unknown): { memoryIds: string[]; reason: string } | null {
  const record = asRecord(value);
  const memoryIds = Array.isArray(record.memoryIds)
    ? record.memoryIds
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter((entry) => /^[1-9][0-9]*$/.test(entry))
    : [];
  const reason = typeof record.reason === "string" ? record.reason.trim() : "";
  return memoryIds.length > 0 && reason ? { memoryIds, reason } : null;
}

// resolveCanonicalSources narrows the canonical corpus selector to the VMM-backed source groups the native manager can serve.
// resolveCanonicalSources 把 canonical corpus 选择器收窄成原生 manager 可服务的 VMM 来源分组。
function resolveCanonicalSources(corpus: string | undefined): Array<"memory" | "sessions"> | undefined {
  if (corpus === "memory") {
    return ["memory"];
  }
  if (corpus === "sessions") {
    return ["sessions"];
  }
  return undefined;
}

// asRecord safely narrows unknown tool parameters into an object.
// asRecord 将未知工具参数安全收窄为对象。
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// resolveToolRuntimeConfig prefers the eager runtime config and falls back to the lazy getter used by some OpenClaw tool paths.
// resolveToolRuntimeConfig 优先使用即时 runtime config，并回退到部分 OpenClaw 工具路径提供的惰性 getter。
function resolveToolRuntimeConfig(ctx: OpenClawPluginToolContext): unknown {
  return ctx.runtimeConfig ?? ctx.getRuntimeConfig?.();
}

// findGeneratedDescriptor locates the canonical VMM descriptor synchronized from vulcan-host.
// findGeneratedDescriptor 定位从 vulcan-host 同步来的标准 VMM descriptor。
function findGeneratedDescriptor(toolName: string): VulcanToolDescriptor | undefined {
  return GENERATED_VMM_TOOLS.find((descriptor) => descriptor.name === toolName);
}

// resolveGeneratedDescription uses host-owned descriptions when sync has already run.
// resolveGeneratedDescription 在已执行同步时使用宿主拥有的描述。
export function resolveGeneratedDescription(toolName: string, fallback: string): string {
  return findGeneratedDescriptor(toolName)?.description || fallback;
}

// resolveGeneratedSchema uses host-owned JSON schema when sync has already run.
// resolveGeneratedSchema 在已执行同步时使用宿主拥有的 JSON schema。
export function resolveGeneratedSchema(toolName: string, fallback: Record<string, unknown>): Record<string, unknown> {
  return findGeneratedDescriptor(toolName)?.inputSchema || fallback;
}
