#!/usr/bin/env node
// Local one-shot installer for enabling Vulcan OpenClaw plugins with autostart-ready config.
// 本脚本用于一键启用 Vulcan OpenClaw 插件，并写入可直接自启动的本地配置。

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

// VULCAN_MEMORY_ARTIFACT_PATH is the standalone artifact directory for the Vulcan memory plugin.
// VULCAN_MEMORY_ARTIFACT_PATH 是 Vulcan memory 插件的独立产物目录。
const VULCAN_MEMORY_ARTIFACT_PATH = path.join(ARTIFACT_ROOT, "vulcan-memory");

// VULCAN_TOOLS_ARTIFACT_PATH is the standalone artifact directory for the Vulcan tools plugin.
// VULCAN_TOOLS_ARTIFACT_PATH 是 Vulcan tools 插件的独立产物目录。
const VULCAN_TOOLS_ARTIFACT_PATH = path.join(ARTIFACT_ROOT, "vulcan-tools");

// DEFAULT_ENDPOINT keeps local OpenClaw installs aligned with the current vulcan-host gRPC default.
// DEFAULT_ENDPOINT 用于让本地 OpenClaw 安装与当前 vulcan-host gRPC 默认地址保持一致。
const DEFAULT_ENDPOINT = "127.0.0.1:19202";

// DEFAULT_PROTO_PATH points to the local proto contract used by the OpenClaw gRPC bridge.
// DEFAULT_PROTO_PATH 指向 OpenClaw gRPC 桥接使用的本地 proto 契约文件。
const DEFAULT_PROTO_PATH = "D:/projects/vulcan-mcp-client/proto/v1/mcp_service.proto";

// DEFAULT_HOST_READY_TIMEOUT_MS bounds how long runtime autostart should wait for vulcan-host readiness.
// DEFAULT_HOST_READY_TIMEOUT_MS 用于限制运行时自启动等待 vulcan-host 就绪的最长时间。
const DEFAULT_HOST_READY_TIMEOUT_MS = 15_000;

// PNPM_COMMAND keeps nested workspace script execution portable across Windows and POSIX.
// PNPM_COMMAND 用于让嵌套的工作区脚本执行同时兼容 Windows 与类 Unix 环境。
const PNPM_COMMAND = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

// OPENCLAW_COMMAND keeps OpenClaw CLI invocations portable across Windows and POSIX.
// OPENCLAW_COMMAND 用于让 OpenClaw CLI 调用同时兼容 Windows 与类 Unix 环境。
const OPENCLAW_COMMAND = process.platform === "win32" ? "openclaw.cmd" : "openclaw";

// DEFAULT_HOST_COMMAND_CANDIDATES lists the common local vulcan-mcp binary locations expected in this workspace layout.
// DEFAULT_HOST_COMMAND_CANDIDATES 列出当前工作区布局下常见的本地 vulcan-mcp 二进制位置。
const DEFAULT_HOST_COMMAND_CANDIDATES = process.platform === "win32"
  ? [
      "D:/projects/vulcan-mcp-client/target/release/vulcan-mcp.exe",
      "D:/projects/vulcan-mcp-client/target/debug/vulcan-mcp.exe",
    ]
  : [
      "D:/projects/vulcan-mcp-client/target/release/vulcan-mcp",
      "D:/projects/vulcan-mcp-client/target/debug/vulcan-mcp",
    ];

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
 * Resolve the preferred local vulcan-mcp binary path when a common workspace build already exists.
 * 当常见工作区构建产物存在时解析首选的本地 vulcan-mcp 二进制路径。
 *
 * @returns {string | undefined} Preferred vulcan-mcp binary path when available.
 * 可用时返回首选的 vulcan-mcp 二进制路径。
 */
function resolvePreferredHostCommand() {
  for (const candidate of DEFAULT_HOST_COMMAND_CANDIDATES) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Merge Vulcan plugin settings into the current OpenClaw config object.
 * 将 Vulcan 插件设置合并进当前 OpenClaw 配置对象。
 *
 * @param {Record<string, unknown>} config Raw OpenClaw config object.
 * 原始 OpenClaw 配置对象。
 * @returns {{config: Record<string, unknown>, hostCommand?: string}} Updated config plus the resolved host command.
 * 更新后的配置以及解析出的 host 命令。
 */
function applyVulcanPluginConfig(config) {
  const next = { ...config };
  const plugins = isRecord(next.plugins) ? { ...next.plugins } : {};
  const entries = isRecord(plugins.entries) ? { ...plugins.entries } : {};
  const load = isRecord(plugins.load) ? { ...plugins.load } : {};
  const slots = isRecord(plugins.slots) ? { ...plugins.slots } : {};

  const hostCommand = resolvePreferredHostCommand();

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

  // Enable the tools plugin and preseed the host autostart policy so local installs do not require a second manual toggle.
  // 启用 tools 插件，并预置 host 自启动策略，让本地安装不再需要第二次手工开关。
  toolsHostConfig.autoStart = true;
  if (hostCommand) {
    toolsHostConfig.command = toolsHostConfig.command ?? hostCommand;
    toolsHostConfig.cwd = toolsHostConfig.cwd ?? path.dirname(hostCommand);
  }
  toolsHostConfig.readyTimeoutMs = toolsHostConfig.readyTimeoutMs ?? DEFAULT_HOST_READY_TIMEOUT_MS;

  toolsToolConfig.enabled = toolsToolConfig.enabled ?? true;
  toolsToolConfig.dispatcherEnabled = toolsToolConfig.dispatcherEnabled ?? true;
  toolsToolConfig.timeoutMs = toolsToolConfig.timeoutMs ?? 30_000;

  entries["vulcan-tools"] = {
    ...toolsEntry,
    enabled: true,
    config: {
      ...toolsConfig,
      endpoint: toolsConfig.endpoint ?? DEFAULT_ENDPOINT,
      protoPath: toolsConfig.protoPath ?? DEFAULT_PROTO_PATH,
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
      protoPath: memoryConfig.protoPath ?? DEFAULT_PROTO_PATH,
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

  return { config: next, hostCommand };
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
  console.log("Syncing generated tool descriptors...");
  await runCommand(PNPM_COMMAND, ["sync:tools"], REPO_ROOT);
  await runCommand(PNPM_COMMAND, ["sync:memory"], REPO_ROOT);

  console.log("Building plugin packages...");
  await runCommand(PNPM_COMMAND, ["build"], REPO_ROOT);

  // Rewrite the plugin load paths before touching Gateway so renamed repositories do not leave stale artifact roots behind.
  // 在操作 Gateway 之前先重写插件加载路径，避免仓库改名后残留失效的旧产物目录。
  const currentConfig = await readJsonObject(OPENCLAW_CONFIG_PATH, {});
  const { config: nextConfig, hostCommand } = applyVulcanPluginConfig(currentConfig);
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
  if (hostCommand) {
    console.log(`- vulcan-host autostart command: ${hostCommand}`);
  } else {
    console.log("- vulcan-host autostart command: not auto-detected; set plugins.entries.vulcan-tools.config.host.command manually if needed");
  }
}

await main();
