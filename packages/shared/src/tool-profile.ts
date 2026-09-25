// OpenClaw tool-profile helpers for Vulcan plugin-side surface filtering.
// 本文件负责 OpenClaw 的工具档位解析与 Vulcan 插件侧表面过滤。

// VulcanOpenClawToolProfile mirrors the OpenClaw runtime tool-profile ids used by agents and global policy.
// VulcanOpenClawToolProfile 对齐 OpenClaw 运行时 agent 与全局策略使用的工具档位标识。
export type VulcanOpenClawToolProfile = "minimal" | "messaging" | "coding" | "full";

// VulcanToolSurface keeps one stable mapping vocabulary between OpenClaw profiles and Vulcan tool groups.
// VulcanToolSurface 保留一套稳定映射词汇，用来连接 OpenClaw 档位与 Vulcan 工具分组。
export type VulcanToolSurface =
  | "memory-native"
  | "memory-bridge"
  | "binding-admin"
  | "profile-adjust"
  | "luaskills";

// DEFAULT_VULCAN_TOOL_PROFILE keeps tool visibility fail-open for contexts that cannot provide runtime config yet.
// DEFAULT_VULCAN_TOOL_PROFILE 为暂时无法提供 runtime config 的上下文保留失败开放的默认可见性。
const DEFAULT_VULCAN_TOOL_PROFILE: VulcanOpenClawToolProfile = "full";

// resolveVulcanToolProfile reads the effective OpenClaw profile by honoring one agent override before falling back to the global tool profile.
// resolveVulcanToolProfile 会优先读取单个 agent 的工具档位覆盖，再回退到全局工具档位。
export function resolveVulcanToolProfile(
  runtimeConfig: unknown,
  agentId: string | undefined,
): VulcanOpenClawToolProfile {
  const root = asRecord(runtimeConfig);

  // Inspect one matching agent override first because OpenClaw resolves tools.profile per active agent when present.
  // 先检查命中的 agent 覆盖，因为 OpenClaw 在有值时会按当前 agent 解析 tools.profile。
  const agentProfile = resolveAgentToolProfile(root, agentId);
  if (agentProfile) {
    return agentProfile;
  }

  // Fall back to the shared global tools.profile so hosts without per-agent overrides still get deterministic surfaces.
  // 再回退到共享的全局 tools.profile，确保没有 per-agent 覆盖的宿主仍然得到确定性的工具表面。
  const globalProfile = readToolProfile(asRecord(root.tools).profile);
  return globalProfile ?? DEFAULT_VULCAN_TOOL_PROFILE;
}

// isVulcanToolSurfaceEnabled decides whether one Vulcan surface should be materialized for the effective OpenClaw profile.
// isVulcanToolSurfaceEnabled 用于判断某个 Vulcan 工具表面是否应当在当前 OpenClaw 档位下实体化。
export function isVulcanToolSurfaceEnabled(
  profile: VulcanOpenClawToolProfile,
  surface: VulcanToolSurface,
): boolean {
  switch (profile) {
    case "minimal":
      return false;
    case "messaging":
      return surface === "memory-native";
    case "coding":
      return (
        surface === "memory-native" ||
        surface === "binding-admin" ||
        surface === "profile-adjust" ||
        surface === "luaskills"
      );
    case "full":
      return true;
    default:
      return false;
  }
}

// shouldExposeVulcanToolSurface combines profile resolution and surface gating so plugin factories can stay declarative.
// shouldExposeVulcanToolSurface 组合档位解析与表面开关，让插件工厂保持声明式写法。
export function shouldExposeVulcanToolSurface(args: {
  runtimeConfig: unknown;
  agentId?: string | undefined;
  surface: VulcanToolSurface;
}): boolean {
  return isVulcanToolSurfaceEnabled(
    resolveVulcanToolProfile(args.runtimeConfig, args.agentId),
    args.surface,
  );
}

// resolveAgentToolProfile scans agents.list for one matching agent id and returns its tools.profile when configured.
// resolveAgentToolProfile 会扫描 agents.list 中命中的 agent，并返回其配置的 tools.profile。
function resolveAgentToolProfile(
  runtimeConfig: Record<string, unknown>,
  agentId: string | undefined,
): VulcanOpenClawToolProfile | undefined {
  const normalizedAgentId = agentId?.trim();
  if (!normalizedAgentId) {
    return undefined;
  }
  const agentEntries = readAgentList(runtimeConfig);
  for (const entry of agentEntries) {
    const id = readOptionalString(entry.id);
    if (id !== normalizedAgentId) {
      continue;
    }
    return readToolProfile(asRecord(entry.tools).profile);
  }
  return undefined;
}

// readAgentList keeps only plain-object entries so malformed runtime config does not crash plugin-side filtering.
// readAgentList 只保留普通对象条目，避免畸形 runtime config 导致插件侧过滤崩溃。
function readAgentList(runtimeConfig: Record<string, unknown>): Array<Record<string, unknown>> {
  const agents = asRecord(runtimeConfig.agents);
  const list = agents.list;
  if (!Array.isArray(list)) {
    return [];
  }
  return list
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry));
}

// readToolProfile narrows one loose config value into the OpenClaw profile ids that Vulcan understands.
// readToolProfile 将宽松配置值收窄成 Vulcan 理解的 OpenClaw 档位标识。
function readToolProfile(value: unknown): VulcanOpenClawToolProfile | undefined {
  return value === "minimal" || value === "messaging" || value === "coding" || value === "full"
    ? value
    : undefined;
}

// asRecord safely narrows unknown runtime config fragments into plain objects.
// asRecord 将未知 runtime config 片段安全收窄为普通对象。
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// readOptionalString keeps non-empty trimmed strings from loose runtime config fragments.
// readOptionalString 会从宽松 runtime config 片段中保留非空裁剪字符串。
function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
