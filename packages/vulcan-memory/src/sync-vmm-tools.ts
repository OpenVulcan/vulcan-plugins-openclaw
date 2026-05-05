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
  type VulcanToolDescriptor,
  updateManifestTools,
  writeTextFile,
} from "@vulcan-plugins-openclaw/shared";

// GENERATED_EXPORT_NAME is the stable export consumed by memory compatibility tools and binding/admin wrappers.
// GENERATED_EXPORT_NAME 是记忆兼容工具与绑定管理包装器共同消费的稳定导出名。
const GENERATED_EXPORT_NAME = "GENERATED_VMM_TOOLS";

// STABLE_MEMORY_TOOL_NAMES keeps the canonical plus compatibility memory registrations that always exist in contracts.tools.
// STABLE_MEMORY_TOOL_NAMES 保留始终存在于 contracts.tools 中的 canonical 与兼容记忆工具名。
const STABLE_MEMORY_TOOL_NAMES = [
  "memory_search",
  "memory_get",
  "vulcan_memory_search",
  "vulcan_memory_get",
 ] as const;

// FALLBACK_BINDING_TOOL_NAMES keeps one bootstrap binding/admin manifest set for older vulcan-host runtimes that cannot return tool_group metadata yet.
// FALLBACK_BINDING_TOOL_NAMES 为尚不能返回 tool_group 元数据的旧版 vulcan-host 保留一套引导期绑定/管理工具名。
const FALLBACK_BINDING_TOOL_NAMES = [
  "vulcan_vmm_get_bindings",
  "vulcan_vmm_list_users",
  "vulcan_vmm_bind_default_user",
  "vulcan_vmm_list_projects",
  "vulcan_vmm_bind_default_project",
  "vulcan_vmm_bind_agent_project",
  "vulcan_vmm_clear_agent_project",
] as const;

// main fetches VMM memory plus binding/admin descriptors from vulcan-host and writes the generated module.
// main 从 vulcan-host 获取 VMM 记忆与绑定管理工具描述，并写入生成模块。
async function main(): Promise<void> {
  const root = resolvePackageRoot();
  const config = resolveVulcanConfig({});
  const client = createVulcanHostClient(config);
  const hostContext = buildBaseHostContext(config, "sync-memory");
  const memoryDescriptors = await client.listVmmMemoryTools(hostContext);
  const bindingDescriptors = await listOptionalBindingDescriptors(client, config);
  const descriptors = normalizeGeneratedDescriptors(
    [...memoryDescriptors, ...bindingDescriptors],
  );
  const bindingToolNames = listGeneratedBindingToolNames(descriptors);
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
    baseToolNames: [...STABLE_MEMORY_TOOL_NAMES],
    generatedToolNames: bindingToolNames,
  });

  // Memory keeps stable canonical memory names locally, while binding/admin names now prefer the synchronized host tool group.
  // 记忆插件在本地保持稳定 canonical 记忆工具名，同时让绑定/管理工具名优先取同步下来的宿主工具组。
  console.log(`Synced ${descriptors.length} VMM descriptors into ${generatedPath}.`);
  console.log(`Updated ${manifestPath} contracts.tools (${toolNames.length} total).`);
  console.log("Next: restart/reload the Gateway if OpenClaw keeps old memory tool descriptions.");
}

// listOptionalBindingDescriptors keeps sync usable against older vulcan-host runtimes that have not restarted onto the new binding-descriptor RPC yet.
// listOptionalBindingDescriptors 让同步脚本在 vulcan-host 尚未重启到新 binding-descriptor RPC 时仍然可以继续工作。
async function listOptionalBindingDescriptors(
  client: ReturnType<typeof createVulcanHostClient>,
  config: ReturnType<typeof resolveVulcanConfig>,
): Promise<Awaited<ReturnType<typeof client.listVmmBindingTools>>> {
  try {
    return await client.listVmmBindingTools(buildBaseHostContext(config, "sync-memory-binding"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/\bUNIMPLEMENTED\b/u.test(message)) {
      console.warn(
        "Binding descriptor RPC is not available on the currently running vulcan-host instance yet; continuing with memory descriptors only.",
      );
      return [];
    }
    throw error;
  }
}

// listGeneratedBindingToolNames extracts binding/admin tool names from synchronized descriptors and falls back to one bootstrap list when metadata is unavailable.
// listGeneratedBindingToolNames 从同步 descriptor 中提取绑定/管理工具名，并在元数据不可用时回退到引导期固定列表。
function listGeneratedBindingToolNames(descriptors: VulcanToolDescriptor[]): string[] {
  const names = descriptors
    .filter((descriptor) => readToolGroup(descriptor) === "vmm-binding")
    .map((descriptor) => descriptor.name);
  return names.length > 0 ? names : [...FALLBACK_BINDING_TOOL_NAMES];
}

// readToolGroup keeps only non-empty tool_group annotations so manifest sync can distinguish binding/admin descriptors from memory descriptors.
// readToolGroup 只保留非空的 tool_group 注解，让 manifest 同步能够区分绑定/管理 descriptor 与记忆 descriptor。
function readToolGroup(descriptor: VulcanToolDescriptor): string | undefined {
  const value = descriptor.annotations?.tool_group;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// resolvePackageRoot returns the package root regardless of the caller's cwd.
// resolvePackageRoot 无论调用方 cwd 如何都返回当前包根目录。
function resolvePackageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

await main();
