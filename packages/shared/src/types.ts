// Shared Vulcan/OpenClaw contracts used by tools and memory plugins.
// 本文件定义 tools 与 memory 插件共享的 Vulcan/OpenClaw 契约。

// JsonPrimitive represents scalar JSON values crossing the gRPC boundary.
// JsonPrimitive 表示跨 gRPC 边界传递的 JSON 标量值。
export type JsonPrimitive = string | number | boolean | null;

// JsonValue represents recursive JSON data accepted by Vulcan host calls.
// JsonValue 表示 Vulcan host 调用接受的递归 JSON 数据。
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

// JsonObject represents a JSON object with string keys.
// JsonObject 表示以字符串为键的 JSON 对象。
export type JsonObject = { [key: string]: JsonValue };

// VulcanOpenClawHostBootstrapConfig describes the optional local host autostart policy for no-TUI installs.
// VulcanOpenClawHostBootstrapConfig 描述无 TUI 安装场景下可选的本地 host 自启动策略。
export interface VulcanOpenClawHostBootstrapConfig {
  autoStart?: boolean | undefined;
  command?: string | undefined;
  args?: string[] | undefined;
  cwd?: string | undefined;
  readyTimeoutMs?: number | undefined;
  env?: Record<string, string | number | boolean> | undefined;
}

// ResolvedVulcanHostBootstrapConfig is the normalized host bootstrap policy consumed by runtime services.
// ResolvedVulcanHostBootstrapConfig 是运行时后台服务消费的归一化 host 启动策略。
export interface ResolvedVulcanHostBootstrapConfig {
  autoStart: boolean;
  command: string | undefined;
  args: string[];
  cwd: string | undefined;
  readyTimeoutMs: number;
  env: Record<string, string>;
}

// VulcanOpenClawPluginConfig mirrors the user-facing OpenClaw plugin configuration.
// VulcanOpenClawPluginConfig 映射面向用户的 OpenClaw 插件配置。
export interface VulcanOpenClawPluginConfig {
  endpoint?: string | undefined;
  protoPath?: string | undefined;
  clientName?: string | undefined;
  clientVersion?: string | undefined;
  enabled?: boolean | undefined;
  host?: VulcanOpenClawHostBootstrapConfig | undefined;
  bindings?: {
    defaultUserId?: string | number | undefined;
    defaultProjectId?: string | number | undefined;
    agentProjects?: Record<string, string | number> | undefined;
  };
  tools?: {
    enabled?: boolean | undefined;
    dispatcherEnabled?: boolean | undefined;
    timeoutMs?: number | undefined;
  };
  memory?: {
    enabled?: boolean | undefined;
    autoRecall?: boolean | undefined;
    autoPostAction?: boolean | undefined;
    recallTopK?: number | undefined;
    implicitMemoryTurns?: number | undefined;
    profileRefreshTurns?: number | undefined;
    timeoutMs?: number | undefined;
  };
}

// ResolvedVulcanConfig is the normalized configuration used by runtime code.
// ResolvedVulcanConfig 是运行时代码使用的归一化配置。
export interface ResolvedVulcanConfig {
  endpoint: string;
  protoPath: string | undefined;
  clientName: string;
  clientVersion: string;
  enabled: boolean;
  host: ResolvedVulcanHostBootstrapConfig;
  bindings: {
    defaultUserId: string;
    defaultProjectId: string;
    agentProjects: Record<string, string>;
  };
  tools: {
    enabled: boolean;
    dispatcherEnabled: boolean;
    timeoutMs: number;
  };
  memory: {
    enabled: boolean;
    autoRecall: boolean;
    autoPostAction: boolean;
    recallTopK: number;
    implicitMemoryTurns: number;
    profileRefreshTurns: number;
    timeoutMs: number;
  };
}

// VulcanHostContext carries trusted host identity and session data to vulcan-host.
// VulcanHostContext 承载传递给 vulcan-host 的受信任宿主身份与会话数据。
export interface VulcanHostContext {
  clientName: string;
  clientVersion: string;
  requestId: string;
  hostKind: "openclaw";
  sessionKey?: string | undefined;
  sessionId?: string | undefined;
  agentId?: string | undefined;
  workspaceDir?: string | undefined;
  channelId?: string | undefined;
  channelName?: string | undefined;
  messageChannel?: string | undefined;
  conversationId?: string | undefined;
  rootSessionId?: string | undefined;
  agentAccountId?: string | undefined;
  requesterSenderId?: string | undefined;
  senderId?: string | undefined;
  accountId?: string | undefined;
  messageThreadId?: string | undefined;
  threadParentId?: string | undefined;
  runId?: string | undefined;
  turnId?: string | undefined;
  userMessage?: string | undefined;
}

// VulcanToolDescriptor describes one host-visible tool returned by vulcan-host.
// VulcanToolDescriptor 描述 vulcan-host 返回的一个宿主可见工具。
export interface VulcanToolDescriptor {
  name: string;
  description: string;
  inputSchema: JsonObject;
  // annotations carries host-neutral descriptor hints such as tool_group, execution_mode, registration_surface, visibility, and optional_context.
  // annotations 承载宿主无关的 descriptor 提示，例如 tool_group、execution_mode、registration_surface、visibility 与 optional_context。
  annotations?: JsonObject | undefined;
  skillId?: string | undefined;
  entryName?: string | undefined;
  rootName?: string | undefined;
  skillDir?: string | undefined;
  source?: string | undefined;
}

// VulcanStatus reports whether a vulcan-host feature group is currently usable.
// VulcanStatus 报告 vulcan-host 某组能力当前是否可用。
export interface VulcanStatus {
  ok: boolean;
  message: string;
  version?: string | undefined;
  protocolVersion?: string | undefined;
}

// VulcanVmmStatus reports VMM backend availability through vulcan-host.
// VulcanVmmStatus 通过 vulcan-host 报告 VMM 后端可用性。
export interface VulcanVmmStatus {
  enabled: boolean;
  status: string;
  isError?: boolean | undefined;
  message?: string | undefined;
}

// VulcanHostAdapterRuntime reports the normalized host runtime produced by HostAdapterService.
// VulcanHostAdapterRuntime 报告 HostAdapterService 生成的归一化宿主运行时。
export interface VulcanHostAdapterRuntime {
  hostKind: string;
  sessionId?: string | undefined;
  workmemId?: string | undefined;
  workmemSource?: string | undefined;
  identityReady: boolean;
  degradedReasons: string[];
  isError: boolean;
  message?: string | undefined;
  vmmEnabled: boolean;
  vmmStatus: string;
  runtime?: JsonObject | undefined;
}

// VulcanVmmResolvedProject carries the canonical project identity resolved through VMM gRPC.
// VulcanVmmResolvedProject 承载通过 VMM gRPC 解析出的标准项目身份。
export interface VulcanVmmResolvedProject {
  projectId: string;
  teamName: string;
  spaceName: string;
  projectName: string;
  displayPath: string;
  message: string;
  exists: boolean;
  needsConfirm: boolean;
  createdTeam: boolean;
  createdSpace: boolean;
  createdProject: boolean;
}

// VulcanVmmResolvedUser carries the durable user identity resolved through VMM gRPC.
// VulcanVmmResolvedUser 承载通过 VMM gRPC 解析出的长期用户身份。
export interface VulcanVmmResolvedUser {
  userId: string;
  userName: string;
  message: string;
  created: boolean;
  exists: boolean;
}

// VulcanVmmProjectEntry transports one canonical VMM project row used by admin tooling.
// VulcanVmmProjectEntry 承载供管理工具使用的一条标准 VMM 项目记录。
export interface VulcanVmmProjectEntry {
  projectId: string;
  teamName: string;
  spaceName: string;
  projectName: string;
  displayPath: string;
}

// VulcanVmmUserEntry transports one durable VMM user row used by admin tooling.
// VulcanVmmUserEntry 承载供管理工具使用的一条长期 VMM 用户记录。
export interface VulcanVmmUserEntry {
  userId: string;
  userName: string;
}

// VulcanVmmListProjectsResponse carries the authoritative project list and optional trace metadata.
// VulcanVmmListProjectsResponse 承载权威项目列表与可选 trace 元数据。
export interface VulcanVmmListProjectsResponse {
  projects: VulcanVmmProjectEntry[];
  traceId?: string | undefined;
}

// VulcanVmmListUsersResponse carries the authoritative user list and optional trace metadata.
// VulcanVmmListUsersResponse 承载权威用户列表与可选 trace 元数据。
export interface VulcanVmmListUsersResponse {
  users: VulcanVmmUserEntry[];
  traceId?: string | undefined;
}

// VulcanVmmMemorySearchHit represents one grouped memory-search hit from VMM.
// VulcanVmmMemorySearchHit 表示一条来自 VMM 的分组记忆检索命中。
export interface VulcanVmmMemorySearchHit {
  memoryId: string;
  sourceTurnId: string;
  abstract: string;
  detailsPreview: string;
  category: string;
  createdDatetime: string;
}

// VulcanVmmMemorySearchGroupResult represents one normalized query plus its hit list.
// VulcanVmmMemorySearchGroupResult 表示一条归一化查询及其命中列表。
export interface VulcanVmmMemorySearchGroupResult {
  queryIndex: number;
  query: string;
  hits: VulcanVmmMemorySearchHit[];
}

// VulcanVmmMemorySearchResponse carries grouped memory-search results plus trace metadata.
// VulcanVmmMemorySearchResponse 承载分组记忆检索结果和 trace 元数据。
export interface VulcanVmmMemorySearchResponse {
  results: VulcanVmmMemorySearchGroupResult[];
  traceId?: string | undefined;
}

// VulcanVmmTurnTimelineItem represents one middle timeline node inside a turn detail or postaction payload.
// VulcanVmmTurnTimelineItem 表示 turn 详情或 postaction 载荷中的一条中间时间线节点。
export interface VulcanVmmTurnTimelineItem {
  type: string;
  content: string;
}

// VulcanVmmTurnDetailEntry represents one AI-facing turn detail returned by VMM.
// VulcanVmmTurnDetailEntry 表示 VMM 返回的一条面向 AI 的 turn 详情。
export interface VulcanVmmTurnDetailEntry {
  turnId: string;
  userQuestion: string;
  assistantAnswer: string;
  detail: string;
  previousTurnIds: string[];
  nextTurnIds: string[];
  timeline: VulcanVmmTurnTimelineItem[];
}

// VulcanVmmTurnDetailsResponse carries structured turn details plus trace metadata.
// VulcanVmmTurnDetailsResponse 承载结构化 turn 详情和 trace 元数据。
export interface VulcanVmmTurnDetailsResponse {
  turns: VulcanVmmTurnDetailEntry[];
  traceId?: string | undefined;
}

// VulcanVmmPrecheckContextItem represents one injected context item assembled by VMM precheck.
// VulcanVmmPrecheckContextItem 表示一条由 VMM precheck 组装出的注入上下文项。
export interface VulcanVmmPrecheckContextItem {
  text: string;
  score: number;
  turnId: string;
  hasDialogue: boolean;
  createdDatetime: string;
  memoryId: string;
}

// VulcanVmmDeleteMemoriesResponse carries the audited result of one explicit durable-memory delete batch.
// VulcanVmmDeleteMemoriesResponse 承载一次明确长期记忆删除批次的审计结果。
export interface VulcanVmmDeleteMemoriesResponse {
  deletedMemoryIds: string[];
  notFoundMemoryIds: string[];
  deletedVectorRows: string;
  traceId?: string | undefined;
}

// VulcanVmmPrecheckResponse carries the injection decision for one OpenClaw pre-prompt pass.
// VulcanVmmPrecheckResponse 承载一次 OpenClaw 提示构建前检查的注入决策。
export interface VulcanVmmPrecheckResponse {
  shouldInject: boolean;
  degraded: boolean;
  contextItems: VulcanVmmPrecheckContextItem[];
  traceId?: string | undefined;
}

// VulcanVmmProfileBundleResponse carries the authoritative hidden profile bundle assembled by VMM for one user/project scope.
// VulcanVmmProfileBundleResponse 承载 VMM 为一组 user/project 作用域组装出的权威隐藏画像 bundle。
export interface VulcanVmmProfileBundleResponse {
  combinedText: string;
  explanationText?: string | undefined;
  environmentPriorityText?: string | undefined;
  teamProfile?: string | undefined;
  spaceProfile?: string | undefined;
  projectProfile?: string | undefined;
  userProfile?: string | undefined;
  traceId?: string | undefined;
}

// VulcanVmmProfileNodeEntry represents one durable profile node returned after a manual profile adjustment review.
// VulcanVmmProfileNodeEntry 表示手工画像调整评审后返回的一条长期画像节点。
export interface VulcanVmmProfileNodeEntry {
  profileNodeId: string;
  target: string;
  bindId: string;
  content: string;
  priority: string;
  level: string;
  refreshWeight: number;
  profileDate: string;
  expiresTimestamp: string;
  levelReason: string;
  sourceKind: string;
  sourceId: string;
}

// VulcanVmmRetiredProfileNodeEntry represents one retired profile node plus the explicit manual-review reason.
// VulcanVmmRetiredProfileNodeEntry 表示一条被退役的画像节点以及明确的手工评审原因。
export interface VulcanVmmRetiredProfileNodeEntry {
  profileNodeId: string;
  reason: string;
}

// VulcanVmmProfileAdjustResponse acknowledges one explicit natural-language profile adjustment.
// VulcanVmmProfileAdjustResponse 用于确认一次显式自然语言画像调整请求。
export interface VulcanVmmProfileAdjustResponse {
  instructionId: string;
  acceptedNodes: VulcanVmmProfileNodeEntry[];
  retiredNodes: VulcanVmmRetiredProfileNodeEntry[];
  reviewReason: string;
  traceId?: string | undefined;
}

// VulcanVmmPostActionResponse acknowledges one durable postaction append request.
// VulcanVmmPostActionResponse 用于确认一次持久化 postaction 追加请求。
export interface VulcanVmmPostActionResponse {
  accepted: boolean;
  traceId?: string | undefined;
}

// VulcanVmmChatCompactResponse acknowledges one compaction boundary update request.
// VulcanVmmChatCompactResponse 用于确认一次 compact 边界更新请求。
export interface VulcanVmmChatCompactResponse {
  accepted: boolean;
  updated: boolean;
  compactedTurnId?: string | undefined;
  traceId?: string | undefined;
}

// VulcanToolCallResponse normalizes LuaSkills and MCP tool call responses.
// VulcanToolCallResponse 归一化 LuaSkills 与 MCP 工具调用响应。
export interface VulcanToolCallResponse {
  text: string;
  result?: JsonValue | undefined;
  isError: boolean;
  message?: string | undefined;
}

// VulcanMemorySearchParams is the sidecar memory-search input exposed to OpenClaw.
// VulcanMemorySearchParams 是暴露给 OpenClaw 的旁路记忆搜索输入。
export interface VulcanMemorySearchParams {
  queries: string[];
  topK?: number;
}

// VulcanMemoryGetParams is the sidecar source-turn lookup input exposed to OpenClaw.
// VulcanMemoryGetParams 是暴露给 OpenClaw 的旁路 source turn 读取输入。
export interface VulcanMemoryGetParams {
  turnIds: string[];
}
