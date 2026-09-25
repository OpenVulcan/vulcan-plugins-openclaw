// Dynamic gRPC client for the vulcan-host services used by OpenClaw plugins.
// 本文件实现 OpenClaw 插件使用的 vulcan-host 动态 gRPC 客户端。

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import type {
  VulcanHostAdapterRuntime,
  JsonObject,
  JsonValue,
  ResolvedVulcanConfig,
  VulcanHostContext,
  VulcanVmmChatCompactResponse,
  VulcanVmmDeleteMemoriesResponse,
  VulcanVmmListProjectsResponse,
  VulcanVmmListUsersResponse,
  VulcanVmmMemorySearchGroupResult,
  VulcanVmmMemorySearchResponse,
  VulcanVmmPostActionResponse,
  VulcanVmmPrecheckResponse,
  VulcanVmmProfileAdjustResponse,
  VulcanVmmProfileBundleResponse,
  VulcanVmmProfileNodeEntry,
  VulcanVmmProjectEntry,
  VulcanVmmRetiredProfileNodeEntry,
  VulcanVmmResolvedProject,
  VulcanVmmResolvedUser,
  VulcanStatus,
  VulcanToolCallResponse,
  VulcanToolDescriptor,
  VulcanVmmTurnDetailEntry,
  VulcanVmmTurnDetailsResponse,
  VulcanVmmTurnTimelineItem,
  VulcanVmmUserEntry,
  VulcanVmmStatus,
} from "./types.js";
import {
  ensureVulcanHostReconnectScheduled,
  isVulcanHostConnectionUnavailable,
  markVulcanHostConnected,
  markVulcanHostTransportFailure,
} from "./host-connection-state.js";
import {
  createUnavailableResponse,
  parseJsonObject,
  type LuaSkillLifecycleRequest,
  type VulcanHostClient,
} from "./vulcan-host-client.js";

// GrpcUnaryClient is the dynamic service object shape returned by grpc.loadPackageDefinition.
// GrpcUnaryClient 是 grpc.loadPackageDefinition 返回的动态服务对象形态。
type GrpcUnaryClient = Record<
  string,
  (request: Record<string, unknown>, callback: (error: Error | null, response: unknown) => void) => void
>;

// LoadedGrpcServices groups the vulcan-host gRPC service clients used by this adapter.
// LoadedGrpcServices 汇总该适配器使用的 vulcan-host gRPC 服务客户端。
interface LoadedGrpcServices {
  mcp: GrpcUnaryClient;
  luaSkills: GrpcUnaryClient;
  hostAdapter: GrpcUnaryClient;
  vmm: GrpcUnaryClient;
}

// BUNDLED_MCP_PROTO_PATH locates the protocol contract shipped beside the shared package at runtime.
// BUNDLED_MCP_PROTO_PATH 定位随 shared 包一同发布的运行时协议契约。
const BUNDLED_MCP_PROTO_PATH = fileURLToPath(new URL("../proto/v1/mcp_service.proto", import.meta.url));

// DynamicGrpcVulcanHostClient calls the Rust vulcan-host gRPC surface through proto-loader.
// DynamicGrpcVulcanHostClient 通过 proto-loader 调用 Rust vulcan-host gRPC 能力面。
export class DynamicGrpcVulcanHostClient implements VulcanHostClient {
  private services?: LoadedGrpcServices;

  // The constructor stores resolved config so service loading stays lazy and cheap.
  // 构造函数保存归一化配置，让服务加载保持惰性且低成本。
  constructor(private readonly config: ResolvedVulcanConfig) {}

  // health checks the generic MCP service health endpoint.
  // health 检查通用 MCP 服务健康端点。
  async health(_context: VulcanHostContext): Promise<VulcanStatus> {
    const response = await this.callUnary<Record<string, unknown>>(this.loadServices().mcp, "Healthz", {});
    return {
      ok: response.status === "ok",
      message: String(response.status ?? "unknown"),
      version: readOptionalString(response.version),
      protocolVersion: readOptionalString(response.protocolVersion),
    };
  }

  // getVmmStatus asks HostAdapterService whether VMM-dependent features are enabled.
  // getVmmStatus 通过 HostAdapterService 查询 VMM 相关能力是否启用。
  async getVmmStatus(context: VulcanHostContext): Promise<VulcanVmmStatus> {
    const response = await this.callUnary<Record<string, unknown>>(
      this.loadServices().hostAdapter,
      "GetVmmStatus",
      { context: toHostAdapterClientContext(context) },
    );
    return {
      enabled: response.vmmEnabled === true,
      status: String(response.vmmStatus ?? response.message ?? ""),
      isError: response.isError === true,
      message: readOptionalString(response.message),
    };
  }

  // buildHostAdapterRuntime asks HostAdapterService to normalize session/workmem context for one call.
  // buildHostAdapterRuntime 请求 HostAdapterService 为单次调用归一化 session/workmem 上下文。
  async buildHostAdapterRuntime(context: VulcanHostContext): Promise<VulcanHostAdapterRuntime> {
    const response = await this.callUnary<Record<string, unknown>>(
      this.loadServices().hostAdapter,
      "BuildHostAdapterRuntime",
      {
        context: toHostAdapterClientContext(context),
        hostKind: context.hostKind,
        sessionId: context.sessionId ?? context.sessionKey ?? "",
        turnId: context.turnId ?? "",
        workspace: context.workspaceDir ?? "",
        userMessage: context.userMessage ?? "",
        conversationId:
          context.conversationId ?? context.messageThreadId ?? context.channelId ?? context.messageChannel ?? "",
        rootSessionId: context.rootSessionId ?? "",
      },
    );
    return {
      hostKind: String(response.hostKind ?? context.hostKind),
      sessionId: readOptionalString(response.sessionId),
      workmemId: readOptionalString(response.workmemId),
      workmemSource: readOptionalString(response.workmemSource),
      identityReady: response.identityReady === true,
      degradedReasons: readStringArray(response.degradedReasons),
      isError: response.isError === true,
      message: readOptionalString(response.message),
      vmmEnabled: response.vmmEnabled === true,
      vmmStatus: String(response.vmmStatus ?? ""),
      runtime: parseJsonObject(readOptionalString(response.runtimeJson)),
    };
  }

  // listLuaSkillTools returns dynamic LuaSkills descriptors that can later generate per-tool manifests.
  // listLuaSkillTools 返回后续可生成 per-tool manifest 的 LuaSkills 动态工具描述。
  async listLuaSkillTools(context: VulcanHostContext): Promise<VulcanToolDescriptor[]> {
    const response = await this.callUnary<Record<string, unknown>>(
      this.loadServices().luaSkills,
      "ListTools",
      {
        context: toLuaSkillClientContext(context),
        projection: toLuaSkillProjectionContext(context),
      },
    );
    return readArray(response.tools).map((entry) => normalizeLuaSkillDescriptor(entry));
  }

  // callLuaSkillTool invokes one dynamic LuaSkills tool by canonical name.
  // callLuaSkillTool 按标准名称调用一个 LuaSkills 动态工具。
  async callLuaSkillTool(params: {
    context: VulcanHostContext;
    toolName: string;
    arguments: JsonObject;
  }): Promise<VulcanToolCallResponse> {
    const response = await this.callUnary<Record<string, unknown>>(
      this.loadServices().luaSkills,
      "CallTool",
      {
        context: toLuaSkillClientContext(params.context),
        projection: toLuaSkillProjectionContext(params.context),
        toolName: params.toolName,
        argumentsJson: JSON.stringify(params.arguments),
      },
    );
    return normalizeToolCallResponse({
      text: readOptionalString(response.text) ?? "",
      resultJson: readOptionalString(response.resultJson),
      isError: response.isError === true,
      message: readOptionalString(response.message),
    });
  }

  // callMcpTool invokes a host-owned MCP tool through McpService.Call.
  // callMcpTool 通过 McpService.Call 调用宿主拥有的 MCP 工具。
  async callMcpTool(params: {
    context: VulcanHostContext;
    toolName: string;
    arguments: JsonObject;
  }): Promise<VulcanToolCallResponse> {
    const response = await this.callUnary<Record<string, unknown>>(this.loadServices().mcp, "Call", {
      method: "tools/call",
      arguments: JSON.stringify({ name: params.toolName, arguments: params.arguments }),
      sessionId: params.context.sessionId ?? params.context.sessionKey ?? "",
      clientName: params.context.clientName,
      clientVersion: params.context.clientVersion,
      requestId: params.context.requestId,
    });
    return normalizeMcpCallResponse(response);
  }

  // listVmmMemoryTools returns authoritative VMM tool descriptors from HostAdapterService.
  // listVmmMemoryTools 从 HostAdapterService 返回权威 VMM 工具描述。
  async listVmmMemoryTools(context: VulcanHostContext): Promise<VulcanToolDescriptor[]> {
    const response = await this.callUnary<Record<string, unknown>>(
      this.loadServices().hostAdapter,
      "ListVmmMemoryTools",
      { context: toHostAdapterClientContext(context) },
    );
    return readArray(response.tools).map((entry) => normalizeHostToolDescriptor(entry));
  }

  // listVmmBindingTools returns authoritative VMM binding/admin descriptors from HostAdapterService.
  // listVmmBindingTools 从 HostAdapterService 返回权威 VMM 绑定与管理工具描述。
  async listVmmBindingTools(context: VulcanHostContext): Promise<VulcanToolDescriptor[]> {
    const response = await this.callUnary<Record<string, unknown>>(
      this.loadServices().hostAdapter,
      "ListVmmBindingTools",
      { context: toHostAdapterClientContext(context) },
    );
    return readArray(response.tools).map((entry) => normalizeHostToolDescriptor(entry));
  }

  // listVmmProfileTools returns authoritative VMM profile-adjust descriptors from HostAdapterService.
  // listVmmProfileTools 从 HostAdapterService 返回权威 VMM 画像调整工具描述。
  async listVmmProfileTools(context: VulcanHostContext): Promise<VulcanToolDescriptor[]> {
    const response = await this.callUnary<Record<string, unknown>>(
      this.loadServices().hostAdapter,
      "ListVmmProfileTools",
      { context: toHostAdapterClientContext(context) },
    );
    return readArray(response.tools).map((entry) => normalizeHostToolDescriptor(entry));
  }

  // listVmmProjects returns the authoritative VMM project list for binding-management tools.
  // listVmmProjects 返回绑定管理工具需要使用的权威 VMM 项目列表。
  async listVmmProjects(_context: VulcanHostContext): Promise<VulcanVmmListProjectsResponse> {
    const response = await this.callUnary<Record<string, unknown>>(this.loadServices().vmm, "ListProjects", {});
    return {
      projects: readArray(response.projects).map((entry) => normalizeVmmProjectEntry(entry)),
      traceId: readOptionalString(response.traceId),
    };
  }

  // resolveVmmProject resolves one existing VMM project by numeric id or canonical display path without creating anything.
  // resolveVmmProject 按数字 ID 或标准展示路径解析一条现有 VMM 项目，且不会触发创建。
  async resolveVmmProject(params: {
    context: VulcanHostContext;
    projectRef: string;
  }): Promise<VulcanVmmResolvedProject> {
    const response = await this.callUnary<Record<string, unknown>>(this.loadServices().vmm, "ResolveProject", {
      projectRef: params.projectRef,
    });
    const project = normalizeVmmProjectEntry(asRecord(response.project));
    return {
      projectId: project.projectId,
      teamName: project.teamName,
      spaceName: project.spaceName,
      projectName: project.projectName,
      displayPath: project.displayPath || params.projectRef,
      message: String(response.message ?? ""),
      exists: Boolean(project.projectId),
      needsConfirm: false,
      createdTeam: false,
      createdSpace: false,
      createdProject: false,
    };
  }

  // resolveVmmUser resolves or creates one stable VMM user row for the current host context.
  // resolveVmmUser 为当前宿主上下文解析或创建一条稳定的 VMM 用户记录。
  async resolveVmmUser(params: {
    context: VulcanHostContext;
    userRef: string;
    confirmCreate?: boolean | undefined;
  }): Promise<VulcanVmmResolvedUser> {
    const response = await this.callUnary<Record<string, unknown>>(this.loadServices().vmm, "ResolveUser", {
      userRef: params.userRef,
      confirmCreate: params.confirmCreate === true,
    });
    const user = asRecord(response.user);
    return {
      userId: String(user.userId ?? ""),
      userName: String(user.userName ?? ""),
      message: String(response.message ?? ""),
      created: response.created === true,
      exists: response.exists === true,
    };
  }

  // listVmmUsers returns the authoritative VMM user list for binding-management tools.
  // listVmmUsers 返回绑定管理工具需要使用的权威 VMM 用户列表。
  async listVmmUsers(_context: VulcanHostContext): Promise<VulcanVmmListUsersResponse> {
    const response = await this.callUnary<Record<string, unknown>>(this.loadServices().vmm, "ListUsers", {});
    return {
      users: readArray(response.users).map((entry) => normalizeVmmUserEntry(entry)),
      traceId: readOptionalString(response.traceId),
    };
  }

  // ensureVmmProject resolves or creates one stable Team/Space/Project path for the current host context.
  // ensureVmmProject 为当前宿主上下文解析或创建一条稳定的 Team/Space/Project 路径。
  async ensureVmmProject(params: {
    context: VulcanHostContext;
    projectPath: string;
    confirmCreate?: boolean | undefined;
  }): Promise<VulcanVmmResolvedProject> {
    const response = await this.callUnary<Record<string, unknown>>(this.loadServices().vmm, "EnsureProject", {
      projectPath: params.projectPath,
      confirmCreate: params.confirmCreate !== false,
    });
    const project = asRecord(response.project);
    return {
      projectId: String(project.projectId ?? ""),
      teamName: String(project.teamName ?? ""),
      spaceName: String(project.spaceName ?? ""),
      projectName: String(project.projectName ?? ""),
      displayPath: String(project.displayPath ?? params.projectPath),
      message: String(response.message ?? ""),
      exists: response.exists === true,
      needsConfirm: response.needsConfirm === true,
      createdTeam: response.createdTeam === true,
      createdSpace: response.createdSpace === true,
      createdProject: response.createdProject === true,
    };
  }

  // searchVmmMemories performs grouped memory search against the VMM data plane.
  // searchVmmMemories 对 VMM 数据面执行分组记忆检索。
  async searchVmmMemories(params: {
    context: VulcanHostContext;
    userId: string;
    projectId: string;
    queries: string[];
    topK: number;
  }): Promise<VulcanVmmMemorySearchResponse> {
    const response = await this.callUnary<Record<string, unknown>>(
      this.loadServices().vmm,
      "SearchMemoryEvents",
      {
        userId: params.userId,
        projectId: params.projectId,
        queries: params.queries,
        topK: params.topK,
      },
    );
    return {
      results: readArray(response.results).map((entry) => normalizeVmmMemorySearchGroup(entry)),
      traceId: readOptionalString(response.traceId),
    };
  }

  // deleteVmmMemories deletes explicit durable memory ids inside the resolved VMM scope.
  // deleteVmmMemories 会在已解析 VMM 范围内删除明确指定的长期 memory id。
  async deleteVmmMemories(params: {
    context: VulcanHostContext;
    userId: string;
    projectId: string;
    memoryIds: string[];
    reason: string;
  }): Promise<VulcanVmmDeleteMemoriesResponse> {
    const response = await this.callUnary<Record<string, unknown>>(
      this.loadServices().vmm,
      "DeleteMemories",
      {
        userId: params.userId,
        projectId: params.projectId,
        memoryIds: params.memoryIds,
        reason: params.reason,
      },
    );
    return {
      deletedMemoryIds: readPrimitiveArray(response.deletedMemoryIds).map(String),
      notFoundMemoryIds: readPrimitiveArray(response.notFoundMemoryIds).map(String),
      deletedVectorRows: String(response.deletedVectorRows ?? "0"),
      traceId: readOptionalString(response.traceId),
    };
  }

  // getVmmTurnDetails loads structured dialogue details for one or more source turns.
  // getVmmTurnDetails 加载一条或多条 source turn 的结构化对话详情。
  async getVmmTurnDetails(params: {
    context: VulcanHostContext;
    turnIds: string[];
  }): Promise<VulcanVmmTurnDetailsResponse> {
    const response = await this.callUnary<Record<string, unknown>>(this.loadServices().vmm, "GetTurnDetails", {
      turnIds: params.turnIds,
    });
    return {
      turns: readArray(response.turns).map((entry) => normalizeVmmTurnDetail(entry)),
      traceId: readOptionalString(response.traceId),
    };
  }

  // getVmmProfileBundle loads the VMM-owned hidden full profile bundle for one resolved user/project scope.
  // getVmmProfileBundle 加载 VMM 为一组已解析 user/project 作用域组装的隐藏完整画像 bundle。
  async getVmmProfileBundle(params: {
    context: VulcanHostContext;
    userId: string;
    projectId: string;
    includeExplanation?: boolean | undefined;
  }): Promise<VulcanVmmProfileBundleResponse> {
    const response = await this.callUnary<Record<string, unknown>>(this.loadServices().vmm, "GetProfileBundle", {
      userId: params.userId,
      projectId: params.projectId,
      mode: "PROFILE_BUNDLE_MODE_FULL",
      includeExplanation: params.includeExplanation !== false,
    });
    return {
      combinedText: String(response.combinedText ?? ""),
      explanationText: readOptionalString(response.explanationText),
      environmentPriorityText: readOptionalString(response.environmentPriorityText),
      teamProfile: readOptionalString(response.teamProfile),
      spaceProfile: readOptionalString(response.spaceProfile),
      projectProfile: readOptionalString(response.projectProfile),
      userProfile: readOptionalString(response.userProfile),
      traceId: readOptionalString(response.traceId),
    };
  }

  // applyVmmProfileInstruction submits one explicit natural-language profile correction for the current durable scope.
  // applyVmmProfileInstruction 为当前长期作用域提交一条显式自然语言画像纠偏指令。
  async applyVmmProfileInstruction(params: {
    context: VulcanHostContext;
    userId: string;
    projectId: string;
    scope: "user" | "project" | "team" | "space";
    instruction: string;
  }): Promise<VulcanVmmProfileAdjustResponse> {
    const response = await this.callUnary<Record<string, unknown>>(
      this.loadServices().vmm,
      "ApplyProfileInstruction",
      {
        target: toProfileTargetEnum(params.scope),
        userId: params.userId,
        projectId: params.projectId,
        instruction: params.instruction,
      },
    );
    return {
      instructionId: String(response.instructionId ?? ""),
      acceptedNodes: readArray(response.acceptedNodes).map((entry) => normalizeVmmProfileNode(entry)),
      retiredNodes: readArray(response.retiredNodes).map((entry) => normalizeVmmRetiredProfileNode(entry)),
      reviewReason: String(response.reviewReason ?? ""),
      traceId: readOptionalString(response.traceId),
    };
  }

  // preCheckVmm asks VMM to assemble compact recall context for one upcoming turn.
  // preCheckVmm 请求 VMM 为即将开始的一轮组装紧凑召回上下文。
  async preCheckVmm(params: {
    context: VulcanHostContext;
    sessionId: string;
    userId: string;
    projectId: string;
    userContent: string;
    recallMode?: "legacy" | "session_compact" | undefined;
  }): Promise<VulcanVmmPrecheckResponse> {
    const response = await this.callUnary<Record<string, unknown>>(this.loadServices().vmm, "PreCheck", {
      sessionId: params.sessionId,
      userId: params.userId,
      projectId: params.projectId,
      userContent: params.userContent,
      recallMode: params.recallMode === "legacy" ? "PRE_CHECK_RECALL_MODE_LEGACY" : "PRE_CHECK_RECALL_MODE_SESSION_COMPACT",
    });
    return {
      shouldInject: response.shouldInject === true,
      degraded: response.degraded === true,
      contextItems: readArray(response.contextItems).map((entry) => ({
        text: String(entry.text ?? ""),
        score: readFiniteNumber(entry.score, 0),
        turnId: String(entry.turnId ?? ""),
        hasDialogue: entry.hasDialogue === true,
        createdDatetime: String(entry.createdDatetime ?? ""),
        memoryId: String(entry.memoryId ?? ""),
      })),
      traceId: readOptionalString(response.traceId),
    };
  }

  // postActionVmm appends one durable text-only turn payload into VMM's postaction chain.
  // postActionVmm 将一条纯文本回合载荷追加到 VMM 的 postaction 链路。
  async postActionVmm(params: {
    context: VulcanHostContext;
    sessionId: string;
    userId: string;
    projectId: string;
    userContent: string;
    assistantContent: string;
    timeline: VulcanVmmTurnTimelineItem[];
  }): Promise<VulcanVmmPostActionResponse> {
    const response = await this.callUnary<Record<string, unknown>>(this.loadServices().vmm, "PostAction", {
      sessionId: params.sessionId,
      userId: params.userId,
      projectId: params.projectId,
      userContent: params.userContent,
      assistantContent: params.assistantContent,
      timeline: params.timeline.map((entry) => ({ type: entry.type, content: entry.content })),
    });
    return {
      accepted: response.accepted === true,
      traceId: readOptionalString(response.traceId),
    };
  }

  // chatCompactVmm acknowledges one OpenClaw compaction boundary so later VMM recall can reopen only compacted-away history.
  // chatCompactVmm 确认一次 OpenClaw 压缩边界，让后续 VMM 召回只重新开放已被压缩的历史。
  async chatCompactVmm(params: {
    context: VulcanHostContext;
    sessionId: string;
    userId: string;
    projectId: string;
  }): Promise<VulcanVmmChatCompactResponse> {
    const response = await this.callUnary<Record<string, unknown>>(this.loadServices().vmm, "ChatCompact", {
      sessionId: params.sessionId,
      userId: params.userId,
      projectId: params.projectId,
    });
    return {
      accepted: response.accepted === true,
      updated: response.updated === true,
      compactedTurnId: readOptionalString(response.compactedTurnId),
      traceId: readOptionalString(response.traceId),
    };
  }

  // listInstalledLuaSkills renders the user-layer LuaSkills inventory through the stable RPC.
  // listInstalledLuaSkills 通过稳定 RPC 渲染 USER 层 LuaSkills 清单。
  async listInstalledLuaSkills(context: VulcanHostContext): Promise<VulcanToolCallResponse> {
    return await this.callLuaSkillTextMethod("ListInstalledSkills", { context });
  }

  // runLuaSkillLifecycle invokes install, update, or uninstall through stable LuaSkills RPCs.
  // runLuaSkillLifecycle 通过稳定 LuaSkills RPC 调用 install、update 或 uninstall。
  async runLuaSkillLifecycle(request: LuaSkillLifecycleRequest): Promise<VulcanToolCallResponse> {
    if (request.action === "install") {
      return await this.callLuaSkillTextMethod("InstallSkill", {
        context: request.context,
        source: request.source ?? "",
        sourceType: request.sourceType ?? "",
      });
    }
    if (request.action === "update") {
      return await this.callLuaSkillTextMethod("UpdateSkill", {
        context: request.context,
        skillId: request.skillId ?? "",
      });
    }
    return await this.callLuaSkillTextMethod("UninstallSkill", {
      context: request.context,
      skillId: request.skillId ?? "",
    });
  }

  // reloadRuntimeConfigs asks vulcan-host to reload hot-reloadable runtime configuration files.
  // reloadRuntimeConfigs 请求 vulcan-host 重载可热加载运行时配置文件。
  async reloadRuntimeConfigs(context: VulcanHostContext): Promise<VulcanToolCallResponse> {
    return await this.callLuaSkillTextMethod("ReloadRuntimeConfigs", { context });
  }

  // callLuaSkillTextMethod normalizes stable LuaSkills text-response RPCs.
  // callLuaSkillTextMethod 归一化稳定 LuaSkills 文本响应 RPC。
  private async callLuaSkillTextMethod(
    method: string,
    params: { context: VulcanHostContext; [key: string]: unknown },
  ): Promise<VulcanToolCallResponse> {
    const { context, ...rest } = params;
    const response = await this.callUnary<Record<string, unknown>>(this.loadServices().luaSkills, method, {
      context: toLuaSkillClientContext(context),
      ...rest,
    });
    const text = readOptionalString(response.text) ?? "";
    const message = readOptionalString(response.message);
    return {
      text: text || message || "",
      result: { text, message: message ?? "", isError: response.isError === true },
      isError: response.isError === true,
      message,
    };
  }

  // callUnary wraps callback-style grpc-js calls into promises.
  // callUnary 将 callback 风格的 grpc-js 调用包装为 Promise。
  private async callUnary<T>(
    client: GrpcUnaryClient,
    method: string,
    request: Record<string, unknown>,
  ): Promise<T> {
    if (isVulcanHostConnectionUnavailable(this.config)) {
      ensureVulcanHostReconnectScheduled(this.config);
      throw new Error(`vulcan-host is currently disconnected from ${normalizeGrpcEndpoint(this.config.endpoint)}.`);
    }
    const fn = client[method];
    if (typeof fn !== "function") {
      throw new Error(`vulcan-host gRPC method not found: ${method}`);
    }
    return await new Promise<T>((resolve, reject) => {
      fn.call(client, request, (error, response) => {
        if (error) {
          markVulcanHostTransportFailure(this.config, error);
          reject(error);
          return;
        }
        markVulcanHostConnected(this.config);
        resolve(response as T);
      });
    });
  }

  // loadServices loads proto definitions once and creates gRPC clients for each service.
  // loadServices 只加载一次 proto 定义，并为每个服务创建 gRPC 客户端。
  private loadServices(): LoadedGrpcServices {
    if (this.services) {
      return this.services;
    }
    const mcpProtoPath = resolveProtoPath(this.config);
    const vmmProtoPath = resolveVmmProtoPath(mcpProtoPath);
    const includeDirs = [...new Set([path.dirname(mcpProtoPath), path.dirname(vmmProtoPath)])];
    const packageDefinition = protoLoader.loadSync([mcpProtoPath, vmmProtoPath], {
      defaults: true,
      enums: String,
      includeDirs,
      keepCase: false,
      longs: String,
      oneofs: true,
    });
    const loaded = grpc.loadPackageDefinition(packageDefinition) as Record<string, unknown>;
    const namespace = (((loaded.vulcan as Record<string, unknown>)?.mcp as Record<string, unknown>)
      ?.v1 ?? {}) as Record<string, unknown>;
    const McpService = namespace.McpService as
      | (new (target: string, credentials: grpc.ChannelCredentials) => GrpcUnaryClient)
      | undefined;
    const LuaSkillsService = namespace.LuaSkillsService as
      | (new (target: string, credentials: grpc.ChannelCredentials) => GrpcUnaryClient)
      | undefined;
    const HostAdapterService = namespace.HostAdapterService as
      | (new (target: string, credentials: grpc.ChannelCredentials) => GrpcUnaryClient)
      | undefined;
    const vmmNamespace = ((loaded.vmm as Record<string, unknown>)?.v1 ?? {}) as Record<string, unknown>;
    const VMMService = vmmNamespace.VMMService as
      | (new (target: string, credentials: grpc.ChannelCredentials) => GrpcUnaryClient)
      | undefined;
    if (!McpService || !LuaSkillsService || !HostAdapterService || !VMMService) {
      throw new Error(
        "vulcan-host proto does not expose McpService, LuaSkillsService, HostAdapterService, and VMMService.",
      );
    }
    const endpoint = normalizeGrpcEndpoint(this.config.endpoint);
    const credentials = grpc.credentials.createInsecure();
    this.services = {
      mcp: new McpService(endpoint, credentials),
      luaSkills: new LuaSkillsService(endpoint, credentials),
      hostAdapter: new HostAdapterService(endpoint, credentials),
      vmm: new VMMService(endpoint, credentials),
    };
    return this.services;
  }
}

// createVulcanHostClient constructs the shared client used by plugin entrypoints.
// createVulcanHostClient 创建插件入口使用的共享客户端。
export function createVulcanHostClient(config: ResolvedVulcanConfig): VulcanHostClient {
  return new DynamicGrpcVulcanHostClient(config);
}

/**
 * Resolve mcp_service.proto from an explicit override or the bundled package contract.
 * 从明确覆盖路径或包内置契约解析 mcp_service.proto。
 *
 * @param {ResolvedVulcanConfig} config Runtime plugin config containing protoPath.
 * 包含 protoPath 的运行时插件配置。
 * @returns {string} Existing path to mcp_service.proto.
 * 已存在的 mcp_service.proto 路径。
 * @throws {Error} When neither the configured nor bundled protocol file exists.
 * 配置路径与包内置协议文件都不存在时抛出错误。
 */
function resolveProtoPath(config: ResolvedVulcanConfig): string {
  // protoPath prefers an existing user override and otherwise uses the contract packaged with this version.
  // protoPath 优先使用现存用户覆盖路径，否则使用随当前版本打包的契约。
  const configuredPath = config.protoPath?.trim();
  if (configuredPath && existsSync(configuredPath)) {
    return configuredPath;
  }
  if (configuredPath) {
    console.warn(`Configured Vulcan proto file was not found; using the bundled contract: ${BUNDLED_MCP_PROTO_PATH}`);
  }
  // protoPath becomes the versioned in-package contract when no valid override is available.
  // protoPath 在没有可用覆盖路径时使用包内版本管理的契约。
  const protoPath = BUNDLED_MCP_PROTO_PATH;
  if (!existsSync(protoPath)) {
    throw new Error(`Vulcan proto file was not found at the resolved path: ${protoPath}`);
  }
  return protoPath;
}

/**
 * Resolve the VMM schema paired with the configured MCP schema.
 * 解析与已配置 MCP schema 配套的 VMM schema。
 *
 * @param {string} mcpProtoPath Existing path to mcp_service.proto.
 * mcp_service.proto 的现存路径。
 * @returns {string} Existing path to the sibling vmm.proto file.
 * 同目录现存 vmm.proto 文件的路径。
 * @throws {Error} When vmm.proto is missing from the MCP schema directory.
 * MCP schema 目录中缺少 vmm.proto 时抛出错误。
 */
function resolveVmmProtoPath(mcpProtoPath: string): string {
  // vmmProtoPath is derived only from the configured MCP contract to avoid hidden workspace defaults.
  // vmmProtoPath 只根据已配置的 MCP 契约推导，避免依赖隐藏工作区默认值。
  const vmmProtoPath = path.join(path.dirname(mcpProtoPath), "vmm.proto");
  if (!existsSync(vmmProtoPath)) {
    throw new Error(`VMM proto file was not found next to the configured mcp_service.proto: ${vmmProtoPath}`);
  }
  return vmmProtoPath;
}

// normalizeGrpcEndpoint removes URL schemes because grpc-js expects host:port targets.
// normalizeGrpcEndpoint 移除 URL scheme，因为 grpc-js 需要 host:port 目标。
function normalizeGrpcEndpoint(endpoint: string): string {
  return endpoint.replace(/^https?:\/\//u, "");
}

// toLuaSkillClientContext converts trusted host context into LuaSkills gRPC context fields.
// toLuaSkillClientContext 将受信任宿主上下文转换为 LuaSkills gRPC context 字段。
function toLuaSkillClientContext(context: VulcanHostContext): Record<string, unknown> {
  return {
    clientName: context.clientName,
    clientVersion: context.clientVersion,
    requestId: context.requestId,
  };
}

// toLuaSkillProjectionContext declares OpenClaw as a managed-session host and passes the live session id when available.
// toLuaSkillProjectionContext 声明 OpenClaw 是托管 session 的宿主，并在可用时传递实时 session id。
function toLuaSkillProjectionContext(context: VulcanHostContext): Record<string, unknown> {
  return {
    supportsManagedLuaskillSid: true,
    sessionId: context.sessionId ?? context.sessionKey ?? "",
  };
}

// toProfileTargetEnum converts one shared scope name into the protobuf enum label expected by proto-loader.
// toProfileTargetEnum 将共享层级名称转换为 proto-loader 期望的 protobuf 枚举标签。
function toProfileTargetEnum(scope: "user" | "project" | "team" | "space"): string {
  switch (scope) {
    case "user":
      return "PROFILE_TARGET_USER";
    case "project":
      return "PROFILE_TARGET_PROJECT";
    case "team":
      return "PROFILE_TARGET_TEAM";
    case "space":
      return "PROFILE_TARGET_SPACE";
  }
}

// toHostAdapterClientContext converts trusted host context into HostAdapter gRPC context fields.
// toHostAdapterClientContext 将受信任宿主上下文转换为 HostAdapter gRPC context 字段。
function toHostAdapterClientContext(context: VulcanHostContext): Record<string, unknown> {
  return {
    clientName: context.clientName,
    clientVersion: context.clientVersion,
    requestId: context.requestId,
  };
}

// normalizeLuaSkillDescriptor maps LuaSkills gRPC descriptors into shared tool descriptors.
// normalizeLuaSkillDescriptor 将 LuaSkills gRPC 描述映射为共享工具描述。
function normalizeLuaSkillDescriptor(entry: Record<string, unknown>): VulcanToolDescriptor {
  return {
    name: String(entry.name ?? ""),
    description: String(entry.description ?? ""),
    inputSchema: parseJsonObject(readOptionalString(entry.inputSchemaJson)),
    annotations: parseJsonObject(readOptionalString(entry.annotationsJson)),
    skillId: readOptionalString(entry.skillId),
    entryName: readOptionalString(entry.entryName),
    rootName: readOptionalString(entry.rootName),
    skillDir: readOptionalString(entry.skillDir),
  };
}

// normalizeHostToolDescriptor maps host-owned descriptors into shared tool descriptors.
// normalizeHostToolDescriptor 将宿主拥有的工具描述映射为共享工具描述。
function normalizeHostToolDescriptor(entry: Record<string, unknown>): VulcanToolDescriptor {
  return {
    name: String(entry.name ?? ""),
    description: String(entry.description ?? ""),
    inputSchema: parseJsonObject(readOptionalString(entry.inputSchemaJson)),
    annotations: parseJsonObject(readOptionalString(entry.annotationsJson)),
    source: readOptionalString(entry.source),
  };
}

// normalizeVmmProjectEntry maps one dynamic protobuf project row into the stable shared admin shape.
// normalizeVmmProjectEntry 将一条动态 protobuf 项目记录映射为稳定的共享管理结构。
function normalizeVmmProjectEntry(entry: Record<string, unknown>): VulcanVmmProjectEntry {
  return {
    projectId: String(entry.projectId ?? ""),
    teamName: String(entry.teamName ?? ""),
    spaceName: String(entry.spaceName ?? ""),
    projectName: String(entry.projectName ?? ""),
    displayPath: String(entry.displayPath ?? ""),
  };
}

// normalizeVmmUserEntry maps one dynamic protobuf user row into the stable shared admin shape.
// normalizeVmmUserEntry 将一条动态 protobuf 用户记录映射为稳定的共享管理结构。
function normalizeVmmUserEntry(entry: Record<string, unknown>): VulcanVmmUserEntry {
  return {
    userId: String(entry.userId ?? ""),
    userName: String(entry.userName ?? ""),
  };
}

// normalizeVmmMemorySearchGroup maps one dynamic protobuf group into a stable shared result shape.
// normalizeVmmMemorySearchGroup 将一条动态 protobuf 分组映射为稳定的共享结果结构。
function normalizeVmmMemorySearchGroup(entry: Record<string, unknown>): VulcanVmmMemorySearchGroupResult {
  return {
    queryIndex: readFiniteNumber(entry.queryIndex, 0),
    query: String(entry.query ?? ""),
    hits: readArray(entry.hits).map((hit) => ({
      memoryId: String(hit.memoryId ?? ""),
      sourceTurnId: String(hit.sourceTurnId ?? ""),
      abstract: String(hit.abstract ?? ""),
      detailsPreview: String(hit.detailsPreview ?? ""),
      category: String(hit.category ?? ""),
      createdDatetime: String(hit.createdDatetime ?? ""),
    })),
  };
}

// normalizeVmmTurnDetail maps one dynamic protobuf turn into the stable shared detail shape.
// normalizeVmmTurnDetail 将一条动态 protobuf turn 映射为稳定的共享详情结构。
function normalizeVmmTurnDetail(entry: Record<string, unknown>): VulcanVmmTurnDetailEntry {
  return {
    turnId: String(entry.turnId ?? ""),
    userQuestion: String(entry.userQuestion ?? ""),
    assistantAnswer: String(entry.assistantAnswer ?? ""),
    detail: String(entry.detail ?? ""),
    previousTurnIds: readPrimitiveArray(entry.previousTurnIds),
    nextTurnIds: readPrimitiveArray(entry.nextTurnIds),
    timeline: readArray(entry.timeline).map((item) => ({
      type: String(item.type ?? ""),
      content: String(item.content ?? ""),
    })),
  };
}

// normalizeVmmProfileNode maps one dynamic protobuf profile node into the stable shared profile-adjust shape.
// normalizeVmmProfileNode 将一条动态 protobuf 画像节点映射为稳定的共享画像调整结构。
function normalizeVmmProfileNode(entry: Record<string, unknown>): VulcanVmmProfileNodeEntry {
  return {
    profileNodeId: String(entry.profileNodeId ?? ""),
    target: String(entry.target ?? ""),
    bindId: String(entry.bindId ?? ""),
    content: String(entry.content ?? ""),
    priority: String(entry.priority ?? ""),
    level: String(entry.level ?? ""),
    refreshWeight: readFiniteNumber(entry.refreshWeight, 0),
    profileDate: String(entry.profileDate ?? ""),
    expiresTimestamp: String(entry.expiresTimestamp ?? ""),
    levelReason: String(entry.levelReason ?? ""),
    sourceKind: String(entry.sourceKind ?? ""),
    sourceId: String(entry.sourceId ?? ""),
  };
}

// normalizeVmmRetiredProfileNode maps one dynamic protobuf retired profile node into the stable shared result shape.
// normalizeVmmRetiredProfileNode 将一条动态 protobuf 退役画像节点映射为稳定的共享结果结构。
function normalizeVmmRetiredProfileNode(entry: Record<string, unknown>): VulcanVmmRetiredProfileNodeEntry {
  return {
    profileNodeId: String(entry.profileNodeId ?? ""),
    reason: String(entry.reason ?? ""),
  };
}

// normalizeToolCallResponse maps direct tool-call gRPC fields into shared responses.
// normalizeToolCallResponse 将直接工具调用 gRPC 字段映射为共享响应。
function normalizeToolCallResponse(params: {
  text: string;
  resultJson?: string | undefined;
  isError: boolean;
  message?: string | undefined;
}): VulcanToolCallResponse {
  const result = parseJsonValue(params.resultJson);
  return {
    text: params.text,
    result,
    isError: params.isError,
    message: params.message,
  };
}

// normalizeMcpCallResponse unwraps the JSON-RPC envelope returned by McpService.Call.
// normalizeMcpCallResponse 解开 McpService.Call 返回的 JSON-RPC 信封。
function normalizeMcpCallResponse(response: Record<string, unknown>): VulcanToolCallResponse {
  const rawResult = readOptionalString(response.result);
  const envelope = parseJsonValue(rawResult);
  const result =
    envelope && typeof envelope === "object" && !Array.isArray(envelope) && "result" in envelope
      ? (envelope.result as JsonValue)
      : envelope;
  const errorMessage =
    envelope && typeof envelope === "object" && !Array.isArray(envelope) && "error" in envelope
      ? JSON.stringify(envelope.error)
      : readOptionalString(response.message);
  return {
    text: extractTextFromToolResult(result) || rawResult || "",
    result,
    isError: response.isError === true || Boolean(errorMessage),
    message: errorMessage,
  };
}

// extractTextFromToolResult joins text content blocks from MCP-compatible tool results.
// extractTextFromToolResult 从 MCP 兼容工具结果中拼接文本 content 块。
function extractTextFromToolResult(value: JsonValue | undefined): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }
  const content = value.content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((entry) =>
      entry && typeof entry === "object" && !Array.isArray(entry) && typeof entry.text === "string"
        ? entry.text
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

// parseJsonValue parses arbitrary JSON while preserving undefined for empty or invalid strings.
// parseJsonValue 解析任意 JSON，并在空值或非法字符串时保留 undefined。
function parseJsonValue(value: string | undefined): JsonValue | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return undefined;
  }
}

// readArray safely narrows repeated protobuf fields into object arrays.
// readArray 将 repeated protobuf 字段安全收窄为对象数组。
function readArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"))
    : [];
}

// readPrimitiveArray converts a repeated scalar field into trimmed string items.
// readPrimitiveArray 把 repeated 标量字段转换为裁剪后的字符串条目。
function readPrimitiveArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((entry) => (typeof entry === "string" || typeof entry === "number" ? String(entry).trim() : ""))
        .filter(Boolean)
    : [];
}

// readStringArray converts a repeated string field into trimmed non-empty values.
// readStringArray 把 repeated string 字段转换为裁剪后的非空值。
function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter(Boolean)
    : [];
}

// readFiniteNumber preserves finite numeric values and falls back when the field is absent or invalid.
// readFiniteNumber 保留有限数值，并在字段缺失或非法时使用回退值。
function readFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// asRecord safely narrows unknown protobuf sub-objects into plain objects.
// asRecord 将未知 protobuf 子对象安全收窄为普通对象。
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// readOptionalString preserves non-empty string values from dynamic protobuf responses.
// readOptionalString 从动态 protobuf 响应中保留非空字符串值。
function readOptionalString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

// unavailableFromError converts client construction/call errors into a normal tool response.
// unavailableFromError 将客户端构造或调用错误转换为普通工具响应。
export function unavailableFromError(error: unknown): VulcanToolCallResponse {
  return createUnavailableResponse(error instanceof Error ? error.message : String(error));
}
