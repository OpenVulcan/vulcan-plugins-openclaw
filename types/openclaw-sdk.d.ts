// This file provides local TypeScript stubs for OpenClaw plugin SDK imports during standalone development.
// 本文件为独立开发阶段的 OpenClaw 插件 SDK 导入提供本地 TypeScript 类型桩。

declare module "openclaw/plugin-sdk/config-types" {
  // OpenClawConfig is intentionally loose here because the real host owns the full schema.
  // 这里刻意放宽 OpenClawConfig，因为完整配置结构由真实宿主负责。
  export type OpenClawConfig = Record<string, unknown>;
}

declare module "openclaw/plugin-sdk/plugin-entry" {
  import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";

  // JsonValue describes data that can cross plugin command, hook, and tool boundaries.
  // JsonValue 描述可跨插件命令、hook 与工具边界传递的数据。
  export type JsonValue =
    | null
    | boolean
    | number
    | string
    | JsonValue[]
    | { [key: string]: JsonValue };

  // AgentToolResult is the model-facing payload returned by OpenClaw agent tools.
  // AgentToolResult 是 OpenClaw agent 工具返回给模型的载荷。
  export type AgentToolResult = {
    content: Array<{ type: "text"; text: string } | { type: string; [key: string]: unknown }>;
    details?: unknown;
    isError?: boolean;
  };

  // AnyAgentTool is the minimal tool shape needed by this standalone plugin repository.
  // AnyAgentTool 是本独立插件仓库需要的最小工具形态。
  export type AnyAgentTool = {
    name: string;
    label?: string;
    description: string;
    parameters: unknown;
    ownerOnly?: boolean;
    displaySummary?: string;
    execute(
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
      onUpdate?: unknown,
    ): Promise<AgentToolResult> | AgentToolResult;
  };

  // OpenClawPluginToolContext carries trusted host context for a tool invocation.
  // OpenClawPluginToolContext 承载一次工具调用的受信任宿主上下文。
  export type OpenClawPluginToolContext = {
    config?: OpenClawConfig;
    runtimeConfig?: OpenClawConfig;
    getRuntimeConfig?: () => OpenClawConfig | undefined;
    workspaceDir?: string;
    agentDir?: string;
    agentId?: string;
    sessionKey?: string;
    sessionId?: string;
    messageChannel?: string;
    agentAccountId?: string;
    requesterSenderId?: string;
    senderIsOwner?: boolean;
    sandboxed?: boolean;
    deliveryContext?: unknown;
  };

  // OpenClawPluginToolFactory lazily creates tools for the active session context.
  // OpenClawPluginToolFactory 会基于当前会话上下文惰性创建工具。
  export type OpenClawPluginToolFactory = (
    ctx: OpenClawPluginToolContext,
  ) => AnyAgentTool | AnyAgentTool[] | null | undefined;

  // PluginCommandContext is the command invocation context exposed by OpenClaw.
  // PluginCommandContext 是 OpenClaw 暴露给命令调用的上下文。
  export type PluginCommandContext = {
    senderId?: string;
    channel: string;
    channelId?: string;
    isAuthorizedSender: boolean;
    senderIsOwner?: boolean;
    gatewayClientScopes?: string[];
    sessionKey?: string;
    sessionId?: string;
    sessionFile?: string;
    args?: string;
    commandBody: string;
    config: OpenClawConfig;
    from?: string;
    to?: string;
    accountId?: string;
    messageThreadId?: string | number;
    threadParentId?: string;
  };

  // PluginCommandResult is the reply payload returned by a plugin command.
  // PluginCommandResult 是插件命令返回的回复载荷。
  export type PluginCommandResult = {
    text?: string;
    markdown?: string;
    continueAgent?: boolean;
  };

  // OpenClawPluginCommandDefinition describes a slash/native command owned by the plugin.
  // OpenClawPluginCommandDefinition 描述插件拥有的 slash/native 命令。
  export type OpenClawPluginCommandDefinition = {
    name: string;
    description: string;
    acceptsArgs?: boolean;
    requireAuth?: boolean;
    requiredScopes?: string[];
    agentPromptGuidance?: readonly string[];
    handler(ctx: PluginCommandContext): PluginCommandResult | Promise<PluginCommandResult>;
  };

  // MemoryPluginCapability is the memory-slot capability exposed by a memory plugin.
  // MemoryPluginCapability 是 memory 插件暴露给记忆槽位的能力。
  export type MemoryPluginCapability = {
    promptBuilder?: (params: { availableTools: Set<string>; citationsMode?: string }) => string[];
    runtime?: {
      getMemorySearchManager(params: {
        cfg: OpenClawConfig;
        agentId: string;
        purpose?: "default" | "status" | "cli";
      }): Promise<{ manager: unknown | null; error?: string }>;
      resolveMemoryBackendConfig(params: {
        cfg: OpenClawConfig;
        agentId: string;
      }): { backend: "builtin" } | { backend: "qmd"; qmd?: { command?: string } };
      closeAllMemorySearchManagers?(): Promise<void>;
    };
  };

  // PluginLogger is the logger surface used by plugins without depending on OpenClaw internals.
  // PluginLogger 是插件使用的日志接口，避免依赖 OpenClaw 内部实现。
  export type PluginLogger = {
    debug?(message: string): void;
    info?(message: string): void;
    warn?(message: string): void;
    error?(message: string): void;
  };

  // OpenClawPluginServiceContext carries the logger and config surface shared by runtime services.
  // OpenClawPluginServiceContext 承载运行时后台服务共享的日志与配置上下文。
  export type OpenClawPluginServiceContext = {
    logger: PluginLogger;
    config?: OpenClawConfig;
    pluginConfig?: Record<string, unknown>;
  };

  // OpenClawPluginService is the minimal background-service contract used by standalone plugin development.
  // OpenClawPluginService 是独立插件开发阶段需要的最小后台服务契约。
  export type OpenClawPluginService = {
    id: string;
    start(ctx: OpenClawPluginServiceContext): void | Promise<void>;
    stop?(ctx: OpenClawPluginServiceContext): void | Promise<void>;
  };

  // OpenClawPluginApi is the host-provided registration API used by plugin entrypoints.
  // OpenClawPluginApi 是宿主提供给插件入口的注册 API。
  export type OpenClawPluginApi = {
    config?: OpenClawConfig;
    pluginConfig?: Record<string, unknown>;
    logger: PluginLogger;
    runtime?: {
      agent?: {
        resolveAgentWorkspaceDir?: (
          cfg: OpenClawConfig,
          agentId?: string,
        ) => string | undefined;
      };
      config?: {
        current?: () => OpenClawConfig;
      };
    };
    registerTool(
      tool: AnyAgentTool | OpenClawPluginToolFactory,
      options?: { name?: string; names?: string[]; optional?: boolean },
    ): void;
    registerCommand(command: OpenClawPluginCommandDefinition): void;
    registerMemoryCapability(capability: MemoryPluginCapability): void;
    registerService(service: OpenClawPluginService): void;
    on(
      hookName: string,
      handler: (event: unknown, ctx: Record<string, unknown>) => unknown | Promise<unknown>,
      options?: { priority?: number; timeoutMs?: number },
    ): void;
  };

  // OpenClawPluginDefinition is the object shape returned by definePluginEntry.
  // OpenClawPluginDefinition 是 definePluginEntry 返回的对象形态。
  export type OpenClawPluginDefinition = {
    id: string;
    name: string;
    description: string;
    kind?: string;
    configSchema?: unknown;
    register(api: OpenClawPluginApi): void;
  };

  // definePluginEntry marks an object as an OpenClaw plugin entrypoint.
  // definePluginEntry 将对象标记为 OpenClaw 插件入口。
  export function definePluginEntry(entry: OpenClawPluginDefinition): OpenClawPluginDefinition;
}
