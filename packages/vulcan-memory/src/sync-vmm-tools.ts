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

// FALLBACK_MEMORY_TOOL_NAMES keeps one bootstrap memory manifest set whose order already prefers explicit Vulcan tools over legacy bridges.
// FALLBACK_MEMORY_TOOL_NAMES 保留一套引导期记忆 manifest 工具名，并在顺序上优先显式 Vulcan 工具而不是旧式桥接工具。
const FALLBACK_MEMORY_TOOL_NAMES = [
  "vulcan_memory_search",
  "vulcan_memory_get",
  "memory_search",
  "memory_get",
] as const;

// FALLBACK_BINDING_TOOL_NAMES keeps one bootstrap compact binding/admin tool name for older vulcan-host runtimes.
// FALLBACK_BINDING_TOOL_NAMES 为旧版 vulcan-host 保留一个引导期精简绑定/管理工具名。
const FALLBACK_BINDING_TOOL_NAMES = ["vulcan_bind"] as const;

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
  const memoryToolNames = listGeneratedMemoryToolNames(descriptors);
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
    baseToolNames: memoryToolNames,
    generatedToolNames: bindingToolNames,
  });

  // Memory and binding/admin manifest names now prefer synchronized descriptor annotations, with local lists kept only as bootstrap fallback.
  // 记忆与绑定/管理 manifest 工具名现在优先使用同步 descriptor 注解，本地列表仅保留为引导期回退。
  console.log(`Synced ${descriptors.length} VMM descriptors into ${generatedPath}.`);
  console.log(`Updated ${manifestPath} contracts.tools (${toolNames.length} total).`);
  console.log("Next: restart/reload the Gateway if OpenClaw keeps old memory tool descriptions.");
}

// listGeneratedMemoryToolNames extracts explicit Vulcan tools first and leaves canonical bridges after them so host manifests prefer the Vulcan-native surface.
// listGeneratedMemoryToolNames 先提取显式 Vulcan 工具，再附加 canonical 桥接工具，让宿主 manifest 优先选择 Vulcan 原生表面。
function listGeneratedMemoryToolNames(descriptors: VulcanToolDescriptor[]): string[] {
  const primaryNames = descriptors
    .filter((descriptor) => readToolGroup(descriptor) === "vmm-memory")
    .filter((descriptor) => readVisibility(descriptor) !== "advanced")
    .filter((descriptor) => {
      const surface = readRegistrationSurface(descriptor);
      return surface === "host-memory-compat";
    })
    .map((descriptor) => descriptor.name);
  const bridgeNames = descriptors
    .filter((descriptor) => readToolGroup(descriptor) === "vmm-memory")
    .filter((descriptor) => readVisibility(descriptor) !== "advanced")
    .filter((descriptor) => readRegistrationSurface(descriptor) === "host-memory-canonical")
    .map((descriptor) => descriptor.name);
  const names = [...primaryNames, ...bridgeNames];
  return names.length > 0 ? names : [...FALLBACK_MEMORY_TOOL_NAMES];
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

// listGeneratedBindingToolNames extracts the compact binding/admin tool from synchronized descriptors and falls back to one bootstrap name when metadata is unavailable.
// listGeneratedBindingToolNames 从同步 descriptor 中提取精简绑定/管理工具名，并在元数据不可用时回退到引导期固定名称。
function listGeneratedBindingToolNames(descriptors: VulcanToolDescriptor[]): string[] {
  const names = descriptors
    .filter((descriptor) => readToolGroup(descriptor) === "vmm-binding")
    .filter((descriptor) => {
      const visibility = readVisibility(descriptor);
      return visibility === undefined || visibility === "admin";
    })
    .filter((descriptor) => readRegistrationSurface(descriptor) === "host-binding-consolidated")
    .map((descriptor) => descriptor.name);
  return names.length > 0 ? names : [...FALLBACK_BINDING_TOOL_NAMES];
}

// readToolGroup keeps only non-empty tool_group annotations so manifest sync can distinguish binding/admin descriptors from memory descriptors.
// readToolGroup 只保留非空的 tool_group 注解，让 manifest 同步能够区分绑定/管理 descriptor 与记忆 descriptor。
function readToolGroup(descriptor: VulcanToolDescriptor): string | undefined {
  const value = descriptor.annotations?.tool_group;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// readRegistrationSurface keeps only non-empty registration-surface annotations so hosts can derive the intended manifest surface without hard-coded tool ids.
// readRegistrationSurface 只保留非空注册面注解，让宿主无需硬编码工具标识也能推导目标 manifest 表面。
function readRegistrationSurface(descriptor: VulcanToolDescriptor): string | undefined {
  const value = descriptor.annotations?.registration_surface;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// readVisibility keeps only non-empty visibility annotations so host manifest sync can distinguish public, advanced, and admin descriptor surfaces generically.
// readVisibility 只保留非空可见性注解，让宿主 manifest 同步能够通用地区分 public、advanced 与 admin 描述面。
function readVisibility(descriptor: VulcanToolDescriptor): string | undefined {
  const value = descriptor.annotations?.visibility;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// resolvePackageRoot returns the package root regardless of the caller's cwd.
// resolvePackageRoot 无论调用方 cwd 如何都返回当前包根目录。
function resolvePackageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

await main();
