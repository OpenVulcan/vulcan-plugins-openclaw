// OpenClaw plugin entrypoint for Vulcan Memory Mesh access.
// 本文件是 Vulcan Memory Mesh 接入的 OpenClaw 插件入口。

import { resolveVulcanConfig } from "@vulcan-plugins-openclaw/shared";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createVulcanMemoryCapability } from "./memory-capability.js";
import { registerVulcanMemoryHooks } from "./hooks.js";
import {
  createMemoryGetTool,
  createMemorySearchTool,
  createVulcanMemoryGetTool,
  createVulcanMemorySearchTool,
} from "./tools.js";

// VULCAN_MEMORY_PLUGIN_ID is the manifest id and runtime id of this memory plugin.
// VULCAN_MEMORY_PLUGIN_ID 是该 memory 插件的 manifest id 与运行时 id。
export const VULCAN_MEMORY_PLUGIN_ID = "vulcan-memory";

export default definePluginEntry({
  id: VULCAN_MEMORY_PLUGIN_ID,
  name: "Vulcan Memory",
  description: "Connects OpenClaw native memory runtime, hooks, and tools to Vulcan Memory Mesh through vulcan-host.",
  kind: "memory",
  register(api) {
    const config = resolveVulcanConfig(api.pluginConfig);

    // Register the native memory capability first so OpenClaw can treat this package as the active memory-slot owner.
    // 先注册原生 memory capability，让 OpenClaw 把这个包视为当前 memory slot 的拥有者。
    api.registerMemoryCapability(createVulcanMemoryCapability(api, config));

    // Register canonical memory tools so the active memory slot exposes the standard OpenClaw memory_search/memory_get surface.
    // 注册 canonical memory 工具，让当前 memory slot 暴露标准的 OpenClaw memory_search/memory_get 接口。
    api.registerTool((ctx) => createMemorySearchTool({ api, config, ctx }), {
      name: "memory_search",
    });
    api.registerTool((ctx) => createMemoryGetTool({ api, config, ctx }), {
      name: "memory_get",
    });

    // Keep the grouped Vulcan compatibility tools for raw VMM-style inspection and operator workflows.
    // 保留分组式 Vulcan 兼容工具，供原始 VMM 风格排查与操作流程使用。
    api.registerTool((ctx) => createVulcanMemorySearchTool({ api, config, ctx }), {
      name: "vulcan_memory_search",
    });
    api.registerTool((ctx) => createVulcanMemoryGetTool({ api, config, ctx }), {
      name: "vulcan_memory_get",
    });

    // Hooks provide the full-mode path for automatic recall and later postaction.
    // hooks 提供自动召回和后续 postaction 的完整模式路径。
    registerVulcanMemoryHooks(api, config);
  },
});
