// Stable Vulcan host client contract consumed by OpenClaw plugins.
// 本文件定义 OpenClaw 插件消费的稳定 Vulcan host 客户端契约。

import type {
  VulcanHostAdapterRuntime,
  JsonObject,
  JsonValue,
  ResolvedVulcanConfig,
  VulcanHostContext,
  VulcanVmmChatCompactResponse,
  VulcanVmmListProjectsResponse,
  VulcanVmmListUsersResponse,
  VulcanVmmMemorySearchResponse,
  VulcanVmmPostActionResponse,
  VulcanVmmPrecheckResponse,
  VulcanVmmProfileBundleResponse,
  VulcanVmmProfileAdjustResponse,
  VulcanVmmResolvedProject,
  VulcanVmmResolvedUser,
  VulcanStatus,
  VulcanToolCallResponse,
  VulcanToolDescriptor,
  VulcanVmmTurnDetailsResponse,
  VulcanVmmTurnTimelineItem,
  VulcanVmmStatus,
} from "./types.js";

// LuaSkillLifecycleAction describes the supported user-layer LuaSkills management actions.
// LuaSkillLifecycleAction 描述支持的 USER 层 LuaSkills 管理动作。
export type LuaSkillLifecycleAction = "install" | "update" | "uninstall";

// LuaSkillLifecycleRequest carries one lifecycle operation requested by an OpenClaw command.
// LuaSkillLifecycleRequest 承载 OpenClaw 命令请求的一次生命周期操作。
export interface LuaSkillLifecycleRequest {
  action: LuaSkillLifecycleAction;
  source?: string | undefined;
  sourceType?: string | undefined;
  skillId?: string | undefined;
  context: VulcanHostContext;
}

// VulcanHostClient is the protocol-neutral boundary between plugins and vulcan-host.
// VulcanHostClient 是插件与 vulcan-host 之间的协议无关边界。
export interface VulcanHostClient {
  health(context: VulcanHostContext): Promise<VulcanStatus>;
  getVmmStatus(context: VulcanHostContext): Promise<VulcanVmmStatus>;
  buildHostAdapterRuntime(context: VulcanHostContext): Promise<VulcanHostAdapterRuntime>;
  listLuaSkillTools(context: VulcanHostContext): Promise<VulcanToolDescriptor[]>;
  callLuaSkillTool(params: {
    context: VulcanHostContext;
    toolName: string;
    arguments: JsonObject;
  }): Promise<VulcanToolCallResponse>;
  callMcpTool(params: {
    context: VulcanHostContext;
    toolName: string;
    arguments: JsonObject;
  }): Promise<VulcanToolCallResponse>;
  listVmmMemoryTools(context: VulcanHostContext): Promise<VulcanToolDescriptor[]>;
  listVmmBindingTools(context: VulcanHostContext): Promise<VulcanToolDescriptor[]>;
  listVmmProfileTools(context: VulcanHostContext): Promise<VulcanToolDescriptor[]>;
  listVmmProjects(context: VulcanHostContext): Promise<VulcanVmmListProjectsResponse>;
  resolveVmmProject(params: {
    context: VulcanHostContext;
    projectRef: string;
  }): Promise<VulcanVmmResolvedProject>;
  resolveVmmUser(params: {
    context: VulcanHostContext;
    userRef: string;
    confirmCreate?: boolean | undefined;
  }): Promise<VulcanVmmResolvedUser>;
  listVmmUsers(context: VulcanHostContext): Promise<VulcanVmmListUsersResponse>;
  ensureVmmProject(params: {
    context: VulcanHostContext;
    projectPath: string;
    confirmCreate?: boolean | undefined;
  }): Promise<VulcanVmmResolvedProject>;
  searchVmmMemories(params: {
    context: VulcanHostContext;
    userId: string;
    projectId: string;
    queries: string[];
    topK: number;
  }): Promise<VulcanVmmMemorySearchResponse>;
  getVmmTurnDetails(params: {
    context: VulcanHostContext;
    turnIds: string[];
  }): Promise<VulcanVmmTurnDetailsResponse>;
  getVmmProfileBundle(params: {
    context: VulcanHostContext;
    userId: string;
    projectId: string;
    includeExplanation?: boolean | undefined;
  }): Promise<VulcanVmmProfileBundleResponse>;
  applyVmmProfileInstruction(params: {
    context: VulcanHostContext;
    userId: string;
    projectId: string;
    scope: "user" | "project" | "team" | "space";
    instruction: string;
  }): Promise<VulcanVmmProfileAdjustResponse>;
  preCheckVmm(params: {
    context: VulcanHostContext;
    sessionId: string;
    userId: string;
    projectId: string;
    userContent: string;
    recallMode?: "legacy" | "session_compact" | undefined;
  }): Promise<VulcanVmmPrecheckResponse>;
  postActionVmm(params: {
    context: VulcanHostContext;
    sessionId: string;
    userId: string;
    projectId: string;
    userContent: string;
    assistantContent: string;
    timeline: VulcanVmmTurnTimelineItem[];
  }): Promise<VulcanVmmPostActionResponse>;
  chatCompactVmm(params: {
    context: VulcanHostContext;
    sessionId: string;
    userId: string;
    projectId: string;
  }): Promise<VulcanVmmChatCompactResponse>;
  listInstalledLuaSkills(context: VulcanHostContext): Promise<VulcanToolCallResponse>;
  runLuaSkillLifecycle(request: LuaSkillLifecycleRequest): Promise<VulcanToolCallResponse>;
  reloadRuntimeConfigs(context: VulcanHostContext): Promise<VulcanToolCallResponse>;
}

// parseJsonObject parses a JSON object string while returning an empty object for invalid data.
// parseJsonObject 解析 JSON 对象字符串，并在数据非法时返回空对象。
export function parseJsonObject(value: string | undefined): JsonObject {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as JsonValue;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : {};
  } catch {
    return {};
  }
}

// createUnavailableResponse creates a consistent disabled response when vulcan-host cannot be reached.
// createUnavailableResponse 在无法连接 vulcan-host 时创建一致的禁用响应。
export function createUnavailableResponse(message: string): VulcanToolCallResponse {
  return {
    text: message,
    isError: true,
    message,
  };
}

// describeClientTarget formats the runtime target for diagnostics.
// describeClientTarget 为诊断信息格式化运行时目标。
export function describeClientTarget(config: ResolvedVulcanConfig): string {
  return `${config.endpoint}${config.protoPath ? ` proto=${config.protoPath}` : ""}`;
}
