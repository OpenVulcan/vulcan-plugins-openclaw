// Native memory-manager bridge for routing OpenClaw memory flows into Vulcan Memory Mesh.
// 本文件负责把 OpenClaw 原生记忆管理器桥接到 Vulcan Memory Mesh。

import {
  buildVulcanCapabilityUnavailableMessage,
  ensureVulcanHostReconnectScheduled,
  isVulcanHostConnectionUnavailable,
  isVulcanHostTransportError,
  markVulcanHostTransportFailure,
  type ResolvedVulcanConfig,
  type VulcanHostClient,
  type VulcanHostContext,
  type VulcanVmmDeleteMemoriesResponse,
  type VulcanVmmMemorySearchHit,
  type VulcanVmmTurnDetailEntry,
} from "@vulcan-plugins-openclaw/shared";
import { resolveVulcanMemoryScope, type VulcanResolvedMemoryScope } from "./vmm-scope.js";

// MemorySource matches the native OpenClaw memory source categories expected by memory tooling.
// MemorySource 对齐 OpenClaw 记忆工具期望使用的原生记忆来源分类。
export type MemorySource = "memory" | "sessions";

// MemorySearchRuntimeDebug is the minimal debug shape expected by OpenClaw memory tooling.
// MemorySearchRuntimeDebug 是 OpenClaw 记忆工具期望使用的最小调试结构。
export interface MemorySearchRuntimeDebug {
  backend: "builtin" | "qmd";
  configuredMode?: string | undefined;
  effectiveMode?: string | undefined;
  fallback?: string | undefined;
}

// MemorySearchResult is the native search-hit structure consumed by OpenClaw memory tools and citations.
// MemorySearchResult 是 OpenClaw 记忆工具与引用系统消费的原生检索命中结构。
export interface MemorySearchResult {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  vectorScore?: number | undefined;
  textScore?: number | undefined;
  snippet: string;
  source: MemorySource;
  citation?: string | undefined;
}

// MemoryReadResult is the native exact-read response shape expected by OpenClaw memory_get flows.
// MemoryReadResult 是 OpenClaw memory_get 流程期望使用的原生精确读取响应结构。
export interface MemoryReadResult {
  text: string;
  path: string;
  truncated?: boolean | undefined;
  from?: number | undefined;
  lines?: number | undefined;
  nextFrom?: number | undefined;
}

// MemoryEmbeddingProbeResult mirrors the native embedding-availability probe shape.
// MemoryEmbeddingProbeResult 对齐原生 embedding 可用性探测结构。
export interface MemoryEmbeddingProbeResult {
  ok: boolean;
  error?: string | undefined;
  checked?: boolean | undefined;
  cached?: boolean | undefined;
  checkedAtMs?: number | undefined;
  cacheExpiresAtMs?: number | undefined;
}

// MemoryProviderStatus is the synchronous status snapshot surfaced by OpenClaw status/doctor flows.
// MemoryProviderStatus 是 OpenClaw status/doctor 流程读取的同步状态快照。
export interface MemoryProviderStatus {
  backend: "builtin" | "qmd";
  provider: string;
  model?: string | undefined;
  workspaceDir?: string | undefined;
  sources?: MemorySource[] | undefined;
  vector?: {
    enabled: boolean;
    available?: boolean | undefined;
    semanticAvailable?: boolean | undefined;
    storeAvailable?: boolean | undefined;
  };
  custom?: Record<string, unknown> | undefined;
}

// VulcanMemorySearchManager is the native manager contract that OpenClaw runtime and tools can consume directly.
// VulcanMemorySearchManager 是 OpenClaw 运行时与工具可直接消费的原生 manager 契约。
export interface VulcanMemorySearchManager {
  search(
    query: string,
    opts?: {
      maxResults?: number | undefined;
      minScore?: number | undefined;
      sessionKey?: string | undefined;
      qmdSearchModeOverride?: "query" | "search" | "vsearch" | undefined;
      onDebug?: ((debug: MemorySearchRuntimeDebug) => void) | undefined;
      sources?: MemorySource[] | undefined;
    },
  ): Promise<MemorySearchResult[]>;
  readFile(params: { relPath: string; from?: number | undefined; lines?: number | undefined }): Promise<MemoryReadResult>;
  status(): MemoryProviderStatus;
  sync?(params?: {
    reason?: string | undefined;
    force?: boolean | undefined;
    sessionFiles?: string[] | undefined;
    progress?: ((update: { completed: number; total: number; label?: string | undefined }) => void) | undefined;
  }): Promise<void>;
  getCachedEmbeddingAvailability?(): MemoryEmbeddingProbeResult | null;
  probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult>;
  probeVectorStoreAvailability?(): Promise<boolean>;
  probeVectorAvailability(): Promise<boolean>;
  close?(): Promise<void>;
}

// CachedMemoryDocument keeps one pseudo-file body that can later be returned through memory_get style reads.
// CachedMemoryDocument 保存一份伪文件正文，供后续 memory_get 风格读取时返回。
interface CachedMemoryDocument {
  path: string;
  text: string;
}

// MANAGER_CACHE stores native manager instances keyed by stable OpenClaw/Vulcan identity hints.
// MANAGER_CACHE 按稳定的 OpenClaw/Vulcan 身份提示缓存原生 manager 实例。
const MANAGER_CACHE = new Map<string, NativeVulcanMemoryManager>();

// MANAGER_UNAVAILABLE_MESSAGE keeps one stable native-memory failure text while vulcan-host is disconnected and reconnecting.
// MANAGER_UNAVAILABLE_MESSAGE 为 vulcan-host 断线重连期间保留一条稳定的原生记忆失败提示文本。
const MANAGER_UNAVAILABLE_MESSAGE = buildVulcanCapabilityUnavailableMessage("memory");

// HOST_DISCONNECTED_REASON tags provider-status degradation caused by host transport disconnects instead of binding or VMM business failures.
// HOST_DISCONNECTED_REASON 标记由宿主传输断线引起的 provider-status 降级，而不是绑定或 VMM 业务失败。
const HOST_DISCONNECTED_REASON = "vulcan-host-disconnected";

// getOrCreateVulcanMemoryManager returns one cached manager for the provided base host context.
// getOrCreateVulcanMemoryManager 为给定基础宿主上下文返回一个缓存的 manager。
export function getOrCreateVulcanMemoryManager(params: {
  client: VulcanHostClient;
  config: ResolvedVulcanConfig;
  baseContext: VulcanHostContext;
}): VulcanMemorySearchManager {
  const key = buildManagerCacheKey(params.baseContext);
  const cached = MANAGER_CACHE.get(key);
  if (cached) {
    return cached;
  }
  const created = new NativeVulcanMemoryManager(params.client, params.config, params.baseContext);
  MANAGER_CACHE.set(key, created);
  return created;
}

// closeAllVulcanMemoryManagers closes and removes every cached native manager instance.
// closeAllVulcanMemoryManagers 关闭并移除全部缓存的原生 manager 实例。
export async function closeAllVulcanMemoryManagers(): Promise<void> {
  const managers = [...MANAGER_CACHE.values()];
  MANAGER_CACHE.clear();
  await Promise.all(managers.map(async (manager) => await manager.close?.()));
}

// searchVulcanMemoryEntries runs one grouped VMM memory search with deterministic scope resolution.
// searchVulcanMemoryEntries 使用确定性作用域解析执行一次分组 VMM 记忆检索。
export async function searchVulcanMemoryEntries(params: {
  client: VulcanHostClient;
  config: ResolvedVulcanConfig;
  context: VulcanHostContext;
  queries: string[];
  topK: number;
}): Promise<
  | {
      scope: VulcanResolvedMemoryScope;
      hitsByQuery: Array<{ query: string; hits: VulcanVmmMemorySearchHit[] }>;
    }
  | { error: string }
> {
  const resolved = await resolveVulcanMemoryScope({
    client: params.client,
    config: params.config,
    context: params.context,
    requireSession: false,
    purpose: "search",
  });
  if (!("scope" in resolved)) {
    return { error: resolved.error };
  }
  const response = await params.client.searchVmmMemories({
    context: params.context,
    userId: resolved.scope.user.userId,
    projectId: resolved.scope.project.projectId,
    queries: params.queries,
    topK: Math.max(1, params.topK),
  });
  return {
    scope: resolved.scope,
    hitsByQuery: response.results.map((group) => ({ query: group.query, hits: group.hits })),
  };
}

// deleteVulcanMemoryEntries deletes exact durable memory ids after resolving the current VMM scope.
// deleteVulcanMemoryEntries 会在解析当前 VMM 范围后删除精确的长期 memory id。
export async function deleteVulcanMemoryEntries(params: {
  client: VulcanHostClient;
  config: ResolvedVulcanConfig;
  context: VulcanHostContext;
  memoryIds: string[];
  reason: string;
}): Promise<VulcanVmmDeleteMemoriesResponse | { error: string }> {
  const resolved = await resolveVulcanMemoryScope({
    client: params.client,
    config: params.config,
    context: params.context,
    requireSession: false,
    purpose: "delete",
  });
  if (!("scope" in resolved)) {
    return { error: resolved.error };
  }
  return params.client.deleteVmmMemories({
    context: params.context,
    userId: resolved.scope.user.userId,
    projectId: resolved.scope.project.projectId,
    memoryIds: params.memoryIds,
    reason: params.reason,
  });
}

// loadVulcanTurnDetails loads source-turn details directly from VMM and returns them in stable order.
// loadVulcanTurnDetails 直接从 VMM 加载 source turn 详情，并按稳定顺序返回。
export async function loadVulcanTurnDetails(params: {
  client: VulcanHostClient;
  context: VulcanHostContext;
  turnIds: string[];
}): Promise<VulcanVmmTurnDetailEntry[]> {
  const response = await params.client.getVmmTurnDetails({
    context: params.context,
    turnIds: params.turnIds,
  });
  return response.turns;
}

// formatVulcanMemorySearchText renders grouped VMM hits into one AI-readable textual summary.
// formatVulcanMemorySearchText 把分组 VMM 命中渲染成 AI 可读的文本摘要。
export function formatVulcanMemorySearchText(params: {
  hitsByQuery: Array<{ query: string; hits: VulcanVmmMemorySearchHit[] }>;
}): string {
  const blocks = params.hitsByQuery.map((group) => {
    if (group.hits.length === 0) {
      return [`## Query`, group.query, "", "No memory hits."].join("\n");
    }
    const items = group.hits.map((hit, index) =>
      [
        `${index + 1}. ${hit.abstract.trim() || `Memory ${hit.memoryId}`}`,
        `   - memory_id: ${hit.memoryId}`,
        `   - source_turn_id: ${hit.sourceTurnId || "0"}`,
        `   - category: ${hit.category || "unknown"}`,
        `   - created: ${hit.createdDatetime || "unknown"}`,
        hit.detailsPreview.trim() ? `   - preview: ${compactInline(hit.detailsPreview, 320)}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    return [`## Query`, group.query, "", ...items].join("\n");
  });
  return blocks.join("\n\n");
}

// formatVulcanTurnDetailsText renders structured turn details into one readable multi-section text block.
// formatVulcanTurnDetailsText 把结构化 turn 详情渲染成一个可读的多段落文本块。
export function formatVulcanTurnDetailsText(turns: VulcanVmmTurnDetailEntry[]): string {
  if (turns.length === 0) {
    return "No turn details were returned.";
  }
  return turns
    .map((turn) =>
      [
        `## Turn ${turn.turnId}`,
        turn.userQuestion.trim() ? `### User\n${turn.userQuestion.trim()}` : "",
        turn.timeline.length > 0
          ? `### Timeline\n${turn.timeline.map((item) => `- ${item.type}: ${item.content}`).join("\n")}`
          : "",
        turn.assistantAnswer.trim() ? `### Assistant\n${turn.assistantAnswer.trim()}` : "",
        turn.detail.trim() ? `### Detail\n${turn.detail.trim()}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    )
    .join("\n\n");
}

// NativeVulcanMemoryManager adapts VMM memory search primitives into the OpenClaw native manager contract.
// NativeVulcanMemoryManager 把 VMM 记忆检索原语适配成 OpenClaw 原生 manager 契约。
class NativeVulcanMemoryManager implements VulcanMemorySearchManager {
  private readonly cachedDocuments = new Map<string, CachedMemoryDocument>();

  private lastEmbeddingProbe: MemoryEmbeddingProbeResult | null = null;

  private lastStatus: MemoryProviderStatus;

  // The constructor stores base host identity so later operations can merge in per-call session hints.
  // 构造函数保存基础宿主身份，让后续操作能合并每次调用的会话提示。
  constructor(
    private readonly client: VulcanHostClient,
    private readonly config: ResolvedVulcanConfig,
    private readonly baseContext: VulcanHostContext,
  ) {
    this.lastStatus = buildBaseStatus(config, baseContext);
  }

  // search turns one VMM grouped search into native OpenClaw memory_search results.
  // search 把一次 VMM 分组检索转换成原生 OpenClaw memory_search 结果。
  async search(
    query: string,
    opts?: {
      maxResults?: number | undefined;
      minScore?: number | undefined;
      sessionKey?: string | undefined;
      qmdSearchModeOverride?: "query" | "search" | "vsearch" | undefined;
      onDebug?: ((debug: MemorySearchRuntimeDebug) => void) | undefined;
      sources?: MemorySource[] | undefined;
    },
  ): Promise<MemorySearchResult[]> {
    const context = this.buildOperationContext({ sessionKey: opts?.sessionKey });
    if (this.failFastWhenHostDisconnected()) {
      opts?.onDebug?.({
        backend: "builtin",
        configuredMode: "vulcan-vmm",
        effectiveMode: "vulcan-vmm",
        fallback: "host-disconnected",
      });
      return [];
    }
    try {
      const resolved = await resolveVulcanMemoryScope({
        client: this.client,
        config: this.config,
        context,
        requireSession: false,
        purpose: "manager",
      });
      if (!("scope" in resolved)) {
        this.lastEmbeddingProbe = buildProbe(false, resolved.error);
        this.lastStatus = buildFailureStatus(this.config, this.baseContext, resolved.error, resolved.degradedReasons);
        throw new Error(resolved.error);
      }
      this.lastStatus = buildScopedStatus(this.config, this.baseContext, resolved.scope);
      opts?.onDebug?.({
        backend: "builtin",
        configuredMode: "vulcan-vmm",
        effectiveMode: "vulcan-vmm",
        fallback: resolved.scope.identityReady ? undefined : "degraded-host-identity",
      });

      const response = await this.client.searchVmmMemories({
        context,
        userId: resolved.scope.user.userId,
        projectId: resolved.scope.project.projectId,
        queries: [query],
        topK: Math.max(1, Math.floor(opts?.maxResults ?? 5)),
      });
      this.lastEmbeddingProbe = buildProbe(true);
      const hits = response.results[0]?.hits ?? [];
      const sourceFilter = new Set(opts?.sources ?? ["memory", "sessions"]);
      return hits
        .map((hit, index) => buildMemorySearchResult(hit, index, hits.length))
        .filter((entry) => sourceFilter.has(entry.source))
        .filter((entry) => opts?.minScore === undefined || entry.score >= opts.minScore)
        .map((entry) => {
          this.cachedDocuments.set(entry.path, {
            path: entry.path,
            text: buildCachedDocumentText(entry.path, hits.find((hit) => pathForHit(hit) === entry.path)),
          });
          return entry;
        });
    } catch (error) {
      if (this.handleTransportFailure(error)) {
        opts?.onDebug?.({
          backend: "builtin",
          configuredMode: "vulcan-vmm",
          effectiveMode: "vulcan-vmm",
          fallback: "host-disconnected",
        });
        return [];
      }
      throw error;
    }
  }

  // readFile returns an exact pseudo-document excerpt for one VMM-backed memory or source turn.
  // readFile 为一条 VMM 支撑的记忆或 source turn 返回精确的伪文档摘录。
  async readFile(params: { relPath: string; from?: number | undefined; lines?: number | undefined }): Promise<MemoryReadResult> {
    const normalizedPath = params.relPath.trim();
    if (!normalizedPath) {
      throw new Error("memory_get path is required.");
    }
    const turnId = extractTurnId(normalizedPath);
    if (turnId) {
      if (this.failFastWhenHostDisconnected()) {
        throw new Error(MANAGER_UNAVAILABLE_MESSAGE);
      }
      try {
        const turns = await this.client.getVmmTurnDetails({
          context: this.baseContext,
          turnIds: [turnId],
        });
        const detail = turns.turns[0];
        if (!detail) {
          throw new Error(`No VMM turn details were found for ${turnId}.`);
        }
        const text = buildTurnDetailDocument(detail);
        this.cachedDocuments.set(normalizedPath, { path: normalizedPath, text });
        return pageDocument(normalizedPath, text, params.from, params.lines);
      } catch (error) {
        if (this.handleTransportFailure(error)) {
          throw new Error(MANAGER_UNAVAILABLE_MESSAGE);
        }
        throw error;
      }
    }
    const cached = this.cachedDocuments.get(normalizedPath);
    if (!cached) {
      throw new Error(`No cached Vulcan memory document is available for ${normalizedPath}.`);
    }
    return pageDocument(normalizedPath, cached.text, params.from, params.lines);
  }

  // status returns the latest synchronous native status snapshot for status/doctor style callers.
  // status 返回最新的同步原生状态快照，供 status/doctor 一类调用方读取。
  status(): MemoryProviderStatus {
    return this.lastStatus;
  }

  // sync is a no-op because VMM is already the durable external source of truth.
  // sync 是空操作，因为 VMM 已经是持久化的外部事实源。
  async sync(): Promise<void> {
    return undefined;
  }

  // getCachedEmbeddingAvailability returns the last successful or failed vector/embedding probe result.
  // getCachedEmbeddingAvailability 返回最近一次成功或失败的向量/embedding 探测结果。
  getCachedEmbeddingAvailability(): MemoryEmbeddingProbeResult | null {
    return this.lastEmbeddingProbe;
  }

  // probeEmbeddingAvailability checks whether VMM can currently resolve identity and serve semantic recall.
  // probeEmbeddingAvailability 检查 VMM 当前是否能解析身份并提供语义召回。
  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    if (this.failFastWhenHostDisconnected()) {
      return this.lastEmbeddingProbe ?? buildProbe(false, MANAGER_UNAVAILABLE_MESSAGE);
    }
    try {
      const resolved = await resolveVulcanMemoryScope({
        client: this.client,
        config: this.config,
        context: this.baseContext,
        requireSession: false,
        purpose: "status",
      });
      if ("scope" in resolved) {
        this.lastStatus = buildScopedStatus(this.config, this.baseContext, resolved.scope);
        this.lastEmbeddingProbe = buildProbe(true);
      } else {
        this.lastEmbeddingProbe = buildProbe(false, resolved.error);
        this.lastStatus = buildFailureStatus(
          this.config,
          this.baseContext,
          resolved.error,
          resolved.degradedReasons,
        );
      }
      return this.lastEmbeddingProbe;
    } catch (error) {
      if (this.handleTransportFailure(error)) {
        return this.lastEmbeddingProbe ?? buildProbe(false, MANAGER_UNAVAILABLE_MESSAGE);
      }
      throw error;
    }
  }

  // probeVectorStoreAvailability reports whether the VMM search backend is reachable.
  // probeVectorStoreAvailability 报告 VMM 检索后端是否可达。
  async probeVectorStoreAvailability(): Promise<boolean> {
    const probe = await this.probeEmbeddingAvailability();
    return probe.ok;
  }

  // probeVectorAvailability mirrors vector-store reachability because VMM already hides internal storage details.
  // probeVectorAvailability 镜像向量存储可达性，因为 VMM 已经隐藏了内部存储细节。
  async probeVectorAvailability(): Promise<boolean> {
    return await this.probeVectorStoreAvailability();
  }

  // close clears cached pseudo-documents so future reads must refresh from the source system.
  // close 清理缓存的伪文档，让后续读取必须重新从源系统刷新。
  async close(): Promise<void> {
    this.cachedDocuments.clear();
  }

  // buildOperationContext merges one per-call session hint into the stored base host context.
  // buildOperationContext 把每次调用的会话提示合并到保存的基础宿主上下文里。
  private buildOperationContext(overrides: { sessionKey?: string | undefined }): VulcanHostContext {
    return {
      ...this.baseContext,
      sessionKey: overrides.sessionKey ?? this.baseContext.sessionKey,
      sessionId: this.baseContext.sessionId ?? overrides.sessionKey,
    };
  }

  // failFastWhenHostDisconnected downgrades provider status immediately when shared host state is already marked disconnected.
  // failFastWhenHostDisconnected 会在共享 host 状态已被标记为断线时立刻降级 provider 状态。
  private failFastWhenHostDisconnected(): boolean {
    if (!isVulcanHostConnectionUnavailable(this.config)) {
      return false;
    }
    ensureVulcanHostReconnectScheduled(this.config);
    this.markUnavailableStatus(MANAGER_UNAVAILABLE_MESSAGE, [HOST_DISCONNECTED_REASON]);
    return true;
  }

  // handleTransportFailure records one transport outage, updates native provider status, and signals whether callers should degrade instead of rethrowing.
  // handleTransportFailure 记录一次传输故障、更新原生 provider 状态，并告知调用方是否应降级而非继续抛错。
  private handleTransportFailure(error: unknown): boolean {
    if (!isVulcanHostTransportError(error)) {
      return false;
    }
    markVulcanHostTransportFailure(this.config, error);
    this.markUnavailableStatus(MANAGER_UNAVAILABLE_MESSAGE, [HOST_DISCONNECTED_REASON]);
    return true;
  }

  // markUnavailableStatus keeps the manager-side provider status aligned with the shared reconnect state during outages.
  // markUnavailableStatus 让 manager 侧的 provider 状态在故障期间与共享重连状态保持一致。
  private markUnavailableStatus(error: string, degradedReasons: string[]): void {
    this.lastEmbeddingProbe = buildProbe(false, error);
    this.lastStatus = buildFailureStatus(this.config, this.baseContext, error, degradedReasons);
  }
}

// buildMemorySearchResult maps one VMM hit into the native OpenClaw search-result shape.
// buildMemorySearchResult 把一条 VMM 命中映射成 OpenClaw 原生搜索结果结构。
function buildMemorySearchResult(
  hit: VulcanVmmMemorySearchHit,
  index: number,
  total: number,
): MemorySearchResult {
  const path = pathForHit(hit);
  const snippet = buildHitSnippet(hit);
  const score = Math.max(0.05, 1 - index / Math.max(total, 1));
  return {
    path,
    startLine: 1,
    endLine: Math.max(1, snippet.split(/\r?\n/gu).length),
    score,
    snippet,
    source: hit.sourceTurnId && hit.sourceTurnId !== "0" ? "sessions" : "memory",
  };
}

// pathForHit turns one VMM hit into a stable pseudo-file path used by citations and reads.
// pathForHit 把一条 VMM 命中转换成稳定的伪文件路径，供引用与读取使用。
function pathForHit(hit: VulcanVmmMemorySearchHit): string {
  return hit.sourceTurnId && hit.sourceTurnId !== "0"
    ? `vulcan-turns/${hit.sourceTurnId}.md`
    : `vulcan-memories/${hit.memoryId}.md`;
}

// buildHitSnippet composes the abstract, preview, and source-turn hint into one compact memory_search snippet.
// buildHitSnippet 把摘要、预览与 source-turn 提示组合成紧凑的 memory_search 片段。
function buildHitSnippet(hit: VulcanVmmMemorySearchHit): string {
  return [
    hit.abstract.trim(),
    hit.detailsPreview.trim(),
    hit.sourceTurnId && hit.sourceTurnId !== "0" ? `Source turn: ${hit.sourceTurnId}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

// buildCachedDocumentText materializes one pseudo-document body for memory_get style exact reads.
// buildCachedDocumentText 生成一份伪文档正文，供 memory_get 风格的精确读取使用。
function buildCachedDocumentText(pathValue: string, hit: VulcanVmmMemorySearchHit | undefined): string {
  if (!hit) {
    return `# ${pathValue}\n\nNo cached memory body is available.`;
  }
  return [
    `# ${hit.abstract.trim() || pathValue}`,
    hit.detailsPreview.trim(),
    "",
    `memory_id: ${hit.memoryId}`,
    `source_turn_id: ${hit.sourceTurnId || "0"}`,
    `category: ${hit.category || "unknown"}`,
    `created: ${hit.createdDatetime || "unknown"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

// buildTurnDetailDocument renders one VMM turn detail into a pseudo-document body that memory_get can page through.
// buildTurnDetailDocument 把一条 VMM turn 详情渲染成 memory_get 可分页的伪文档正文。
function buildTurnDetailDocument(turn: VulcanVmmTurnDetailEntry): string {
  return [
    `# Turn ${turn.turnId}`,
    turn.userQuestion.trim() ? `## User\n${turn.userQuestion.trim()}` : "",
    turn.timeline.length > 0
      ? `## Timeline\n${turn.timeline.map((item) => `- ${item.type}: ${item.content}`).join("\n")}`
      : "",
    turn.assistantAnswer.trim() ? `## Assistant\n${turn.assistantAnswer.trim()}` : "",
    turn.detail.trim() ? `## Detail\n${turn.detail.trim()}` : "",
    turn.previousTurnIds.length > 0 ? `## Previous\n${turn.previousTurnIds.join(", ")}` : "",
    turn.nextTurnIds.length > 0 ? `## Next\n${turn.nextTurnIds.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

// pageDocument slices one pseudo-document by 1-based line coordinates in the same spirit as memory-core exact reads.
// pageDocument 按 1-based 行坐标裁剪一份伪文档，与 memory-core 的精确读取风格保持一致。
function pageDocument(
  pathValue: string,
  text: string,
  from: number | undefined,
  lines: number | undefined,
): MemoryReadResult {
  const allLines = text.split(/\r?\n/gu);
  const start = Math.max(1, Math.floor(from ?? 1));
  const count = lines && Number.isFinite(lines) && lines > 0 ? Math.floor(lines) : allLines.length;
  const startIndex = Math.min(allLines.length, start - 1);
  const endIndex = Math.min(allLines.length, startIndex + count);
  const paged = allLines.slice(startIndex, endIndex).join("\n");
  const truncated = endIndex < allLines.length;
  return {
    path: pathValue,
    text: paged,
    ...(truncated ? { truncated: true, nextFrom: endIndex + 1 } : {}),
    ...(from !== undefined ? { from: start } : {}),
    ...(lines !== undefined ? { lines: count } : {}),
  };
}

// extractTurnId parses the pseudo-path emitted for source turn backed recall entries.
// extractTurnId 解析为 source turn 支撑的召回条目生成的伪路径。
function extractTurnId(relPath: string): string | undefined {
  const matched = /^vulcan-turns\/(\d+)\.md$/u.exec(relPath.trim());
  return matched?.[1];
}

// buildBaseStatus returns the initial status snapshot before any VMM scope resolution has run.
// buildBaseStatus 返回尚未执行任何 VMM 作用域解析前的初始状态快照。
function buildBaseStatus(config: ResolvedVulcanConfig, context: VulcanHostContext): MemoryProviderStatus {
  return {
    backend: "builtin",
    provider: "vulcan-vmm",
    workspaceDir: context.workspaceDir,
    sources: ["memory", "sessions"],
    vector: { enabled: true, available: true, semanticAvailable: true, storeAvailable: true },
    custom: {
      endpoint: config.endpoint,
      hostKind: context.hostKind,
      state: "pending-scope-resolution",
    },
  };
}

// buildScopedStatus returns the happy-path status snapshot after VMM scope resolution succeeds.
// buildScopedStatus 在 VMM 作用域解析成功后返回正常路径的状态快照。
function buildScopedStatus(
  config: ResolvedVulcanConfig,
  context: VulcanHostContext,
  scope: VulcanResolvedMemoryScope,
): MemoryProviderStatus {
  return {
    backend: "builtin",
    provider: "vulcan-vmm",
    workspaceDir: context.workspaceDir,
    sources: ["memory", "sessions"],
    vector: { enabled: true, available: true, semanticAvailable: true, storeAvailable: true },
    custom: {
      endpoint: config.endpoint,
      hostKind: context.hostKind,
      sessionId: scope.sessionId ?? "",
      workmemId: scope.workmemId ?? "",
      userId: scope.user.userId,
      userName: scope.user.userName,
      defaultUserId: scope.bindings.defaultUserId,
      effectiveUserId: scope.bindings.effectiveUserId,
      projectId: scope.project.projectId,
      projectDisplayPath: scope.project.displayPath,
      defaultProjectId: scope.bindings.defaultProjectId,
      effectiveProjectId: scope.bindings.effectiveProjectId,
      agentProjectId: scope.bindings.agentProjectId ?? "",
      agentId: scope.bindings.agentId ?? "",
      projectBindingSource: scope.bindings.projectSource,
      bindingStorePath: scope.bindings.storePath,
      identityReady: scope.identityReady,
      degradedReasons: scope.degradedReasons,
      vmmStatus: scope.runtime.vmmStatus,
    },
  };
}

// buildFailureStatus returns the degraded native status snapshot after one VMM scope or identity failure.
// buildFailureStatus 在一次 VMM 作用域或身份失败后返回降级状态快照。
function buildFailureStatus(
  config: ResolvedVulcanConfig,
  context: VulcanHostContext,
  error: string,
  degradedReasons: string[],
): MemoryProviderStatus {
  return {
    backend: "builtin",
    provider: "vulcan-vmm",
    workspaceDir: context.workspaceDir,
    sources: ["memory", "sessions"],
    vector: { enabled: true, available: false, semanticAvailable: false, storeAvailable: false },
    custom: {
      endpoint: config.endpoint,
      hostKind: context.hostKind,
      error,
      degradedReasons,
    },
  };
}

// buildProbe returns one cached embedding/vector availability probe result.
// buildProbe 返回一条缓存的 embedding/vector 可用性探测结果。
function buildProbe(ok: boolean, error?: string): MemoryEmbeddingProbeResult {
  return {
    ok,
    ...(error ? { error } : {}),
    checked: true,
    checkedAtMs: Date.now(),
  };
}

// buildManagerCacheKey derives one stable cache key from the strongest available OpenClaw identity hints.
// buildManagerCacheKey 基于当前最强的 OpenClaw 身份提示推导出稳定的缓存键。
function buildManagerCacheKey(context: VulcanHostContext): string {
  return [
    context.hostKind,
    context.agentId ?? "",
    context.workspaceDir ?? "",
    context.sessionId ?? context.sessionKey ?? "",
    context.channelId ?? context.messageChannel ?? "",
  ].join("::");
}

// compactInline keeps formatted search summaries short enough for direct AI inspection tools.
// compactInline 保持格式化搜索摘要足够紧凑，适合直接给 AI 检视工具使用。
function compactInline(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 3)}...`;
}
