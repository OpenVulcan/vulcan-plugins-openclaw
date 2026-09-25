#!/usr/bin/env node
// Build standalone linked-install artifacts for OpenClaw plugin packages.
// 本脚本用于为 OpenClaw 插件包生成可直接 link 安装的独立产物。

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// REPO_ROOT anchors every source and artifact path used by the packaging pipeline.
// REPO_ROOT 用于固定打包流水线读取源码与写入产物时依赖的仓库根目录。
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ARTIFACT_ROOT is the publish-ready directory consumed by `openclaw plugins install --link`.
// ARTIFACT_ROOT 是 `openclaw plugins install --link` 直接消费的最终安装产物目录。
const ARTIFACT_ROOT = path.join(REPO_ROOT, "artifacts", "openclaw-linked-install");

// PACKAGE_DEFINITIONS declares which plugin packages must be transformed into standalone artifacts.
// PACKAGE_DEFINITIONS 声明了哪些插件包需要被转换成独立可安装产物。
const PACKAGE_DEFINITIONS = [
  {
    artifactDirName: "vulcan-tools",
    packageDirName: "vulcan-tools",
  },
  {
    artifactDirName: "vulcan-memory",
    packageDirName: "vulcan-memory",
  },
];

// SHARED_PACKAGE_NAME is the vendored runtime bridge package consumed by both OpenClaw plugins.
// SHARED_PACKAGE_NAME 是两个 OpenClaw 插件共同依赖并需要内置到产物中的运行时桥接包名称。
const SHARED_PACKAGE_NAME = "@vulcan-plugins-openclaw/shared";

// NPM_COMMAND keeps the packaging flow portable across Windows and POSIX shells.
// NPM_COMMAND 用于让打包流程在 Windows 与类 Unix 环境下都能正确调用 npm。
const NPM_COMMAND = process.platform === "win32" ? "npm.cmd" : "npm";

/**
 * Read a JSON file and deserialize it as a plain object.
 * 读取 JSON 文件并将其反序列化为普通对象。
 *
 * @param {string} filePath Absolute path of the JSON file to read.
 * 要读取的 JSON 文件绝对路径。
 * @returns {Promise<any>} Parsed JSON content.
 * 解析后的 JSON 内容。
 */
async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

/**
 * Write a JavaScript value to disk as formatted JSON.
 * 将 JavaScript 值格式化为 JSON 并写入磁盘。
 *
 * @param {string} filePath Absolute path of the target JSON file.
 * 目标 JSON 文件的绝对路径。
 * @param {any} value JSON-serializable value to persist.
 * 需要持久化的可 JSON 序列化值。
 * @returns {Promise<void>} Resolves after the file is written.
 * 文件写入完成后返回。
 */
async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * Copy one directory tree into another location after recreating the destination.
 * 在重建目标目录后复制整个目录树。
 *
 * @param {string} sourceDir Absolute path of the source directory.
 * 源目录的绝对路径。
 * @param {string} targetDir Absolute path of the destination directory.
 * 目标目录的绝对路径。
 * @returns {Promise<void>} Resolves after the directory tree is copied.
 * 目录树复制完成后返回。
 */
async function replaceDirectory(sourceDir, targetDir) {
  await fs.rm(targetDir, { force: true, recursive: true });
  await fs.mkdir(path.dirname(targetDir), { recursive: true });
  await fs.cp(sourceDir, targetDir, { recursive: true });
}

/**
 * Copy a file into a target path after ensuring the parent directory exists.
 * 在确保父目录存在后复制文件到目标路径。
 *
 * @param {string} sourceFile Absolute path of the source file.
 * 源文件的绝对路径。
 * @param {string} targetFile Absolute path of the destination file.
 * 目标文件的绝对路径。
 * @returns {Promise<void>} Resolves after the file is copied.
 * 文件复制完成后返回。
 */
async function copyFile(sourceFile, targetFile) {
  await fs.mkdir(path.dirname(targetFile), { recursive: true });
  await fs.copyFile(sourceFile, targetFile);
}

/**
 * Execute a child process and stream stdout/stderr to the current terminal.
 * 执行子进程并将标准输出与标准错误实时转发到当前终端。
 *
 * @param {string} command Executable name to launch.
 * 要启动的可执行文件名。
 * @param {string[]} args Command-line arguments passed to the executable.
 * 传递给可执行文件的命令行参数。
 * @param {string} cwd Working directory used by the spawned process.
 * 子进程执行时使用的工作目录。
 * @returns {Promise<void>} Resolves when the command exits successfully.
 * 命令成功退出后返回。
 */
async function runCommand(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        npm_config_package_lock: "false",
      },
      shell: process.platform === "win32",
      stdio: "inherit",
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
 * Build the synthetic package manifest used by the standalone install artifact.
 * 构建独立安装产物使用的合成 package manifest。
 *
 * @param {Record<string, any>} pluginManifest Source plugin package manifest.
 * 源插件包的 package manifest。
 * @param {Record<string, any>} sharedManifest Source shared package manifest.
 * 源共享包的 package manifest。
 * @returns {Record<string, any>} Install-artifact package manifest.
 * 安装产物的 package manifest。
 */
function buildArtifactPackageManifest(pluginManifest, sharedManifest) {
  return {
    name: pluginManifest.name,
    version: pluginManifest.version,
    private: pluginManifest.private,
    type: pluginManifest.type,
    main: pluginManifest.main,
    types: pluginManifest.types,
    peerDependencies: pluginManifest.peerDependencies,
    peerDependenciesMeta: pluginManifest.peerDependenciesMeta,
    openclaw: pluginManifest.openclaw,
    dependencies: {
      ...(sharedManifest.dependencies ?? {}),
    },
  };
}

/**
 * Copy the shared runtime bridge package into the artifact-local node_modules tree.
 * 将共享运行时桥接包复制到产物本地 node_modules 目录树中。
 *
 * @param {string} artifactDir Absolute path of the plugin install artifact directory.
 * 插件安装产物目录的绝对路径。
 * @param {string} sharedPackageDir Absolute path of the shared package source directory.
 * 共享包源码目录的绝对路径。
 * @returns {Promise<void>} Resolves after the vendored shared package is ready.
 * 内置共享包准备完成后返回。
 */
async function vendorSharedPackage(artifactDir, sharedPackageDir) {
  const sharedManifest = await readJson(path.join(sharedPackageDir, "package.json"));
  const sharedNodeModulesDir = path.join(
    artifactDir,
    "node_modules",
    ...SHARED_PACKAGE_NAME.split("/"),
  );

  // Copy only runtime-facing outputs so the install payload stays deterministic and compact.
  // 只复制运行时需要的产物，确保安装载荷稳定且紧凑。
  await replaceDirectory(
    path.join(sharedPackageDir, "dist"),
    path.join(sharedNodeModulesDir, "dist"),
  );

  // Copy the bundled gRPC contracts beside dist so packaged clients need no sibling checkout.
  // 将打包的 gRPC 契约复制到 dist 旁，确保安装产物无需同级仓库。
  await replaceDirectory(
    path.join(sharedPackageDir, "proto"),
    path.join(sharedNodeModulesDir, "proto"),
  );

  // Preserve the shared package metadata so Node can resolve its ESM entry correctly at runtime.
  // 保留共享包元数据，确保 Node 运行时能够正确解析其 ESM 入口。
  await writeJson(path.join(sharedNodeModulesDir, "package.json"), {
    name: sharedManifest.name,
    version: sharedManifest.version,
    private: sharedManifest.private,
    type: sharedManifest.type,
    main: sharedManifest.main,
    types: sharedManifest.types,
    exports: sharedManifest.exports,
    dependencies: sharedManifest.dependencies,
    peerDependencies: sharedManifest.peerDependencies,
    peerDependenciesMeta: sharedManifest.peerDependenciesMeta,
  });
}

/**
 * Prepare one plugin package as a standalone OpenClaw link-install artifact.
 * 将单个插件包整理为可被 OpenClaw link 安装的独立产物。
 *
 * @param {{artifactDirName: string, packageDirName: string}} definition Plugin package definition.
 * 插件包定义。
 * @returns {Promise<string>} Absolute path of the generated install artifact directory.
 * 生成后的安装产物目录绝对路径。
 */
async function preparePluginArtifact(definition) {
  const pluginPackageDir = path.join(REPO_ROOT, "packages", definition.packageDirName);
  const sharedPackageDir = path.join(REPO_ROOT, "packages", "shared");
  const artifactDir = path.join(ARTIFACT_ROOT, definition.artifactDirName);
  const pluginManifest = await readJson(path.join(pluginPackageDir, "package.json"));
  const sharedManifest = await readJson(path.join(sharedPackageDir, "package.json"));

  // Recreate the artifact root from scratch so stale node_modules or old manifests cannot leak between builds.
  // 每次都从零重建产物目录，避免旧的 node_modules 或旧 manifest 污染新的安装包。
  await fs.rm(artifactDir, { force: true, recursive: true });
  await fs.mkdir(artifactDir, { recursive: true });

  // Copy the plugin runtime payload exactly as OpenClaw expects to load it.
  // 按照 OpenClaw 运行时加载预期复制插件自身的运行时代码与 manifest。
  await replaceDirectory(path.join(pluginPackageDir, "dist"), path.join(artifactDir, "dist"));
  await copyFile(
    path.join(pluginPackageDir, "openclaw.plugin.json"),
    path.join(artifactDir, "openclaw.plugin.json"),
  );

  // Rewrite the root package manifest so npm only installs external runtime dependencies.
  // 重写根 package manifest，让 npm 只安装真正的外部运行时依赖。
  await writeJson(
    path.join(artifactDir, "package.json"),
    buildArtifactPackageManifest(pluginManifest, sharedManifest),
  );

  // Install external dependencies into the artifact itself so OpenClaw never has to traverse workspace links.
  // 将外部依赖直接安装进产物目录，避免 OpenClaw 在安装阶段碰到 workspace 链接。
  await runCommand(
    NPM_COMMAND,
    ["install", "--omit=dev", "--ignore-scripts", "--no-package-lock", "--loglevel=error"],
    artifactDir,
  );

  // Vendor the shared bridge after npm install so it is not pruned as an undeclared local workspace package.
  // 在 npm install 之后再内置 shared 桥接包，避免其在安装过程中被当作未声明本地包裁剪掉。
  await vendorSharedPackage(artifactDir, sharedPackageDir);

  return artifactDir;
}

/**
 * Run the full artifact preparation workflow for every OpenClaw plugin package.
 * 为所有 OpenClaw 插件包执行完整的产物准备流程。
 *
 * @returns {Promise<void>} Resolves after all plugin artifacts are generated.
 * 所有插件产物生成完成后返回。
 */
async function main() {
  await fs.mkdir(ARTIFACT_ROOT, { recursive: true });

  // Process each plugin package serially so terminal logs remain readable and failures stay attributable.
  // 串行处理每个插件包，确保终端日志清晰且失败原因能够准确归属到具体插件。
  for (const definition of PACKAGE_DEFINITIONS) {
    const artifactDir = await preparePluginArtifact(definition);
    console.log(`Prepared OpenClaw linked-install artifact: ${artifactDir}`);
  }

  console.log("");
  console.log("Next install commands:");
  for (const definition of PACKAGE_DEFINITIONS) {
    console.log(
      `openclaw plugins install --link ${path.join(ARTIFACT_ROOT, definition.artifactDirName)}`,
    );
  }
}

await main();
