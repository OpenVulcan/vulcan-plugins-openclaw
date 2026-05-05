// Binding-management tools for hosts that do not provide a native TUI like OpenCode.
// 本文件负责为没有原生 TUI 的宿主提供绑定管理工具，例如 OpenClaw。

import {
  buildToolHostContext,
  clearPersistedAgentProjectId,
  createVulcanHostClient,
  errorToolResult,
  jsonToolResult,
  loadPersistedVulcanBindingState,
  resolveEffectiveVulcanBindings,
  setPersistedAgentProjectId,
  setPersistedDefaultProjectId,
  setPersistedDefaultUserId,
  type JsonObject,
  type JsonValue,
  type ResolvedVulcanConfig,
  type VulcanHostClient,
  type VulcanHostContext,
  type VulcanToolDescriptor,
  type VulcanVmmResolvedProject,
  type VulcanVmmResolvedUser,
} from "@vulcan-plugins-openclaw/shared";
import type {
  AnyAgentTool,
  AgentToolResult,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { GENERATED_VMM_TOOLS } from "./generated/vmm-tools.generated.js";

// BindingToolParams groups the shared dependencies required by every binding-management tool.
// BindingToolParams 汇总每个绑定管理工具都会用到的共享依赖。
interface BindingToolParams {
  api: OpenClawPluginApi;
  config: ResolvedVulcanConfig;
  ctx: OpenClawPluginToolContext;
}

// BindingToolExecutionMode declares whether one binding/admin tool is local-only, remote-only, or hybrid.
// BindingToolExecutionMode 声明一条绑定/管理工具是纯本地、纯远端还是混合执行。
type BindingToolExecutionMode = "local" | "remote" | "hybrid";

// BindingToolName enumerates the binding/admin tools whose descriptors are synchronized from vulcan-host.
// BindingToolName 枚举从 vulcan-host 同步描述的绑定与管理工具名称。
export type BindingToolName =
  | "vulcan_vmm_get_bindings"
  | "vulcan_vmm_list_users"
  | "vulcan_vmm_bind_default_user"
  | "vulcan_vmm_list_projects"
  | "vulcan_vmm_bind_default_project"
  | "vulcan_vmm_bind_agent_project"
  | "vulcan_vmm_clear_agent_project";

// BindingToolDefinition keeps one descriptor-driven tool contract and its host-local execution body together.
// BindingToolDefinition 把一条 descriptor 驱动的工具契约与其宿主本地执行主体放在一起维护。
interface BindingToolDefinition {
  name: BindingToolName;
  label: string;
  fallbackDescription: string;
  fallbackSchema: Record<string, unknown>;
  execute: (context: BindingToolExecutionContext, rawParams: unknown) => Promise<AgentToolResult>;
}

// BindingToolRemoteRuntime reuses one lazily built host client/context pair for tools that must talk to vulcan-host.
// BindingToolRemoteRuntime 复用一份按需构造的 host client/context 对，用于必须访问 vulcan-host 的工具。
interface BindingToolRemoteRuntime {
  client: VulcanHostClient;
  context: VulcanHostContext;
}

// BindingToolExecutionContext combines host-local dependencies with the synchronized descriptor contract used by one tool execution.
// BindingToolExecutionContext 组合单次工具执行所需的宿主本地依赖与同步 descriptor 契约。
interface BindingToolExecutionContext {
  params: BindingToolParams;
  descriptor: VulcanToolDescriptor;
  executionMode: BindingToolExecutionMode;
  getRemoteRuntime: () => BindingToolRemoteRuntime;
}

// VULCAN_BINDING_TOOL_NAMES preserves one stable registration order shared by sync, runtime, and later host adapters.
// VULCAN_BINDING_TOOL_NAMES 保留一份稳定注册顺序，供同步、运行时与后续宿主适配层共同使用。
const VULCAN_BINDING_TOOL_NAMES: BindingToolName[] = [
  "vulcan_vmm_get_bindings",
  "vulcan_vmm_list_users",
  "vulcan_vmm_bind_default_user",
  "vulcan_vmm_list_projects",
  "vulcan_vmm_bind_default_project",
  "vulcan_vmm_bind_agent_project",
  "vulcan_vmm_clear_agent_project",
];

// VmmBindingGetSchema keeps the bindings inspection tool simple while still allowing explicit agent-target inspection.
// VmmBindingGetSchema 保持绑定查看工具的输入足够简单，同时允许显式查看指定 agent 的目标绑定。
const VmmBindingGetSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    agentId: {
      type: "string",
      description:
        "Optional OpenClaw agent id to inspect. Omit to inspect the current main agent when one is available.",
    },
  },
} as const;

// VmmListUsersSchema intentionally stays empty because the backend already returns the full durable user list.
// VmmListUsersSchema 故意保持为空，因为后端已经会返回完整的长期用户列表。
const VmmListUsersSchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

// VmmBindDefaultUserSchema accepts either an existing numeric user id or a durable user name and can create missing users when requested.
// VmmBindDefaultUserSchema 接受现有数字用户 ID 或长期用户名，并可在需要时创建缺失用户。
const VmmBindDefaultUserSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    userRef: {
      type: "string",
      description:
        "Existing numeric user id or durable user name. When createIfMissing=true and the name does not exist, VMM will create it.",
    },
    createIfMissing: {
      type: "boolean",
      description: "Whether the tool may create the user when userRef is a missing name.",
    },
  },
  required: ["userRef"],
} as const;

// VmmListProjectsSchema intentionally stays empty because the backend already returns the full canonical Team/Space/Project list.
// VmmListProjectsSchema 故意保持为空，因为后端已经会返回完整的标准 Team/Space/Project 列表。
const VmmListProjectsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

// VmmBindProjectSchema accepts either an existing numeric project id or one canonical Team/Space/Project path for default binding.
// VmmBindProjectSchema 接受现有数字项目 ID，或用于默认绑定的一条标准 Team/Space/Project 路径。
const VmmBindProjectSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    projectRef: {
      type: "string",
      description:
        "Existing numeric project id or canonical Team/Space/Project path. Creation requires a canonical path.",
    },
    createIfMissing: {
      type: "boolean",
      description:
        "Whether the tool may create the project when projectRef is a missing canonical Team/Space/Project path.",
    },
  },
  required: ["projectRef"],
} as const;

// VmmBindAgentProjectSchema allows one main OpenClaw agent to override the shared default project binding.
// VmmBindAgentProjectSchema 允许某个 OpenClaw 主 agent 覆盖共享默认项目绑定。
const VmmBindAgentProjectSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    agentId: {
      type: "string",
      description:
        "Optional target OpenClaw agent id. Omit to use the current main agent id from trusted tool context.",
    },
    projectRef: {
      type: "string",
      description:
        "Existing numeric project id or canonical Team/Space/Project path. Creation requires a canonical path.",
    },
    createIfMissing: {
      type: "boolean",
      description:
        "Whether the tool may create the project when projectRef is a missing canonical Team/Space/Project path.",
    },
  },
  required: ["projectRef"],
} as const;

// VmmClearAgentProjectSchema clears one agent-specific override so the runtime falls back to the shared default project.
// VmmClearAgentProjectSchema 清除单个 agent 的项目覆盖，让运行时回退到共享默认项目。
const VmmClearAgentProjectSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    agentId: {
      type: "string",
      description:
        "Optional target OpenClaw agent id. Omit to clear the current main agent id from trusted tool context.",
    },
  },
} as const;

// VULCAN_BINDING_TOOL_DEFINITIONS centralizes host-local execution for every binding/admin tool while descriptors stay host-synchronized.
// VULCAN_BINDING_TOOL_DEFINITIONS 在保持 descriptor 由宿主同步的同时，统一维护每个绑定/管理工具的宿主本地执行逻辑。
const VULCAN_BINDING_TOOL_DEFINITIONS: Record<BindingToolName, BindingToolDefinition> = {
  vulcan_vmm_get_bindings: {
    name: "vulcan_vmm_get_bindings",
    label: "Vulcan VMM Bindings",
    fallbackDescription:
      "Inspect the effective Vulcan Memory Mesh user/project bindings used by OpenClaw, including default bindings and any per-agent project override.",
    fallbackSchema: VmmBindingGetSchema,
    async execute(context, rawParams) {
      const { params } = context;
      const input = asRecord(rawParams);
      const targetAgentId = readOptionalString(input.agentId) ?? params.ctx.agentId;
      const effective = await resolveEffectiveVulcanBindings(params.config, targetAgentId);
      const persisted = await loadPersistedVulcanBindingState();
      return jsonToolResult(
        {
          storePath: effective.storePath,
          currentAgentId: targetAgentId ?? "",
          configuredDefaultUserId: params.config.bindings.defaultUserId,
          configuredDefaultProjectId: params.config.bindings.defaultProjectId,
          defaultUserId: effective.defaultUserId,
          defaultProjectId: effective.defaultProjectId,
          effectiveUserId: effective.effectiveUserId,
          effectiveProjectId: effective.effectiveProjectId,
          agentProjectId: effective.agentProjectId ?? "",
          projectSource: effective.projectSource,
          configuredAgentProjects: params.config.bindings.agentProjects,
          persistedAgentProjects: persisted.agentProjects,
        } as JsonValue,
        {
          effective,
          persisted,
        },
      );
    },
  },
  vulcan_vmm_list_users: {
    name: "vulcan_vmm_list_users",
    label: "Vulcan VMM Users",
    fallbackDescription:
      "List durable VMM users so you can choose one real user id for default OpenClaw binding.",
    fallbackSchema: VmmListUsersSchema,
    async execute(context) {
      const runtime = context.getRemoteRuntime();
      const response = await runtime.client.listVmmUsers(runtime.context);
      return jsonToolResult(
        {
          total: response.users.length,
          users: response.users,
          traceId: response.traceId ?? "",
        } as unknown as JsonValue,
        response,
      );
    },
  },
  vulcan_vmm_bind_default_user: {
    name: "vulcan_vmm_bind_default_user",
    label: "Vulcan Bind Default User",
    fallbackDescription:
      "Resolve or create one VMM user, then persist its real numeric user id as the shared default OpenClaw binding.",
    fallbackSchema: VmmBindDefaultUserSchema,
    async execute(context, rawParams) {
      const { params } = context;
      const input = readBindDefaultUserParams(rawParams);
      if (!input) {
        return errorToolResult("userRef must be a non-empty string.");
      }
      const runtime = context.getRemoteRuntime();
      const user = await runtime.client.resolveVmmUser({
        context: runtime.context,
        userRef: input.userRef,
        confirmCreate: input.createIfMissing,
      });
      if (!user.userId.trim()) {
        return errorToolResult(
          user.message.trim() || `Failed to resolve VMM user from ${JSON.stringify(input.userRef)}.`,
          { user },
        );
      }
      await setPersistedDefaultUserId(user.userId);
      const effective = await resolveEffectiveVulcanBindings(params.config, params.ctx.agentId);
      return jsonToolResult(
        {
          action: "bind-default-user",
          user,
          defaultUserId: effective.defaultUserId,
          effectiveUserId: effective.effectiveUserId,
          storePath: effective.storePath,
        } as unknown as JsonValue,
        {
          effective,
          user,
        },
      );
    },
  },
  vulcan_vmm_list_projects: {
    name: "vulcan_vmm_list_projects",
    label: "Vulcan VMM Projects",
    fallbackDescription:
      "List durable VMM Team/Space/Project entries so you can choose one real project id or canonical path for OpenClaw binding.",
    fallbackSchema: VmmListProjectsSchema,
    async execute(context) {
      const runtime = context.getRemoteRuntime();
      const response = await runtime.client.listVmmProjects(runtime.context);
      return jsonToolResult(
        {
          total: response.projects.length,
          projects: response.projects,
          traceId: response.traceId ?? "",
        } as unknown as JsonValue,
        response,
      );
    },
  },
  vulcan_vmm_bind_default_project: {
    name: "vulcan_vmm_bind_default_project",
    label: "Vulcan Bind Default Project",
    fallbackDescription:
      "Resolve or create one VMM project, then persist its real numeric project id as the shared default OpenClaw project binding.",
    fallbackSchema: VmmBindProjectSchema,
    async execute(context, rawParams) {
      const { params } = context;
      const input = readBindProjectParams(rawParams);
      if (!input) {
        return errorToolResult("projectRef must be a non-empty string.");
      }
      const runtime = context.getRemoteRuntime();
      const project = await resolveProjectBindingTarget(
        runtime.client,
        runtime.context,
        input.projectRef,
        input.createIfMissing,
      );
      await setPersistedDefaultProjectId(project.projectId);
      const effective = await resolveEffectiveVulcanBindings(params.config, params.ctx.agentId);
      return jsonToolResult(
        {
          action: "bind-default-project",
          project,
          defaultProjectId: effective.defaultProjectId,
          effectiveProjectId: effective.effectiveProjectId,
          storePath: effective.storePath,
        } as unknown as JsonValue,
        {
          effective,
          project,
        },
      );
    },
  },
  vulcan_vmm_bind_agent_project: {
    name: "vulcan_vmm_bind_agent_project",
    label: "Vulcan Bind Agent Project",
    fallbackDescription:
      "Bind one OpenClaw main agent to a dedicated VMM project id. Omit agentId to bind the current trusted agent.",
    fallbackSchema: VmmBindAgentProjectSchema,
    async execute(context, rawParams) {
      const { params } = context;
      const input = readBindAgentProjectParams(rawParams);
      if (!input) {
        return errorToolResult("projectRef must be a non-empty string.");
      }
      const targetAgentId = resolveTargetAgentId(input.agentId, params.ctx.agentId);
      const runtime = context.getRemoteRuntime();
      const project = await resolveProjectBindingTarget(
        runtime.client,
        runtime.context,
        input.projectRef,
        input.createIfMissing,
      );
      await setPersistedAgentProjectId(targetAgentId, project.projectId);
      const effective = await resolveEffectiveVulcanBindings(params.config, targetAgentId);
      return jsonToolResult(
        {
          action: "bind-agent-project",
          agentId: targetAgentId,
          project,
          effectiveProjectId: effective.effectiveProjectId,
          projectSource: effective.projectSource,
          storePath: effective.storePath,
        } as unknown as JsonValue,
        {
          effective,
          project,
        },
      );
    },
  },
  vulcan_vmm_clear_agent_project: {
    name: "vulcan_vmm_clear_agent_project",
    label: "Vulcan Clear Agent Project",
    fallbackDescription:
      "Clear one agent-specific VMM project override so the runtime falls back to the shared default project binding.",
    fallbackSchema: VmmClearAgentProjectSchema,
    async execute(context, rawParams) {
      const { params } = context;
      const input = asRecord(rawParams);
      const targetAgentId = resolveTargetAgentId(readOptionalString(input.agentId), params.ctx.agentId);
      await clearPersistedAgentProjectId(targetAgentId);
      const effective = await resolveEffectiveVulcanBindings(params.config, targetAgentId);
      return jsonToolResult(
        {
          action: "clear-agent-project",
          agentId: targetAgentId,
          effectiveProjectId: effective.effectiveProjectId,
          projectSource: effective.projectSource,
          defaultProjectId: effective.defaultProjectId,
          storePath: effective.storePath,
        } as JsonValue,
        { effective },
      );
    },
  },
};

// listVulcanBindingToolNames exposes the stable binding/admin registration order to plugin entrypoints.
// listVulcanBindingToolNames 向插件入口暴露稳定的绑定/管理工具注册顺序。
export function listVulcanBindingToolNames(): BindingToolName[] {
  const generatedNames = listGeneratedBindingDescriptors()
    .map((descriptor) => descriptor.name)
    .filter(isBindingToolName);
  const mergedNames = [...generatedNames];
  for (const fallbackName of VULCAN_BINDING_TOOL_NAMES) {
    if (!mergedNames.includes(fallbackName)) {
      mergedNames.push(fallbackName);
    }
  }
  return mergedNames;
}

// createVulcanBindingTool builds one binding/admin tool from the shared registry, synced descriptors, and host-local execution body.
// createVulcanBindingTool 通过共享注册表、同步 descriptor 与宿主本地执行逻辑构建单个绑定/管理工具。
export function createVulcanBindingTool(
  toolName: BindingToolName,
  params: BindingToolParams,
): AnyAgentTool | null {
  if (!params.config.enabled || !params.config.memory.enabled) {
    return null;
  }
  const definition = VULCAN_BINDING_TOOL_DEFINITIONS[toolName];
  const descriptor = resolveBindingToolDescriptor(definition);
  const executionMode = resolveBindingExecutionMode(descriptor);
  return {
    name: definition.name,
    label: definition.label,
    description: descriptor.description,
    parameters: descriptor.inputSchema,
    async execute(_toolCallId, rawParams) {
      try {
        return await definition.execute(
          createBindingToolExecutionContext({
            params,
            descriptor,
            executionMode,
          }),
          rawParams,
        );
      } catch (error) {
        params.api.logger.warn?.(`vulcan-memory: ${definition.name} failed: ${String(error)}`);
        return errorToolResult(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

// createVulcanBindingGetTool preserves the existing factory export while delegating to the registry-based builder.
// createVulcanBindingGetTool 保留现有工厂导出，同时转交给基于注册表的构建器。
export function createVulcanBindingGetTool(params: BindingToolParams): AnyAgentTool | null {
  return createVulcanBindingTool("vulcan_vmm_get_bindings", params);
}

// createVulcanListUsersTool preserves the existing factory export while delegating to the registry-based builder.
// createVulcanListUsersTool 保留现有工厂导出，同时转交给基于注册表的构建器。
export function createVulcanListUsersTool(params: BindingToolParams): AnyAgentTool | null {
  return createVulcanBindingTool("vulcan_vmm_list_users", params);
}

// createVulcanBindDefaultUserTool preserves the existing factory export while delegating to the registry-based builder.
// createVulcanBindDefaultUserTool 保留现有工厂导出，同时转交给基于注册表的构建器。
export function createVulcanBindDefaultUserTool(params: BindingToolParams): AnyAgentTool | null {
  return createVulcanBindingTool("vulcan_vmm_bind_default_user", params);
}

// createVulcanListProjectsTool preserves the existing factory export while delegating to the registry-based builder.
// createVulcanListProjectsTool 保留现有工厂导出，同时转交给基于注册表的构建器。
export function createVulcanListProjectsTool(params: BindingToolParams): AnyAgentTool | null {
  return createVulcanBindingTool("vulcan_vmm_list_projects", params);
}

// createVulcanBindDefaultProjectTool preserves the existing factory export while delegating to the registry-based builder.
// createVulcanBindDefaultProjectTool 保留现有工厂导出，同时转交给基于注册表的构建器。
export function createVulcanBindDefaultProjectTool(params: BindingToolParams): AnyAgentTool | null {
  return createVulcanBindingTool("vulcan_vmm_bind_default_project", params);
}

// createVulcanBindAgentProjectTool preserves the existing factory export while delegating to the registry-based builder.
// createVulcanBindAgentProjectTool 保留现有工厂导出，同时转交给基于注册表的构建器。
export function createVulcanBindAgentProjectTool(params: BindingToolParams): AnyAgentTool | null {
  return createVulcanBindingTool("vulcan_vmm_bind_agent_project", params);
}

// createVulcanClearAgentProjectTool preserves the existing factory export while delegating to the registry-based builder.
// createVulcanClearAgentProjectTool 保留现有工厂导出，同时转交给基于注册表的构建器。
export function createVulcanClearAgentProjectTool(params: BindingToolParams): AnyAgentTool | null {
  return createVulcanBindingTool("vulcan_vmm_clear_agent_project", params);
}

// createBindingToolExecutionContext binds descriptor annotations and lazy remote runtime creation to one execution lifecycle.
// createBindingToolExecutionContext 将 descriptor 注解与惰性远端运行时创建绑定到单次执行生命周期。
function createBindingToolExecutionContext(args: {
  params: BindingToolParams;
  descriptor: VulcanToolDescriptor;
  executionMode: BindingToolExecutionMode;
}): BindingToolExecutionContext {
  let remoteRuntime: BindingToolRemoteRuntime | undefined;
  return {
    params: args.params,
    descriptor: args.descriptor,
    executionMode: args.executionMode,
    getRemoteRuntime() {
      if (args.executionMode === "local") {
        throw new Error(
          `Tool ${args.descriptor.name} is marked as local-only by vulcan-host and cannot request a remote runtime.`,
        );
      }
      remoteRuntime ??= buildBindingToolRemoteRuntime(args.params);
      return remoteRuntime;
    },
  };
}

// buildBindingToolRemoteRuntime constructs the shared vulcan-host client/context pair used by remote and hybrid binding tools.
// buildBindingToolRemoteRuntime 构建远端与混合型绑定工具共用的 vulcan-host client/context 对。
function buildBindingToolRemoteRuntime(params: BindingToolParams): BindingToolRemoteRuntime {
  return {
    client: createVulcanHostClient(params.config),
    context: buildToolHostContext(params.ctx, params.config),
  };
}

// readBindDefaultUserParams validates the default-user binding input while preserving the explicit creation policy.
// readBindDefaultUserParams 校验默认用户绑定输入，并保留显式创建策略。
function readBindDefaultUserParams(
  value: unknown,
): { userRef: string; createIfMissing: boolean } | null {
  const record = asRecord(value);
  const userRef = readOptionalString(record.userRef);
  if (!userRef) {
    return null;
  }
  return {
    userRef,
    createIfMissing: record.createIfMissing === true,
  };
}

// readBindProjectParams validates the default-project binding input while preserving the explicit creation policy.
// readBindProjectParams 校验默认项目绑定输入，并保留显式创建策略。
function readBindProjectParams(
  value: unknown,
): { projectRef: string; createIfMissing: boolean } | null {
  const record = asRecord(value);
  const projectRef = readOptionalString(record.projectRef);
  if (!projectRef) {
    return null;
  }
  return {
    projectRef,
    createIfMissing: record.createIfMissing === true,
  };
}

// readBindAgentProjectParams validates the agent-project binding input while keeping agent selection optional for current-agent flows.
// readBindAgentProjectParams 校验 agent 项目绑定输入，并保留“当前 agent 默认生效”的可选目标语义。
function readBindAgentProjectParams(
  value: unknown,
): { agentId?: string | undefined; projectRef: string; createIfMissing: boolean } | null {
  const record = asRecord(value);
  const projectRef = readOptionalString(record.projectRef);
  if (!projectRef) {
    return null;
  }
  return {
    agentId: readOptionalString(record.agentId),
    projectRef,
    createIfMissing: record.createIfMissing === true,
  };
}

// resolveProjectBindingTarget resolves an existing project id or creates a canonical Team/Space/Project path when the caller explicitly allows it.
// resolveProjectBindingTarget 负责解析现有项目 ID，或在调用方显式允许时创建标准 Team/Space/Project 路径。
async function resolveProjectBindingTarget(
  client: VulcanHostClient,
  context: VulcanHostContext,
  projectRef: string,
  createIfMissing: boolean,
): Promise<VulcanVmmResolvedProject> {
  const trimmedProjectRef = projectRef.trim();
  if (!trimmedProjectRef) {
    throw new Error("projectRef must be a non-empty string.");
  }
  if (createIfMissing) {
    if (!trimmedProjectRef.includes("/")) {
      throw new Error(
        "Creating a project requires one canonical Team/Space/Project path. Numeric project ids can only resolve existing projects.",
      );
    }
    const createdProject = await client.ensureVmmProject({
      context,
      projectPath: trimmedProjectRef,
      confirmCreate: true,
    });
    if (!createdProject.projectId.trim()) {
      throw new Error(
        createdProject.message.trim() || `Failed to resolve or create project ${JSON.stringify(trimmedProjectRef)}.`,
      );
    }
    return createdProject;
  }
  const resolvedProject = await client.resolveVmmProject({
    context,
    projectRef: trimmedProjectRef,
  });
  if (!resolvedProject.projectId.trim()) {
    throw new Error(
      resolvedProject.message.trim() || `Failed to resolve existing project ${JSON.stringify(trimmedProjectRef)}.`,
    );
  }
  return resolvedProject;
}

// resolveTargetAgentId chooses an explicit agent id or falls back to the trusted current agent id from tool context.
// resolveTargetAgentId 负责优先选择显式传入的 agent id，否则回退到工具上下文中的受信任当前 agent id。
function resolveTargetAgentId(
  explicitAgentId: string | undefined,
  contextAgentId: string | undefined,
): string {
  const resolvedAgentId = explicitAgentId?.trim() || contextAgentId?.trim();
  if (!resolvedAgentId) {
    throw new Error("agentId is required because the current OpenClaw tool context does not expose one.");
  }
  return resolvedAgentId;
}

// readOptionalString preserves only non-empty trimmed strings from loose tool input objects.
// readOptionalString 只保留宽松工具输入对象中的非空裁剪字符串。
function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// asRecord safely narrows unknown tool input into a plain object shell for field extraction.
// asRecord 将未知工具输入安全收窄为普通对象外壳，便于提取字段。
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// findGeneratedDescriptor locates one host-synchronized binding/admin descriptor by exact tool name.
// findGeneratedDescriptor 按精确工具名定位一条宿主同步下来的绑定或管理 descriptor。
function findGeneratedDescriptor(toolName: string): VulcanToolDescriptor | undefined {
  return GENERATED_VMM_TOOLS.find((descriptor) => descriptor.name === toolName);
}

// listGeneratedBindingDescriptors keeps only the host-synchronized descriptors that belong to the VMM binding/admin tool group.
// listGeneratedBindingDescriptors 只保留属于 VMM 绑定/管理工具组的宿主同步 descriptor。
function listGeneratedBindingDescriptors(): VulcanToolDescriptor[] {
  return GENERATED_VMM_TOOLS.filter((descriptor) => readToolGroup(descriptor) === "vmm-binding");
}

// resolveBindingToolDescriptor prefers one synchronized binding/admin descriptor while falling back to the local bootstrap contract.
// resolveBindingToolDescriptor 优先使用同步下来的绑定/管理 descriptor，并在缺失时回退到本地引导契约。
function resolveBindingToolDescriptor(definition: BindingToolDefinition): VulcanToolDescriptor {
  return (
    findGeneratedDescriptor(definition.name) ?? {
      name: definition.name,
      description: definition.fallbackDescription,
      inputSchema: definition.fallbackSchema as unknown as JsonObject,
    }
  );
}

// resolveBindingExecutionMode reads the synchronized execution boundary so the host only allocates remote runtime when the contract allows it.
// resolveBindingExecutionMode 读取同步执行边界，让宿主仅在契约允许时才分配远端运行时。
function resolveBindingExecutionMode(descriptor: VulcanToolDescriptor): BindingToolExecutionMode {
  const mode = readAnnotationString(descriptor, "execution_mode");
  return mode === "local" || mode === "remote" || mode === "hybrid" ? mode : "hybrid";
}

// readToolGroup extracts the synchronized tool-group annotation used to separate binding/admin descriptors from memory descriptors.
// readToolGroup 提取同步下来的工具分组注解，用于区分绑定/管理 descriptor 与记忆 descriptor。
function readToolGroup(descriptor: VulcanToolDescriptor): string | undefined {
  return readAnnotationString(descriptor, "tool_group");
}

// readAnnotationString keeps only string annotations from synchronized descriptors.
// readAnnotationString 只保留同步 descriptor 中的字符串注解值。
function readAnnotationString(descriptor: VulcanToolDescriptor, key: string): string | undefined {
  const value = descriptor.annotations?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// isBindingToolName narrows a loose descriptor name back into one known binding/admin tool id understood by this host adapter.
// isBindingToolName 将宽松的 descriptor 名称收窄为当前宿主适配器理解的绑定/管理工具 ID。
function isBindingToolName(value: string): value is BindingToolName {
  return value in VULCAN_BINDING_TOOL_DEFINITIONS;
}
