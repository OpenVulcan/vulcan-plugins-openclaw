// Binding-management tools for hosts that do not provide a native TUI like OpenCode.
// 本文件负责为没有原生 TUI 的宿主提供绑定管理工具，例如 OpenClaw。

import {
  buildVulcanCapabilityUnavailableMessage,
  buildToolHostContext,
  clearPersistedAgentProjectId,
  createVulcanHostClient,
  ensureVulcanHostReconnectScheduled,
  errorToolResult,
  isVulcanHostConnectionUnavailable,
  isVulcanHostTransportError,
  jsonToolResult,
  loadPersistedVulcanBindingState,
  peekVulcanHostConnectionSnapshot,
  resolveEffectiveVulcanBindings,
  setPersistedAgentProjectId,
  setPersistedDefaultProjectId,
  setPersistedDefaultUserId,
  shouldExposeVulcanToolSurface,
  type JsonObject,
  type JsonValue,
  type ResolvedVulcanConfig,
  type VulcanHostClient,
  type VulcanHostContext,
  type VulcanToolDescriptor,
  type VulcanVmmResolvedProject,
} from "@vulcan-plugins-openclaw/shared";
import type {
  AgentToolResult,
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { GENERATED_VMM_TOOLS } from "./generated/vmm-tools.generated.js";

// BindingToolParams groups the shared dependencies required by the consolidated binding tool.
// BindingToolParams 汇总聚合绑定工具所需的共享依赖。
interface BindingToolParams {
  api: OpenClawPluginApi;
  config: ResolvedVulcanConfig;
  ctx: OpenClawPluginToolContext;
}

// BindingToolExecutionMode declares whether the host should expect local-only, remote-only, or hybrid execution.
// BindingToolExecutionMode 声明宿主应预期本地、远端还是混合执行模式。
type BindingToolExecutionMode = "local" | "remote" | "hybrid";

// BindingToolName keeps one stable compact tool id for no-TUI hosts.
// BindingToolName 为无 TUI 宿主保留一个稳定的精简工具标识。
export type BindingToolName = "vulcan_bind";

// BindAction enumerates the high-level operations supported by the compact binding surface.
// BindAction 枚举精简绑定表面支持的高层操作。
type BindAction = "inspect" | "list" | "bind" | "clear";

// BindResource enumerates the durable entities that the compact binding surface can inspect or mutate.
// BindResource 枚举精简绑定表面可查看或修改的长期实体。
type BindResource = "bindings" | "user" | "project";

// BindScope distinguishes shared default bindings from one main-agent project override.
// BindScope 区分共享默认绑定与单个主 agent 的项目覆盖。
type BindScope = "global" | "agent";

// BindCommandInput captures one validated compact binding command after loose tool input has been normalized.
// BindCommandInput 保存宽松工具输入在归一化后的单条精简绑定命令。
interface BindCommandInput {
  action: BindAction;
  resource: BindResource;
  scope?: BindScope | undefined;
  ref?: string | undefined;
  agentId?: string | undefined;
  createIfMissing: boolean;
}

// BindingToolRemoteRuntime reuses one lazily built host client/context pair for tool branches that must talk to vulcan-host.
// BindingToolRemoteRuntime 复用一份按需构造的 host client/context 对，用于必须访问 vulcan-host 的分支。
interface BindingToolRemoteRuntime {
  client: VulcanHostClient;
  context: VulcanHostContext;
}

// BindingToolExecutionContext combines host-local dependencies with the synchronized descriptor contract used by the compact tool.
// BindingToolExecutionContext 组合精简工具执行所需的宿主本地依赖与同步 descriptor 契约。
interface BindingToolExecutionContext {
  params: BindingToolParams;
  descriptor: VulcanToolDescriptor;
  executionMode: BindingToolExecutionMode;
  getRemoteRuntime: () => BindingToolRemoteRuntime;
}

// VULCAN_BIND_TOOL_NAME is the single compact tool id exposed to OpenClaw after binding-tool consolidation.
// VULCAN_BIND_TOOL_NAME 是绑定工具合并后对 OpenClaw 暴露的单一精简工具标识。
const VULCAN_BIND_TOOL_NAME: BindingToolName = "vulcan_bind";

// VULCAN_BINDING_TOOL_GROUP keeps descriptor filtering aligned with the grpc-side contract.
// VULCAN_BINDING_TOOL_GROUP 保持 descriptor 过滤与 grpc 侧契约一致。
const VULCAN_BINDING_TOOL_GROUP = "vmm-binding";

// VULCAN_BINDING_TOOL_VISIBILITY keeps registration limited to admin-style binding controls.
// VULCAN_BINDING_TOOL_VISIBILITY 将注册范围限制在管理型绑定控制面。
const VULCAN_BINDING_TOOL_VISIBILITY = "admin";

// VULCAN_BINDING_CONSOLIDATED_SURFACE selects the compact host-facing descriptor instead of the legacy per-action tools.
// VULCAN_BINDING_CONSOLIDATED_SURFACE 选择精简宿主 descriptor，而不是旧的逐动作工具。
const VULCAN_BINDING_CONSOLIDATED_SURFACE = "host-binding-consolidated";

// VulcanBindSchema keeps the local fallback contract aligned with the grpc-side compact descriptor.
// VulcanBindSchema 让本地回退契约与 grpc 侧的精简 descriptor 保持一致。
const VulcanBindSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: ["inspect", "list", "bind", "clear"],
      description:
        "Binding operation. inspect returns the current effective binding state, list returns durable VMM identities, bind persists one host binding target, and clear removes one per-agent project override.",
    },
    resource: {
      type: "string",
      enum: ["bindings", "user", "project"],
      description:
        "Binding resource. Use bindings with inspect, user or project with list/bind, and project with clear.",
    },
    scope: {
      type: "string",
      enum: ["global", "agent"],
      description:
        "Binding scope. global updates the shared default host binding, while agent updates or clears one main-agent project override.",
    },
    ref: {
      type: "string",
      description:
        "Existing numeric user_id/project_id, durable user name, or canonical Team/Space/Project path depending on the selected resource.",
    },
    agentId: {
      type: "string",
      description:
        "Optional host main-agent id. Omit to reuse the current trusted main-agent context when the host provides one.",
    },
    createIfMissing: {
      type: "boolean",
      description:
        "Whether the host may ask VMM to create a missing durable user name or canonical Team/Space/Project path while binding.",
    },
  },
  required: ["action", "resource"],
} as const;

// VULCAN_BIND_FALLBACK_DESCRIPTION explains the compact binding surface when the grpc descriptor has not been synchronized yet.
// VULCAN_BIND_FALLBACK_DESCRIPTION 说明在 grpc descriptor 尚未同步时的精简绑定表面。
const VULCAN_BIND_FALLBACK_DESCRIPTION =
  "Inspect, list, bind, or clear host-level VMM user/project bindings through one compact management surface. Use this when the host does not have an OpenCode-style TUI and you still need to choose a shared default user_id/project_id, inspect the active binding state, or assign one main agent to a dedicated project.";

// BINDING_UNAVAILABLE_MESSAGE keeps one stable unavailable text for compact binding operations that require a live vulcan-host connection.
// BINDING_UNAVAILABLE_MESSAGE 为需要实时 vulcan-host 连接的精简绑定操作保留一条稳定的不可用提示文本。
const BINDING_UNAVAILABLE_MESSAGE = buildVulcanCapabilityUnavailableMessage("binding");

// listVulcanBindingToolNames exposes the compact binding tool name, preferring the synchronized consolidated descriptor when available.
// listVulcanBindingToolNames 暴露精简绑定工具名称，并在可用时优先采用同步下来的聚合 descriptor。
export function listVulcanBindingToolNames(): BindingToolName[] {
  const generatedNames = listGeneratedBindingDescriptors()
    .map((descriptor) => descriptor.name)
    .filter(isBindingToolName);
  return generatedNames.length > 0 ? generatedNames : [VULCAN_BIND_TOOL_NAME];
}

// createVulcanBindingTool builds the single compact binding tool from the synchronized descriptor plus host-local persistence logic.
// createVulcanBindingTool 通过同步 descriptor 与宿主本地持久化逻辑构建单一精简绑定工具。
export function createVulcanBindingTool(
  toolName: BindingToolName,
  params: BindingToolParams,
): AnyAgentTool | null {
  if (!params.config.enabled || !params.config.memory.enabled) {
    return null;
  }
  if (!shouldExposeVulcanToolSurface({
    runtimeConfig: resolveToolRuntimeConfig(params.ctx),
    agentId: params.ctx.agentId,
    surface: "binding-admin",
  })) {
    return null;
  }
  const descriptor = resolveBindingToolDescriptor(toolName);
  const executionMode = resolveBindingExecutionMode(descriptor);
  return {
    name: toolName,
    label: "Vulcan Bind",
    description: descriptor.description,
    parameters: descriptor.inputSchema,
    async execute(_toolCallId, rawParams) {
      try {
        return await executeVulcanBindTool(
          createBindingToolExecutionContext({
            params,
            descriptor,
            executionMode,
          }),
          rawParams,
        );
      } catch (error) {
        params.api.logger.warn?.(`vulcan-memory: ${toolName} failed: ${String(error)}`);
        if (isVulcanHostTransportError(error)) {
          ensureVulcanHostReconnectScheduled(params.config, { logger: params.api.logger, force: true });
          return errorToolResult(BINDING_UNAVAILABLE_MESSAGE);
        }
        return errorToolResult(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

// executeVulcanBindTool routes the compact command into one focused host-local or hybrid binding action.
// executeVulcanBindTool 将精简命令路由到单个聚焦的宿主本地或混合绑定动作。
async function executeVulcanBindTool(
  context: BindingToolExecutionContext,
  rawParams: unknown,
): Promise<AgentToolResult> {
  const input = readBindCommandInput(rawParams);
  if (!input) {
    return errorToolResult("action and resource must be valid non-empty strings.");
  }

  // Route read-only inspection first so hosts can always introspect active bindings before mutating them.
  // 先路由只读查看分支，让宿主总能在修改前先检查当前绑定状态。
  if (input.action === "inspect") {
    return executeInspectBindings(context, input);
  }

  // Route durable identity listing second so operators can choose exact ids before binding.
  // 接着路由长期实体列表分支，让操作者能先选定精确 ID 再进行绑定。
  if (input.action === "list") {
    return executeListCommand(context, input);
  }

  // Route binding mutations next, while keeping unsupported combinations explicit instead of guessing intent.
  // 再路由绑定修改分支，并显式拒绝不受支持的组合，避免宿主擅自猜测意图。
  if (input.action === "bind") {
    return executeBindCommand(context, input);
  }

  // Route clear operations last because current OpenClaw binding state only supports clearing one per-agent project override.
  // 最后路由清除操作，因为当前 OpenClaw 绑定状态只支持清除按 agent 的项目覆盖。
  return executeClearCommand(context, input);
}

// executeInspectBindings returns the effective binding state for the current or explicitly selected main agent.
// executeInspectBindings 返回当前或显式选定主 agent 的有效绑定状态。
async function executeInspectBindings(
  context: BindingToolExecutionContext,
  input: BindCommandInput,
): Promise<AgentToolResult> {
  if (input.resource !== "bindings") {
    return errorToolResult("inspect currently supports only resource=bindings.");
  }
  const targetAgentId = input.agentId ?? context.params.ctx.agentId;
  const effective = await resolveEffectiveVulcanBindings(context.params.config, targetAgentId);
  const persisted = await loadPersistedVulcanBindingState();
  return jsonToolResult(
    {
      action: "inspect",
      resource: "bindings",
      storePath: effective.storePath,
      currentAgentId: targetAgentId ?? "",
      configuredDefaultUserId: context.params.config.bindings.defaultUserId,
      configuredDefaultProjectId: context.params.config.bindings.defaultProjectId,
      defaultUserId: effective.defaultUserId,
      defaultProjectId: effective.defaultProjectId,
      effectiveUserId: effective.effectiveUserId,
      effectiveProjectId: effective.effectiveProjectId,
      agentProjectId: effective.agentProjectId ?? "",
      projectSource: effective.projectSource,
      configuredAgentProjects: context.params.config.bindings.agentProjects,
      persistedAgentProjects: persisted.agentProjects,
    } as JsonValue,
    {
      effective,
      persisted,
    },
  );
}

// executeListCommand returns durable VMM users or projects so the caller can choose one exact binding target.
// executeListCommand 返回长期 VMM 用户或项目列表，让调用方可以选择精确绑定目标。
async function executeListCommand(
  context: BindingToolExecutionContext,
  input: BindCommandInput,
): Promise<AgentToolResult> {
  if (input.resource === "user") {
    const runtime = context.getRemoteRuntime();
    const response = await runtime.client.listVmmUsers(runtime.context);
    return jsonToolResult(
      {
        action: "list",
        resource: "user",
        total: response.users.length,
        users: response.users,
        traceId: response.traceId ?? "",
      } as unknown as JsonValue,
      response,
    );
  }
  if (input.resource === "project") {
    const runtime = context.getRemoteRuntime();
    const response = await runtime.client.listVmmProjects(runtime.context);
    return jsonToolResult(
      {
        action: "list",
        resource: "project",
        total: response.projects.length,
        projects: response.projects,
        traceId: response.traceId ?? "",
      } as unknown as JsonValue,
      response,
    );
  }
  return errorToolResult("list supports only resource=user or resource=project.");
}

// executeBindCommand applies one shared-default or per-agent binding mutation after validating the compact command shape.
// executeBindCommand 在校验精简命令形态后执行共享默认或按 agent 的绑定修改。
async function executeBindCommand(
  context: BindingToolExecutionContext,
  input: BindCommandInput,
): Promise<AgentToolResult> {
  if (!input.ref) {
    return errorToolResult("bind requires one non-empty ref.");
  }

  // Bind user only supports the shared default binding because current OpenClaw runtime does not keep per-agent user overrides.
  // 用户绑定只支持共享默认绑定，因为当前 OpenClaw 运行时不维护按 agent 的用户覆盖。
  if (input.resource === "user") {
    if (input.scope === "agent") {
      return errorToolResult("user binding does not support scope=agent. Use scope=global or omit scope.");
    }
    const runtime = context.getRemoteRuntime();
    const user = await runtime.client.resolveVmmUser({
      context: runtime.context,
      userRef: input.ref,
      confirmCreate: input.createIfMissing,
    });
    if (!user.userId.trim()) {
      return errorToolResult(
        user.message.trim() || `Failed to resolve VMM user from ${JSON.stringify(input.ref)}.`,
        { user },
      );
    }
    await setPersistedDefaultUserId(user.userId);
    const effective = await resolveEffectiveVulcanBindings(
      context.params.config,
      context.params.ctx.agentId,
    );
    return jsonToolResult(
      {
        action: "bind",
        resource: "user",
        scope: "global",
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
  }

  if (input.resource !== "project") {
    return errorToolResult("bind supports only resource=user or resource=project.");
  }

  const runtime = context.getRemoteRuntime();
  const project = await resolveProjectBindingTarget(
    runtime.client,
    runtime.context,
    input.ref,
    input.createIfMissing,
  );

  // Route project bindings by scope so one tool can cover both the shared default project and one per-agent override.
  // 按 scope 路由项目绑定，让单个工具同时覆盖共享默认项目与按 agent 的项目覆盖。
  if (input.scope === "agent") {
    const targetAgentId = resolveTargetAgentId(input.agentId, context.params.ctx.agentId);
    await setPersistedAgentProjectId(targetAgentId, project.projectId);
    const effective = await resolveEffectiveVulcanBindings(context.params.config, targetAgentId);
    return jsonToolResult(
      {
        action: "bind",
        resource: "project",
        scope: "agent",
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
  }

  await setPersistedDefaultProjectId(project.projectId);
  const effective = await resolveEffectiveVulcanBindings(
    context.params.config,
    context.params.ctx.agentId,
  );
  return jsonToolResult(
    {
      action: "bind",
      resource: "project",
      scope: "global",
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
}

// executeClearCommand clears one per-agent project override so that the runtime falls back to the shared default project again.
// executeClearCommand 清除按 agent 的项目覆盖，让运行时重新回退到共享默认项目。
async function executeClearCommand(
  context: BindingToolExecutionContext,
  input: BindCommandInput,
): Promise<AgentToolResult> {
  if (input.resource !== "project") {
    return errorToolResult("clear currently supports only resource=project.");
  }
  if (input.scope !== "agent") {
    return errorToolResult("clear currently supports only scope=agent for project overrides.");
  }
  const targetAgentId = resolveTargetAgentId(input.agentId, context.params.ctx.agentId);
  await clearPersistedAgentProjectId(targetAgentId);
  const effective = await resolveEffectiveVulcanBindings(context.params.config, targetAgentId);
  return jsonToolResult(
    {
      action: "clear",
      resource: "project",
      scope: "agent",
      agentId: targetAgentId,
      effectiveProjectId: effective.effectiveProjectId,
      projectSource: effective.projectSource,
      defaultProjectId: effective.defaultProjectId,
      storePath: effective.storePath,
    } as JsonValue,
    { effective },
  );
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

// buildBindingToolRemoteRuntime constructs the shared vulcan-host client/context pair used by remote and hybrid binding branches.
// buildBindingToolRemoteRuntime 构建远端与混合型绑定分支共用的 vulcan-host client/context 对。
function buildBindingToolRemoteRuntime(params: BindingToolParams): BindingToolRemoteRuntime {
  if (isVulcanHostConnectionUnavailable(params.config)) {
    ensureVulcanHostReconnectScheduled(params.config, { logger: params.api.logger });
    params.api.logger.debug?.(
      `vulcan-memory: ${peekVulcanHostConnectionSnapshot(params.config).target} is reconnecting; binding remote runtime will fail fast.`,
    );
    throw new Error(BINDING_UNAVAILABLE_MESSAGE);
  }
  return {
    client: createVulcanHostClient(params.config),
    context: buildToolHostContext(params.ctx, params.config),
  };
}

// readBindCommandInput validates the compact command shape while preserving optional fields for the execution stage.
// readBindCommandInput 校验精简命令形态，并为执行阶段保留可选字段。
function readBindCommandInput(value: unknown): BindCommandInput | null {
  const record = asRecord(value);
  const action = readBindAction(record.action);
  const resource = readBindResource(record.resource);
  if (!action || !resource) {
    return null;
  }
  return {
    action,
    resource,
    scope: readBindScope(record.scope),
    ref: readOptionalString(record.ref),
    agentId: readOptionalString(record.agentId),
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

// listGeneratedBindingDescriptors keeps only the compact binding/admin descriptor synchronized from vulcan-host.
// listGeneratedBindingDescriptors 只保留从 vulcan-host 同步下来的精简绑定/管理 descriptor。
function listGeneratedBindingDescriptors(): VulcanToolDescriptor[] {
  return GENERATED_VMM_TOOLS.filter((descriptor) => {
    if (readToolGroup(descriptor) !== VULCAN_BINDING_TOOL_GROUP) {
      return false;
    }
    if (readVisibility(descriptor) !== VULCAN_BINDING_TOOL_VISIBILITY) {
      return false;
    }
    return readRegistrationSurface(descriptor) === VULCAN_BINDING_CONSOLIDATED_SURFACE;
  });
}

// resolveBindingToolDescriptor prefers one synchronized compact binding descriptor while keeping a local fallback for bootstrap scenarios.
// resolveBindingToolDescriptor 优先使用同步下来的精简绑定 descriptor，并在引导期保留本地回退。
function resolveBindingToolDescriptor(toolName: BindingToolName): VulcanToolDescriptor {
  return (
    GENERATED_VMM_TOOLS.find((descriptor) => descriptor.name === toolName) ?? {
      name: toolName,
      description: VULCAN_BIND_FALLBACK_DESCRIPTION,
      inputSchema: VulcanBindSchema as unknown as JsonObject,
    }
  );
}

// resolveBindingExecutionMode reads the synchronized execution boundary so the host only allocates a remote runtime when the contract allows it.
// resolveBindingExecutionMode 读取同步执行边界，让宿主仅在契约允许时才分配远端运行时。
function resolveBindingExecutionMode(descriptor: VulcanToolDescriptor): BindingToolExecutionMode {
  const mode = readAnnotationString(descriptor, "execution_mode");
  return mode === "local" || mode === "remote" || mode === "hybrid" ? mode : "hybrid";
}

// readToolGroup extracts the synchronized tool-group annotation used to separate binding descriptors from memory descriptors.
// readToolGroup 提取同步下来的工具分组注解，用于区分绑定 descriptor 与记忆 descriptor。
function readToolGroup(descriptor: VulcanToolDescriptor): string | undefined {
  return readAnnotationString(descriptor, "tool_group");
}

// readVisibility extracts the synchronized visibility hint used to keep non-admin descriptors out of this registration path.
// readVisibility 提取同步下来的可见性提示，用于把非 admin descriptor 排除在当前注册路径之外。
function readVisibility(descriptor: VulcanToolDescriptor): string | undefined {
  return readAnnotationString(descriptor, "visibility");
}

// readRegistrationSurface extracts the synchronized registration-surface hint used to pick the compact binding contract over legacy per-action tools.
// readRegistrationSurface 提取同步下来的注册面提示，用于优先选择精简绑定契约而不是旧的逐动作工具。
function readRegistrationSurface(descriptor: VulcanToolDescriptor): string | undefined {
  return readAnnotationString(descriptor, "registration_surface");
}

// readAnnotationString keeps only string annotations from synchronized descriptors.
// readAnnotationString 只保留同步 descriptor 中的字符串注解值。
function readAnnotationString(descriptor: VulcanToolDescriptor, key: string): string | undefined {
  const value = descriptor.annotations?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// readBindAction narrows one loose input value into a supported compact binding action.
// readBindAction 将宽松输入值收窄为受支持的精简绑定动作。
function readBindAction(value: unknown): BindAction | undefined {
  const normalized = readOptionalString(value);
  return normalized === "inspect" || normalized === "list" || normalized === "bind" || normalized === "clear"
    ? normalized
    : undefined;
}

// readBindResource narrows one loose input value into a supported compact binding resource.
// readBindResource 将宽松输入值收窄为受支持的精简绑定资源。
function readBindResource(value: unknown): BindResource | undefined {
  const normalized = readOptionalString(value);
  return normalized === "bindings" || normalized === "user" || normalized === "project"
    ? normalized
    : undefined;
}

// readBindScope narrows one loose input value into a supported compact binding scope.
// readBindScope 将宽松输入值收窄为受支持的精简绑定范围。
function readBindScope(value: unknown): BindScope | undefined {
  const normalized = readOptionalString(value);
  return normalized === "global" || normalized === "agent" ? normalized : undefined;
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

// isBindingToolName narrows a loose descriptor name back into the one compact binding tool id understood by this host adapter.
// isBindingToolName 将宽松 descriptor 名称收窄为当前宿主适配器理解的单一精简绑定工具 ID。
function isBindingToolName(value: string): value is BindingToolName {
  return value === VULCAN_BIND_TOOL_NAME;
}

// resolveToolRuntimeConfig prefers the eager runtime config and falls back to the lazy getter used by some OpenClaw tool paths.
// resolveToolRuntimeConfig 优先使用即时 runtime config，并回退到部分 OpenClaw 工具路径提供的惰性 getter。
function resolveToolRuntimeConfig(ctx: OpenClawPluginToolContext): unknown {
  return ctx.runtimeConfig ?? ctx.getRuntimeConfig?.();
}
