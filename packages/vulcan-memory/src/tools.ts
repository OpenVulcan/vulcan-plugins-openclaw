// Native and compatibility memory tools for bridging OpenClaw memory workflows into Vulcan Memory Mesh.
// 本文件实现把 OpenClaw 记忆工作流桥接到 Vulcan Memory Mesh 的原生与兼容工具。

import {
  buildToolHostContext,
  createVulcanHostClient,
  errorToolResult,
  jsonToolResult,
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
  loadVulcanTurnDetails,
  searchVulcanMemoryEntries,
} from "./manager.js";
import { GENERATED_VMM_TOOLS } from "./generated/vmm-tools.generated.js";

// MemorySearchSchema follows the canonical OpenClaw memory_search tool shape so the model sees a familiar contract.
// MemorySearchSchema 遵循 canonical OpenClaw memory_search 工具形态，让模型看到熟悉契约。
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

// MemoryGetSchema follows the canonical OpenClaw memory_get tool shape while reading Vulcan pseudo-paths.
// MemoryGetSchema 遵循 canonical OpenClaw memory_get 工具形态，同时读取 Vulcan 伪路径。
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

// CompatMemorySearchSchema preserves the grouped VMM search input already used by existing operator prompts.
// CompatMemorySearchSchema 保留现有操作提示词已经使用的分组 VMM 搜索输入。
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

// CompatMemoryGetSchema preserves the source-turn oriented grouped-read input already used by operator prompts.
// CompatMemoryGetSchema 保留现有操作提示词已经使用的 source-turn 分组读取输入。
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

// BACKING_VMM_SEARCH_TOOL is the canonical VMM grouped search descriptor synchronized from vulcan-host.
// BACKING_VMM_SEARCH_TOOL 是从 vulcan-host 同步下来的标准 VMM 分组检索描述符。
const BACKING_VMM_SEARCH_TOOL = "vmm_memory_search";

// BACKING_VMM_GET_TOOL is the canonical VMM turn-detail descriptor synchronized from vulcan-host.
// BACKING_VMM_GET_TOOL 是从 vulcan-host 同步下来的标准 VMM turn 详情描述符。
const BACKING_VMM_GET_TOOL = "vmm_turn_details";

// CreateMemoryToolParams groups dependencies needed to construct OpenClaw memory tools.
// CreateMemoryToolParams 汇总构造 OpenClaw 记忆工具所需的依赖。
interface CreateMemoryToolParams {
  api: OpenClawPluginApi;
  config: ResolvedVulcanConfig;
  ctx: OpenClawPluginToolContext;
}

// createMemorySearchTool creates the canonical OpenClaw memory_search tool backed by VMM.
// createMemorySearchTool 创建由 VMM 支撑的 canonical OpenClaw memory_search 工具。
export function createMemorySearchTool(params: CreateMemoryToolParams): AnyAgentTool | null {
  if (!params.config.enabled || !params.config.memory.enabled) {
    return null;
  }
  return {
    name: "memory_search",
    label: "Memory Search",
    description:
      "Mandatory recall step for Vulcan-backed OpenClaw memory. Search durable VMM memories and session-backed source turns before answering when prior project facts, preferences, requirements, bugs, or decisions may matter.",
    parameters: MemorySearchSchema,
    async execute(_toolCallId, rawParams) {
      const input = readCanonicalSearchParams(rawParams);
      if (!input) {
        return errorToolResult("query must be a non-empty string.");
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

// createMemoryGetTool creates the canonical OpenClaw memory_get tool backed by the native VMM manager.
// createMemoryGetTool 创建由原生 VMM manager 支撑的 canonical OpenClaw memory_get 工具。
export function createMemoryGetTool(params: CreateMemoryToolParams): AnyAgentTool | null {
  if (!params.config.enabled || !params.config.memory.enabled) {
    return null;
  }
  return {
    name: "memory_get",
    label: "Memory Get",
    description:
      "Read one exact Vulcan memory pseudo-document returned by memory_search, including source turn documents and durable memory previews.",
    parameters: MemoryGetSchema,
    async execute(_toolCallId, rawParams) {
      const input = readCanonicalGetParams(rawParams);
      if (!input) {
        return errorToolResult("path must be a non-empty string.");
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

// createVulcanMemorySearchTool creates the grouped VMM compatibility search tool already used by operator prompts.
// createVulcanMemorySearchTool 创建现有操作提示词仍在使用的分组 VMM 兼容搜索工具。
export function createVulcanMemorySearchTool(params: CreateMemoryToolParams): AnyAgentTool | null {
  if (!params.config.enabled || !params.config.memory.enabled) {
    return null;
  }
  return {
    name: "vulcan_memory_search",
    label: "Vulcan Memory Search",
    description: resolveGeneratedDescription(
      BACKING_VMM_SEARCH_TOOL,
      "Search durable Vulcan Memory Mesh memories for the current OpenClaw runtime. Use when you need grouped raw hits, memory ids, category labels, or source_turn_id values for follow-up inspection.",
    ),
    parameters: resolveGeneratedSchema(BACKING_VMM_SEARCH_TOOL, CompatMemorySearchSchema),
    async execute(_toolCallId, rawParams) {
      const input = readCompatSearchParams(rawParams, params.config.memory.recallTopK);
      if (!input) {
        return errorToolResult("queries must be a non-empty string array.");
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
        return errorToolResult(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

// createVulcanMemoryGetTool creates the grouped VMM source-turn detail reader already used by operator prompts.
// createVulcanMemoryGetTool 创建现有操作提示词仍在使用的分组 VMM source-turn 详情读取工具。
export function createVulcanMemoryGetTool(params: CreateMemoryToolParams): AnyAgentTool | null {
  if (!params.config.enabled || !params.config.memory.enabled) {
    return null;
  }
  return {
    name: "vulcan_memory_get",
    label: "Vulcan Memory Get",
    description: resolveGeneratedDescription(
      BACKING_VMM_GET_TOOL,
      "Load structured source turn details for non-zero source_turn_id values returned by vulcan_memory_search.",
    ),
    parameters: resolveGeneratedSchema(BACKING_VMM_GET_TOOL, CompatMemoryGetSchema),
    async execute(_toolCallId, rawParams) {
      const input = readCompatGetParams(rawParams);
      if (!input) {
        return errorToolResult("turnIds must be a non-empty string array.");
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

// findGeneratedDescriptor locates the canonical VMM descriptor synchronized from vulcan-host.
// findGeneratedDescriptor 定位从 vulcan-host 同步来的标准 VMM descriptor。
function findGeneratedDescriptor(toolName: string): VulcanToolDescriptor | undefined {
  return GENERATED_VMM_TOOLS.find((descriptor) => descriptor.name === toolName);
}

// resolveGeneratedDescription uses host-owned descriptions when sync has already run.
// resolveGeneratedDescription 在已执行同步时使用宿主拥有的描述。
function resolveGeneratedDescription(toolName: string, fallback: string): string {
  return findGeneratedDescriptor(toolName)?.description || fallback;
}

// resolveGeneratedSchema uses host-owned JSON schema when sync has already run.
// resolveGeneratedSchema 在已执行同步时使用宿主拥有的 JSON schema。
function resolveGeneratedSchema(toolName: string, fallback: Record<string, unknown>): Record<string, unknown> {
  return findGeneratedDescriptor(toolName)?.inputSchema || fallback;
}
