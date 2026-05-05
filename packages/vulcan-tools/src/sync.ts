// LuaSkills descriptor synchronization script for the OpenClaw tool plugin.
// 本文件实现 OpenClaw 工具插件的 LuaSkills 描述同步脚本。

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

// DISPATCHER_TOOL_NAME is always kept in contracts.tools as the fallback bridge.
// DISPATCHER_TOOL_NAME 始终保留在 contracts.tools 中，作为降级桥接工具。
const DISPATCHER_TOOL_NAME = "vulcan_luaskill_call";

// GENERATED_EXPORT_NAME is the stable export consumed by the plugin entrypoint.
// GENERATED_EXPORT_NAME 是插件入口消费的稳定导出名。
const GENERATED_EXPORT_NAME = "GENERATED_LUASKILL_TOOLS";

// main fetches current LuaSkills descriptors and rewrites generated OpenClaw files.
// main 获取当前 LuaSkills 描述，并重写生成的 OpenClaw 文件。
async function main(): Promise<void> {
  const root = resolvePackageRoot();
  const config = resolveVulcanConfig({});
  const client = createVulcanHostClient(config);
  const descriptors = normalizeGeneratedDescriptors(
    await client.listLuaSkillTools(buildBaseHostContext(config, "sync-tools")),
  );
  const generatedPath = path.join(root, "src", "generated", "tools.generated.ts");
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
    baseToolNames: [DISPATCHER_TOOL_NAME],
    generatedToolNames: descriptors.map((descriptor) => descriptor.name),
  });

  // Print the exact refresh hints because OpenClaw reads contracts.tools from cold registry metadata.
  // 打印精确刷新提示，因为 OpenClaw 会从冷 registry 元数据读取 contracts.tools。
  console.log(`Synced ${descriptors.length} LuaSkills tools into ${generatedPath}.`);
  console.log(`Updated ${manifestPath} contracts.tools (${toolNames.length} total).`);
  console.log("Next: run `openclaw plugins registry --refresh`, then restart/reload the Gateway if runtime tools still use the old manifest.");
}

// resolvePackageRoot returns the package root regardless of the caller's cwd.
// resolvePackageRoot 无论调用方 cwd 如何都返回当前包根目录。
function resolvePackageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

await main();
