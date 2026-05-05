// OpenClaw tool result helpers for Vulcan proxy tools.
// 本文件提供 Vulcan 代理工具使用的 OpenClaw 工具结果辅助函数。

import type { AgentToolResult } from "openclaw/plugin-sdk/plugin-entry";
import type { JsonValue, VulcanToolCallResponse } from "./types.js";

// textToolResult returns a normal text result to the model.
// textToolResult 向模型返回普通文本结果。
export function textToolResult(text: string, details?: unknown): AgentToolResult {
  return {
    content: [{ type: "text", text }],
    ...(details === undefined ? {} : { details }),
  };
}

// jsonToolResult returns a pretty-printed JSON result for diagnostics and command-like tools.
// jsonToolResult 为诊断与命令类工具返回格式化 JSON 结果。
export function jsonToolResult(value: JsonValue, details?: unknown): AgentToolResult {
  return textToolResult(JSON.stringify(value, null, 2), details ?? value);
}

// errorToolResult returns a tool-level error result without throwing through OpenClaw runtime.
// errorToolResult 返回工具级错误结果，而不是让错误穿透 OpenClaw 运行时。
export function errorToolResult(message: string, details?: unknown): AgentToolResult {
  return {
    content: [{ type: "text", text: message }],
    details,
    isError: true,
  };
}

// normalizeVulcanToolResult converts vulcan-host tool responses into OpenClaw tool results.
// normalizeVulcanToolResult 将 vulcan-host 工具响应转换为 OpenClaw 工具结果。
export function normalizeVulcanToolResult(response: VulcanToolCallResponse): AgentToolResult {
  if (response.isError) {
    return errorToolResult(response.message || response.text || "Vulcan tool call failed.", {
      result: response.result,
    });
  }
  if (response.result && typeof response.result === "object" && "content" in response.result) {
    return response.result as AgentToolResult;
  }
  return textToolResult(response.text || JSON.stringify(response.result ?? {}, null, 2), {
    result: response.result,
  });
}
