#!/usr/bin/env node
// Local one-shot installer for enabling Vulcan OpenClaw plugins with system-service-oriented host config.
// 本脚本用于一键启用 Vulcan OpenClaw 插件，并写入面向系统服务托管的本地配置。

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// REPO_ROOT keeps every generated artifact and helper command anchored to this repository checkout.
// REPO_ROOT 用于把所有生成产物与辅助命令都锚定到当前仓库检出目录。
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// OPENCLAW_CONFIG_PATH is the standard local OpenClaw user config file targeted by this installer.
// OPENCLAW_CONFIG_PATH 是本安装脚本要写入的标准本地 OpenClaw 用户配置文件。
const OPENCLAW_CONFIG_PATH = path.join(os.homedir(), ".openclaw", "openclaw.json");

// ARTIFACT_ROOT points to the linked-install directories consumed by OpenClaw's plugin loader.
// ARTIFACT_ROOT 指向 OpenClaw 插件加载器消费的 linked-install 产物目录。
const ARTIFACT_ROOT = path.join(REPO_ROOT, "artifacts", "openclaw-linked-install");

// BUNDLED_PROTO_PATH points to the protocol contract versioned with this plugin repository.
// BUNDLED_PROTO_PATH 指向与当前插件仓库一同版本管理的协议契约。
const BUNDLED_PROTO_PATH = path.join(REPO_ROOT, "packages", "shared", "proto", "v1", "mcp_service.proto");

// VULCAN_MEMORY_ARTIFACT_PATH is the standalone artifact directory for the Vulcan memory plugin.
// VULCAN_MEMORY_ARTIFACT_PATH 是 Vulcan memory 插件的独立产物目录。
const VULCAN_MEMORY_ARTIFACT_PATH = path.join(ARTIFACT_ROOT, "vulcan-memory");

// VULCAN_TOOLS_ARTIFACT_PATH is the standalone artifact directory for the Vulcan tools plugin.
// VULCAN_TOOLS_ARTIFACT_PATH 是 Vulcan tools 插件的独立产物目录。
const VULCAN_TOOLS_ARTIFACT_PATH = path.join(ARTIFACT_ROOT, "vulcan-tools");

// DEFAULT_ENDPOINT keeps local OpenClaw installs aligned with the current vulcan-host gRPC default.
// DEFAULT_ENDPOINT 用于让本地 OpenClaw 安装与当前 vulcan-host gRPC 默认地址保持一致。
const DEFAULT_ENDPOINT = "127.0.0.1:19202";

// PNPM_COMMAND keeps nested workspace script execution portable across Windows and POSIX.
// PNPM_COMMAND 用于让嵌套的工作区脚本执行同时兼容 Windows 与类 Unix 环境。
const PNPM_COMMAND = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

// OPENCLAW_COMMAND keeps OpenClaw CLI invocations portable across Windows and POSIX.
// OPENCLAW_COMMAND 用于让 OpenClaw CLI 调用同时兼容 Windows 与类 Unix 环境。
const OPENCLAW_COMMAND = process.platform === "win32" ? "openclaw.cmd" : "openclaw";

/**
 * Execute one command and mirror its output to the current terminal.
 * 执行一条命令，并把输出实时镜像到当前终端。
 *
 * @param {string} command Executable name to launch.
 * 要启动的可执行文件名。
 * @param {string[]} args Command-line arguments passed to the executable.
 * 传递给可执行文件的命令行参数。
 * @param {string} cwd Working directory used by the child process.
 * 子进程执行时使用的工作目录。
 * @returns {Promise<void>} Resolves after the command exits successfully.
 * 命令成功退出后返回。
 */
async function runCommand(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell: process.platform === "win32",
      stdio: "inherit",
      windowsHide: true,
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve(undefined);
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}`));
    });
  });
}

/**
 * Read one JSON file when it exists, or return a fallback object when it does not.
 * 当 JSON 文件存在时读取它，否则返回回退对象。
 *
 * @param {string} filePath Absolute path of the JSON file.
 * JSON 文件的绝对路径。
 * @param {Record<string, unknown>} fallback Default object used when the file does not exist.
 * 文件不存在时使用的默认对象。
 * @returns {Promise<Record<string, unknown>>} Parsed JSON object or the fallback value.
 * 解析后的 JSON 对象或回退值。
 */
async function readJsonObject(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  return JSON.parse(await fsp.readFile(filePath, "utf8"));
}

/**
 * Persist one JSON object using stable pretty formatting.
 * 使用稳定的格式化方式持久化一个 JSON 对象。
 *
 * @param {string} filePath Absolute path of the JSON file to write.
 * 要写入的 JSON 文件绝对路径。
 * @param {Record<string, unknown>} value JSON object to persist.
 * 需要持久化的 JSON 对象。
 * @returns {Promise<void>} Resolves after the file is written.
 * 文件写入完成后返回。
 */
async function writeJsonObject(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * Add one string into an array only when it is not already present.
 * 仅在字符串尚未存在时把它加入数组。
 *
 * @param {unknown} value Raw value that should be treated as a string array.
 * 需要被视为字符串数组的原始值。
 * @param {string} item String item to insert.
 * 要插入的字符串项。
 * @returns {string[]} Deduplicated string array.
 * 去重后的字符串数组。
 */
function appendUniqueString(value, item) {
  const list = Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
  return list.includes(item) ? list : [...list, item];
}

/**
 * Check whether one plugin load path belongs to the managed Vulcan linked-install artifact set.
 * 检查某个插件加载路径是否属于受本安装器管理的 Vulcan linked-install 产物集合。
 *
 * @param {unknown} value Raw load path candidate from OpenClaw config.
 * OpenClaw 配置中的原始加载路径候选值。
 * @returns {value is string} True when the path is one of the managed Vulcan linked-install roots.
 * 当该路径属于受管的 Vulcan linked-install 根目录时返回 true。
 */
function isManagedVulcanArtifactPath(value) {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.replaceAll("\\", "/").toLowerCase();
  return normalized.endsWith("/artifacts/openclaw-linked-install/vulcan-memory")
    || normalized.endsWith("/artifacts/openclaw-linked-install/vulcan-tools");
}

/**
 * Remove one string from an array when present.
 * 当字符串存在时从数组中移除它。
 *
 * @param {unknown} value Raw value that should be treated as a string array.
 * 需要被视为字符串数组的原始值。
 * @param {string} item String item to remove.
 * 要移除的字符串项。
 * @returns {string[] | undefined} Next array, or undefined when the array becomes empty.
 * 处理后的数组；若最终为空则返回 undefined。
 */
function removeString(value, item) {
  const list = Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
  const next = list.filter((entry) => entry !== item);
  return next.length > 0 ? next : undefined;
}

/**
 * Merge Vulcan plugin settings into the current OpenClaw config object.
 * 将 Vulcan 插件设置合并进当前 OpenClaw 配置对象。
 *
 * @param {Record<string, unknown>} config Raw OpenClaw config object.
 * 原始 OpenClaw 配置对象。
 * @param {string} protoPath Resolved mcp_service.proto path shared by both plugins.
 * 两个插件共用的已解析 mcp_service.proto 路径。
 * @returns {{config: Record<string, unknown>}} Updated config object.
 * 返回更新后的配置对象。
 */
function applyVulcanPluginConfig(config, protoPath) {
  const next = { ...config };
  const plugins = isRecord(next.plugins) ? { ...next.plugins } : {};
  const entries = isRecord(plugins.entries) ? { ...plugins.entries } : {};
  const load = isRecord(plugins.load) ? { ...plugins.load } : {};
  const slots = isRecord(plugins.slots) ? { ...plugins.slots } : {};

  const toolsEntry = isRecord(entries["vulcan-tools"]) ? { ...entries["vulcan-tools"] } : {};
  const toolsConfig = isRecord(toolsEntry.config) ? { ...toolsEntry.config } : {};
  const toolsHostConfig = isRecord(toolsConfig.host) ? { ...toolsConfig.host } : {};
  const toolsToolConfig = isRecord(toolsConfig.tools) ? { ...toolsConfig.tools } : {};

  const memoryEntry = isRecord(entries["vulcan-memory"]) ? { ...entries["vulcan-memory"] } : {};
  const memoryHooks = isRecord(memoryEntry.hooks) ? { ...memoryEntry.hooks } : {};
  const memoryConfig = isRecord(memoryEntry.config) ? { ...memoryEntry.config } : {};
  const memoryBindings = isRecord(memoryConfig.bindings) ? { ...memoryConfig.bindings } : {};
  const memoryRuntime = isRecord(memoryConfig.memory) ? { ...memoryConfig.memory } : {};

  // Replace previously managed Vulcan artifact roots so repository renames do not leave stale plugin paths behind.
  // 替换此前受管的 Vulcan 产物根路径，避免仓库改名后残留失效的旧插件目录。
  const retainedLoadPaths = Array.isArray(load.paths)
    ? load.paths.filter((entry) => typeof entry === "string" && !isManagedVulcanArtifactPath(entry))
    : [];

  // Keep both plugin paths pinned in the cold-load manifest search path so OpenClaw can see the linked artifacts on every restart.
  // 将两个插件路径固定到冷启动 manifest 搜索路径中，确保 OpenClaw 每次重启都能看到 linked 产物。
  load.paths = appendUniqueString(retainedLoadPaths, VULCAN_MEMORY_ARTIFACT_PATH);
  load.paths = appendUniqueString(load.paths, VULCAN_TOOLS_ARTIFACT_PATH);

  // Enable the tools plugin, but keep vulcan-host lifecycle outside the plugin so operators can manage it as one shared system service.
  // 启用 tools 插件，但保持 vulcan-host 生命周期在插件之外，让操作者按共享系统服务方式统一管理。
  toolsHostConfig.autoStart = false;

  toolsToolConfig.enabled = toolsToolConfig.enabled ?? true;
  toolsToolConfig.dispatcherEnabled = toolsToolConfig.dispatcherEnabled ?? true;
  toolsToolConfig.timeoutMs = toolsToolConfig.timeoutMs ?? 30_000;

  entries["vulcan-tools"] = {
    ...toolsEntry,
    enabled: true,
    config: {
      ...toolsConfig,
      endpoint: toolsConfig.endpoint ?? DEFAULT_ENDPOINT,
      protoPath,
      host: toolsHostConfig,
      tools: toolsToolConfig,
    },
  };

  // Enable the memory plugin with the hook policy and fallback bindings required by the native VMM takeover flow.
  // 按照原生 VMM 接管链路要求启用 memory 插件，并写入必要的 hook 策略与兜底绑定。
  memoryHooks.allowPromptInjection = true;
  memoryHooks.allowConversationAccess = true;

  memoryBindings.defaultUserId = memoryBindings.defaultUserId ?? 1;
  memoryBindings.defaultProjectId = memoryBindings.defaultProjectId ?? 1;

  memoryRuntime.enabled = memoryRuntime.enabled ?? true;
  memoryRuntime.autoRecall = memoryRuntime.autoRecall ?? true;
  memoryRuntime.autoPostAction = memoryRuntime.autoPostAction ?? true;
  memoryRuntime.recallTopK = memoryRuntime.recallTopK ?? 5;

  entries["vulcan-memory"] = {
    ...memoryEntry,
    enabled: true,
    hooks: memoryHooks,
    config: {
      ...memoryConfig,
      endpoint: memoryConfig.endpoint ?? DEFAULT_ENDPOINT,
      protoPath,
      bindings: memoryBindings,
      memory: memoryRuntime,
    },
  };

  // Align slot ownership and allow/deny lists so restrictive configs cannot shadow the local Vulcan plugins.
  // 对齐 slot 所有权和 allow/deny 列表，避免受限配置把本地 Vulcan 插件挡在外面。
  slots.memory = "vulcan-memory";
  plugins.allow = appendUniqueString(plugins.allow, "vulcan-tools");
  plugins.allow = appendUniqueString(plugins.allow, "vulcan-memory");
  const deny = removeString(removeString(plugins.deny, "vulcan-tools"), "vulcan-memory");

  next.plugins = {
    ...plugins,
    ...(deny ? { deny } : {}),
    load,
    entries,
    slots,
  };

  return { config: next };
}

/**
 * Resolve one shared proto path from the configured Vulcan plugin entries.
 * 从已配置的 Vulcan 插件项中解析唯一共享 proto 路径。
 *
 * @param {Record<string, unknown>} config Parsed OpenClaw config object.
 * 已解析的 OpenClaw 配置对象。
 * @returns {string | undefined} The configured proto path, when present.
 * 已配置的 proto 文件路径；未配置时返回 undefined。
 */
function resolveConfiguredProtoPath(config) {
  // plugins and entries narrow the untyped OpenClaw config to its plugin registration section.
  // plugins 与 entries 将无类型 OpenClaw 配置收窄到插件注册部分。
  const plugins = isRecord(config.plugins) ? config.plugins : {};
  const entries = isRecord(plugins.entries) ? plugins.entries : {};
  // protoPaths collects only the proto settings from the two plugins that share this gRPC contract.
  // protoPaths 只收集共享该 gRPC 契约的两个插件配置。
  const protoPaths = ["vulcan-tools", "vulcan-memory"]
    .map((pluginId) => {
      // entry and pluginConfig narrow one configured plugin entry before reading its protoPath.
      // entry 与 pluginConfig 在读取 protoPath 前收窄单个插件配置项。
      const entry = isRecord(entries[pluginId]) ? entries[pluginId] : {};
      const pluginConfig = isRecord(entry.config) ? entry.config : {};
      return typeof pluginConfig.protoPath === "string" ? pluginConfig.protoPath.trim() : "";
    })
    .filter(Boolean);
  // uniquePaths ensures the installer does not silently choose between conflicting plugin contracts.
  // uniquePaths 用于避免安装器在冲突的插件协议配置之间静默猜选。
  const uniquePaths = [...new Set(protoPaths)];
  if (uniquePaths.length > 1) {
    throw new Error("vulcan-tools and vulcan-memory must use the same protoPath.");
  }
  return uniquePaths[0];
}

/**
 * Check whether one value is a plain object.
 * 检查一个值是否为普通对象。
 *
 * @param {unknown} value Value to inspect.
 * 需要检查的值。
 * @returns {value is Record<string, unknown>} True when the value is a plain object.
 * 当值为普通对象时返回 true。
 */
function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * Decide whether the installer should stop Gateway before rebuilding linked artifacts.
 * 判断安装器是否需要在重建 linked 产物前先停止 Gateway。
 *
 * @returns {boolean} True when current linked-install artifacts already exist and may be locked by the running Gateway.
 * 当当前 linked-install 产物已经存在且可能被运行中的 Gateway 锁定时返回 true。
 */
function shouldStopGatewayBeforePrepare() {
  return fs.existsSync(VULCAN_MEMORY_ARTIFACT_PATH) || fs.existsSync(VULCAN_TOOLS_ARTIFACT_PATH);
}

/**
 * Run the full local OpenClaw setup flow for Vulcan plugins.
 * 执行 Vulcan 插件面向本地 OpenClaw 的完整安装配置流程。
 *
 * @returns {Promise<void>} Resolves after artifacts, config, and Gateway refresh are complete.
 * 产物、配置和 Gateway 刷新全部完成后返回。
 */
async function main() {
  // currentConfig lets setup reuse a path already configured by the OpenClaw operator.
  // currentConfig 让安装流程复用 OpenClaw 操作者已配置的路径。
  const currentConfig = await readJsonObject(OPENCLAW_CONFIG_PATH, {});
  // configuredProtoPath follows persisted plugin config before consulting the environment.
  // configuredProtoPath 按照先读持久插件配置、再查环境变量的顺序解析。
  const configuredProtoPath = resolveConfiguredProtoPath(currentConfig);
  // protoPath is the explicit schema input required by both descriptor sync and runtime gRPC loading.
  // protoPath 是 descriptor 同步与运行时 gRPC 加载都必需的明确 schema 输入。
  // environmentProtoPath lets an operator intentionally replace the bundled protocol contract.
  // environmentProtoPath 允许操作者有意替换包内置协议契约。
  const environmentProtoPath = process.env.VULCAN_HOST_PROTO_PATH?.trim();
  // configuredProtoPath is reused only when the configured file still exists on this machine.
  // 仅当当前机器上仍存在配置文件时才复用 configuredProtoPath。
  const configuredProtoPathExists = configuredProtoPath && fs.existsSync(configuredProtoPath);
  // protoPath uses a valid saved override first, then an explicit environment override, then bundled files.
  // protoPath 依次使用有效的已存覆盖、明确环境覆盖，最后回退到包内置文件。
  const protoPath = configuredProtoPathExists
    ? configuredProtoPath
    : environmentProtoPath || BUNDLED_PROTO_PATH;
  if (configuredProtoPath && !configuredProtoPathExists && !environmentProtoPath) {
    console.warn(`Configured protoPath is missing; migrating to the bundled contract: ${BUNDLED_PROTO_PATH}`);
  }
  if (!fs.existsSync(protoPath)) {
    throw new Error(`mcp_service.proto was not found at the configured path: ${protoPath}`);
  }
  // vmmProtoPath must be paired with the selected MCP contract in the same protocol directory.
  // vmmProtoPath 必须与选定的 MCP 契约文件位于同一协议目录。
  const vmmProtoPath = path.join(path.dirname(protoPath), "vmm.proto");
  if (!fs.existsSync(vmmProtoPath)) {
    throw new Error(`vmm.proto was not found next to the configured mcp_service.proto: ${vmmProtoPath}`);
  }
  process.env.VULCAN_HOST_PROTO_PATH = protoPath;

  console.log("Syncing generated tool descriptors...");
  await runCommand(PNPM_COMMAND, ["sync:tools"], REPO_ROOT);
  await runCommand(PNPM_COMMAND, ["sync:memory"], REPO_ROOT);

  console.log("Building plugin packages...");
  await runCommand(PNPM_COMMAND, ["build"], REPO_ROOT);

  // Rewrite the plugin load paths before touching Gateway so renamed repositories do not leave stale artifact roots behind.
  // 在操作 Gateway 之前先重写插件加载路径，避免仓库改名后残留失效的旧产物目录。
  const { config: nextConfig } = applyVulcanPluginConfig(currentConfig, protoPath);
  await writeJsonObject(OPENCLAW_CONFIG_PATH, nextConfig);
  console.log(`Updated OpenClaw config: ${OPENCLAW_CONFIG_PATH}`);

  // Stop the Gateway before rebuilding linked-install artifacts so Windows does not keep the old plugin directory locked.
  // 在重建 linked-install 产物前先停止 Gateway，避免 Windows 持续锁住旧插件目录。
  if (shouldStopGatewayBeforePrepare()) {
    console.log("Stopping OpenClaw Gateway before rebuilding linked-install artifacts...");
    await runCommand(OPENCLAW_COMMAND, ["gateway", "stop"], REPO_ROOT);
  } else {
    console.log("Skipping Gateway stop because no prior linked-install artifacts exist yet.");
  }

  console.log("Preparing OpenClaw linked-install artifacts...");
  await runCommand(PNPM_COMMAND, ["prepare:linked-install"], REPO_ROOT);
  console.log("Refreshing OpenClaw plugin registry...");
  await runCommand(OPENCLAW_COMMAND, ["plugins", "registry", "--refresh"], REPO_ROOT);

  console.log("Restarting OpenClaw Gateway...");
  await runCommand(OPENCLAW_COMMAND, ["gateway", "restart"], REPO_ROOT);

  console.log("");
  console.log("Vulcan OpenClaw local install is ready.");
  console.log(`- memory artifact: ${VULCAN_MEMORY_ARTIFACT_PATH}`);
  console.log(`- tools artifact: ${VULCAN_TOOLS_ARTIFACT_PATH}`);
  console.log(`- config file: ${OPENCLAW_CONFIG_PATH}`);
  console.log(`- vulcan-host endpoint: ${DEFAULT_ENDPOINT}`);
  console.log("- vulcan-host lifecycle: manage it as an external system service before using Vulcan tools");
}

await main();
