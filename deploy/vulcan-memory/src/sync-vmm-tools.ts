// VMM descriptor synchronization script for the OpenClaw memory plugin.
// 本文件实现 OpenClaw 记忆插件的 VMM 描述同步脚本。

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildBaseHostContext,
  createVulcanHostClient,
  normalizeGeneratedDescriptors,
  renderGeneratedDescriptorModule,
  resolveVulcanConfig,
  updateManifestTools,
  writeTextFile,
} from "@vulcan-plugins-openclaw/shared";

// GENERATED_EXPORT_NAME is the stable export consumed by grouped VMM compatibility tools.
// GENERATED_EXPORT_NAME 是分组式 VMM 兼容工具消费的稳定导出名。
const GENERATED_EXPORT_NAME = "GENERATED_VMM_MEMORY_TOOLS";

// MEMORY_TOOL_NAMES keeps the stable runtime registrations that must always exist in contracts.tools.
// MEMORY_TOOL_NAMES 保留必须始终存在于 contracts.tools 中的稳定运行时工具名。
const MEMORY_TOOL_NAMES = [
  "memory_search",
  "memory_get",
  "vulcan_memory_search",
  "vulcan_memory_get",
] as const;

// main fetches VMM tool descriptors from vulcan-host and writes the generated module.
// main 从 vulcan-host 获取 VMM 工具描述并写入生成模块。
async function main(): Promise<void> {
  const root = resolvePackageRoot();
  const config = resolveVulcanConfig({});
  const client = createVulcanHostClient(config);
  const descriptors = normalizeGeneratedDescriptors(
    await client.listVmmMemoryTools(buildBaseHostContext(config, "sync-memory")),
  );
  const generatedPath = path.join(root, "src", "generated", "vmm-tools.generated.ts");
  const manifestPath = path.join(root, "openclaw.plugin.json");
  await writeTextFile(
    generatedPath,
    renderGeneratedDescriptorModule({
      exportName: GENERATED_EXPORT_NAME,
      descriptors,
    }),
  );
  const toolNames = await updateManifestTools({
    manifestPath,
    baseToolNames: [...MEMORY_TOOL_NAMES],
    generatedToolNames: [],
  });

  // Memory keeps stable canonical and compatibility names, so the manifest is rewritten from fixed ids plus synced metadata.
  // 记忆插件保持稳定的 canonical 与兼容工具名，因此 manifest 会用固定 id 与同步元数据一起重写。
  console.log(`Synced ${descriptors.length} VMM descriptors into ${generatedPath}.`);
  console.log(`Updated ${manifestPath} contracts.tools (${toolNames.length} total).`);
  console.log("Next: restart/reload the Gateway if OpenClaw keeps old memory tool descriptions.");
}

// resolvePackageRoot returns the package root regardless of the caller's cwd.
// resolvePackageRoot 无论调用方 cwd 如何都返回当前包根目录。
function resolvePackageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

await main();
