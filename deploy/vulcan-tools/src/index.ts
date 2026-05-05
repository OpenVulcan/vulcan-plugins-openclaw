// OpenClaw plugin entrypoint for Vulcan LuaSkills tool access.
// 本文件是 Vulcan LuaSkills 工具接入的 OpenClaw 插件入口。

import { resolveVulcanConfig } from "@vulcan-plugins-openclaw/shared";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerVulcanCommands } from "./commands.js";
import { GENERATED_LUASKILL_TOOLS } from "./generated/tools.generated.js";
import { createGeneratedLuaSkillTool, createLuaSkillDispatcherTool } from "./tools.js";

// VULCAN_TOOLS_PLUGIN_ID is the manifest id and runtime id of this tool plugin.
// VULCAN_TOOLS_PLUGIN_ID 是该工具插件的 manifest id 与运行时 id。
export const VULCAN_TOOLS_PLUGIN_ID = "vulcan-tools";

export default definePluginEntry({
  id: VULCAN_TOOLS_PLUGIN_ID,
  name: "Vulcan Tools",
  description: "Proxies Vulcan LuaSkills tools into OpenClaw through vulcan-host.",
  register(api) {
    const config = resolveVulcanConfig(api.pluginConfig);

    // Register the low-fidelity dispatcher first so the plugin remains usable before manifest sync.
    // 先注册低保真 dispatcher，确保 manifest 同步前插件仍可用于调试和降级。
    api.registerTool((ctx) => createLuaSkillDispatcherTool({ api, config, ctx }), {
      name: "vulcan_luaskill_call",
    });

    // Register generated first-class proxies after dispatcher so AI can use exact LuaSkills schemas.
    // 在 dispatcher 之后注册生成的一等代理，让 AI 可以使用精确的 LuaSkills schema。
    for (const descriptor of GENERATED_LUASKILL_TOOLS) {
      api.registerTool((ctx) => createGeneratedLuaSkillTool({ api, config, ctx, descriptor }), {
        name: descriptor.name,
      });
    }

    // Register commands for status, inventory, lifecycle, and sync guidance outside model tools.
    // 将状态、清单、生命周期和同步提示注册为命令，避免暴露成模型普通工具。
    registerVulcanCommands(api, config);
  },
});
