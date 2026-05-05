// Binding persistence and resolution helpers for Vulcan OpenClaw plugins.
// 本文件负责 Vulcan OpenClaw 插件的绑定持久化与解析辅助逻辑。

import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ResolvedVulcanConfig } from "./types.js";

// DEFAULT_VMM_USER_ID keeps an always-available fallback user binding when the host has no explicit selection yet.
// DEFAULT_VMM_USER_ID 在宿主尚未配置显式用户绑定时提供始终可用的默认回退用户。
const DEFAULT_VMM_USER_ID = "1";

// DEFAULT_VMM_PROJECT_ID keeps an always-available fallback project binding when the host has no explicit selection yet.
// DEFAULT_VMM_PROJECT_ID 在宿主尚未配置显式项目绑定时提供始终可用的默认回退项目。
const DEFAULT_VMM_PROJECT_ID = "1";

// VULCAN_BINDING_STORE_DIRNAME isolates plugin-managed binding state under the standard OpenClaw home tree.
// VULCAN_BINDING_STORE_DIRNAME 把插件管理的绑定状态隔离存放到标准 OpenClaw 主目录树下。
const VULCAN_BINDING_STORE_DIRNAME = path.join(".openclaw", "plugins");

// VULCAN_BINDING_STORE_FILENAME is the durable JSON file used by no-TUI hosts to remember VMM bindings.
// VULCAN_BINDING_STORE_FILENAME 是无 TUI 宿主持久保存 VMM 绑定时使用的 JSON 文件名。
const VULCAN_BINDING_STORE_FILENAME = "vulcan-bindings.json";

// VMM_NUMERIC_ID_REGEX keeps the binding layer aligned with VMM's current positive-decimal business ids.
// VMM_NUMERIC_ID_REGEX 让绑定层与 VMM 当前使用的正整数业务 ID 规则保持一致。
const VMM_NUMERIC_ID_REGEX = /^[1-9]\d*$/u;

// PersistedVulcanBindingState describes the dynamic binding file written by management tools.
// PersistedVulcanBindingState 描述由管理工具写入的动态绑定状态文件。
export interface PersistedVulcanBindingState {
  defaultUserId?: string | undefined;
  defaultProjectId?: string | undefined;
  agentProjects: Record<string, string>;
}

// ResolvedVulcanBindings describes the effective binding set after static config, persisted state, and hard defaults are merged.
// ResolvedVulcanBindings 描述合并静态配置、持久化状态和硬编码默认值后的最终绑定集合。
export interface ResolvedVulcanBindings {
  storePath: string;
  agentId?: string | undefined;
  defaultUserId: string;
  defaultProjectId: string;
  agentProjectId?: string | undefined;
  effectiveUserId: string;
  effectiveProjectId: string;
  projectSource: "default" | "agent";
}

// getVulcanBindingStorePath returns the durable global binding-store file used by OpenClaw plugins.
// getVulcanBindingStorePath 返回 OpenClaw 插件使用的全局绑定存储文件路径。
export function getVulcanBindingStorePath(): string {
  return path.join(os.homedir(), VULCAN_BINDING_STORE_DIRNAME, VULCAN_BINDING_STORE_FILENAME);
}

// loadPersistedVulcanBindingState reads the durable no-TUI binding file and normalizes malformed content away.
// loadPersistedVulcanBindingState 读取无 TUI 宿主使用的持久绑定文件，并把非法内容归一化清理掉。
export async function loadPersistedVulcanBindingState(): Promise<PersistedVulcanBindingState> {
  const filePath = getVulcanBindingStorePath();
  try {
    const raw = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    const record = asRecord(raw);
    return {
      defaultUserId: normalizeBindingId(record.defaultUserId),
      defaultProjectId: normalizeBindingId(record.defaultProjectId),
      agentProjects: normalizeAgentProjectMap(record.agentProjects),
    };
  } catch {
    return {
      agentProjects: {},
    };
  }
}

// savePersistedVulcanBindingState writes one fully normalized binding snapshot to disk.
// savePersistedVulcanBindingState 将一份完全归一化后的绑定快照写回磁盘。
export async function savePersistedVulcanBindingState(
  state: PersistedVulcanBindingState,
): Promise<string> {
  const filePath = getVulcanBindingStorePath();
  await mkdir(path.dirname(filePath), { recursive: true });
  const next = {
    ...(state.defaultUserId ? { defaultUserId: state.defaultUserId } : {}),
    ...(state.defaultProjectId ? { defaultProjectId: state.defaultProjectId } : {}),
    agentProjects: normalizeAgentProjectMap(state.agentProjects),
  };
  await writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return filePath;
}

// resolveEffectiveVulcanBindings merges static plugin config, persisted overrides, and mandatory 1/1 fallbacks.
// resolveEffectiveVulcanBindings 合并静态插件配置、持久化覆盖值与强制 1/1 回退绑定。
export async function resolveEffectiveVulcanBindings(
  config: Pick<ResolvedVulcanConfig, "bindings">,
  agentId?: string | undefined,
): Promise<ResolvedVulcanBindings> {
  const persisted = await loadPersistedVulcanBindingState();
  const normalizedAgentId = normalizeAgentId(agentId);
  const configAgentProjects = normalizeAgentProjectMap(config.bindings.agentProjects);
  const defaultUserId =
    persisted.defaultUserId ??
    normalizeBindingId(config.bindings.defaultUserId) ??
    DEFAULT_VMM_USER_ID;
  const defaultProjectId =
    persisted.defaultProjectId ??
    normalizeBindingId(config.bindings.defaultProjectId) ??
    DEFAULT_VMM_PROJECT_ID;
  const agentProjectId = normalizedAgentId
    ? persisted.agentProjects[normalizedAgentId] ?? configAgentProjects[normalizedAgentId]
    : undefined;
  return {
    storePath: getVulcanBindingStorePath(),
    agentId: normalizedAgentId,
    defaultUserId,
    defaultProjectId,
    agentProjectId,
    effectiveUserId: defaultUserId,
    effectiveProjectId: agentProjectId ?? defaultProjectId,
    projectSource: agentProjectId ? "agent" : "default",
  };
}

// setPersistedDefaultUserId updates the durable default user binding after validating the numeric business id.
// setPersistedDefaultUserId 在校验数字业务 ID 后更新持久默认用户绑定。
export async function setPersistedDefaultUserId(userId: string): Promise<PersistedVulcanBindingState> {
  const normalizedUserId = assertBindingId(userId, "defaultUserId");
  return updatePersistedBindings((current) => ({
    ...current,
    defaultUserId: normalizedUserId,
  }));
}

// setPersistedDefaultProjectId updates the durable default project binding after validating the numeric business id.
// setPersistedDefaultProjectId 在校验数字业务 ID 后更新持久默认项目绑定。
export async function setPersistedDefaultProjectId(
  projectId: string,
): Promise<PersistedVulcanBindingState> {
  const normalizedProjectId = assertBindingId(projectId, "defaultProjectId");
  return updatePersistedBindings((current) => ({
    ...current,
    defaultProjectId: normalizedProjectId,
  }));
}

// setPersistedAgentProjectId updates one agent-specific project override while preserving the shared defaults.
// setPersistedAgentProjectId 在保留共享默认绑定的同时更新单个 agent 的项目覆盖值。
export async function setPersistedAgentProjectId(
  agentId: string,
  projectId: string,
): Promise<PersistedVulcanBindingState> {
  const normalizedAgentId = assertAgentId(agentId);
  const normalizedProjectId = assertBindingId(projectId, "projectId");
  return updatePersistedBindings((current) => ({
    ...current,
    agentProjects: {
      ...current.agentProjects,
      [normalizedAgentId]: normalizedProjectId,
    },
  }));
}

// clearPersistedAgentProjectId removes one agent-specific override so runtime resolution falls back to the shared default project.
// clearPersistedAgentProjectId 删除单个 agent 的项目覆盖值，让运行时重新回退到共享默认项目。
export async function clearPersistedAgentProjectId(
  agentId: string,
): Promise<PersistedVulcanBindingState> {
  const normalizedAgentId = assertAgentId(agentId);
  return updatePersistedBindings((current) => {
    const nextAgentProjects = { ...current.agentProjects };
    delete nextAgentProjects[normalizedAgentId];
    return {
      ...current,
      agentProjects: nextAgentProjects,
    };
  });
}

// updatePersistedBindings centralizes the read-modify-write cycle so every management tool shares one normalization path.
// updatePersistedBindings 统一封装读取、修改、写回流程，让所有管理工具复用同一条归一化路径。
async function updatePersistedBindings(
  mutate: (current: PersistedVulcanBindingState) => PersistedVulcanBindingState,
): Promise<PersistedVulcanBindingState> {
  const current = await loadPersistedVulcanBindingState();
  const next = mutate(current);
  const normalized: PersistedVulcanBindingState = {
    defaultUserId: normalizeBindingId(next.defaultUserId),
    defaultProjectId: normalizeBindingId(next.defaultProjectId),
    agentProjects: normalizeAgentProjectMap(next.agentProjects),
  };
  await savePersistedVulcanBindingState(normalized);
  return normalized;
}

// normalizeBindingId keeps only positive-decimal VMM business ids and drops all malformed input.
// normalizeBindingId 只保留正整数字符串形式的 VMM 业务 ID，并丢弃所有非法输入。
function normalizeBindingId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return String(Math.trunc(value));
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return VMM_NUMERIC_ID_REGEX.test(trimmed) ? trimmed : undefined;
}

// normalizeAgentProjectMap keeps only non-empty agent keys with valid numeric project ids.
// normalizeAgentProjectMap 只保留非空 agent 键和合法数字 project id 的映射关系。
function normalizeAgentProjectMap(value: unknown): Record<string, string> {
  const record = asRecord(value);
  const next: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(record)) {
    const agentId = normalizeAgentId(rawKey);
    const projectId = normalizeBindingId(rawValue);
    if (!agentId || !projectId) {
      continue;
    }
    next[agentId] = projectId;
  }
  return next;
}

// normalizeAgentId preserves only non-empty trimmed agent ids so overrides never key on whitespace noise.
// normalizeAgentId 只保留非空裁剪后的 agent id，避免覆盖关系误落到空白键上。
function normalizeAgentId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// assertBindingId upgrades one maybe-valid binding id into a required numeric id for write operations.
// assertBindingId 把一个可能合法的绑定 ID 提升为写操作所需的强制数字 ID。
function assertBindingId(value: unknown, fieldName: string): string {
  const normalized = normalizeBindingId(value);
  if (!normalized) {
    throw new Error(`${fieldName} must be one positive decimal VMM id string.`);
  }
  return normalized;
}

// assertAgentId upgrades one maybe-valid agent id into a required non-empty key for override writes.
// assertAgentId 把一个可能合法的 agent id 提升为覆盖写入所需的强制非空键。
function assertAgentId(value: unknown): string {
  const normalized = normalizeAgentId(value);
  if (!normalized) {
    throw new Error("agentId must be a non-empty string.");
  }
  return normalized;
}

// asRecord safely narrows unknown JSON-ish input into one plain object shell.
// asRecord 将未知 JSON 风格输入安全收窄成普通对象外壳。
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
