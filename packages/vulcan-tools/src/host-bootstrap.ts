// Runtime bootstrap service for starting vulcan-host automatically in local OpenClaw installs.
// 本文件负责在本地 OpenClaw 安装场景中自动拉起 vulcan-host 的运行时后台服务。

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { ResolvedVulcanConfig } from "@vulcan-plugins-openclaw/shared";
import type { OpenClawPluginApi, OpenClawPluginServiceContext } from "openclaw/plugin-sdk/plugin-entry";

// BOOTSTRAP_SERVICE_ID keeps the single host bootstrap owner stable inside the OpenClaw service registry.
// BOOTSTRAP_SERVICE_ID 用于在 OpenClaw service 注册表中保持唯一的 host 启动器归属。
const BOOTSTRAP_SERVICE_ID = "vulcan-host-bootstrap";

// DEFAULT_PORT_PROBE_TIMEOUT_MS bounds each lightweight TCP probe so Gateway startup does not stall.
// DEFAULT_PORT_PROBE_TIMEOUT_MS 用于限制每次轻量 TCP 探测时长，避免 Gateway 启动被拖慢。
const DEFAULT_PORT_PROBE_TIMEOUT_MS = 500;

// DEFAULT_PROBE_INTERVAL_MS spaces repeated readiness checks after the child process has been spawned.
// DEFAULT_PROBE_INTERVAL_MS 用于控制子进程拉起后的重复就绪探测间隔。
const DEFAULT_PROBE_INTERVAL_MS = 250;

// DEFAULT_PATH_COMMAND_CANDIDATES keeps one final PATH-based fallback when no explicit binary path was configured.
// DEFAULT_PATH_COMMAND_CANDIDATES 在未配置显式二进制路径时保留一组基于 PATH 的最终回退命令名。
const DEFAULT_PATH_COMMAND_CANDIDATES =
  process.platform === "win32" ? ["vulcan-mcp.exe", "vulcan-mcp"] : ["vulcan-mcp"];

// VulcanHostBootstrapState stores one process-wide child handle so hot reloads and duplicate startup paths stay idempotent.
// VulcanHostBootstrapState 保存进程级唯一子进程句柄，确保热重载与重复启动路径保持幂等。
interface VulcanHostBootstrapState {
  child: ChildProcess | null;
  descriptor: string | null;
  stopping: boolean;
}

// VulcanHostLaunchPlan describes the resolved command, cwd, and environment used to launch vulcan-host.
// VulcanHostLaunchPlan 描述启动 vulcan-host 时解析出的命令、工作目录与环境变量。
interface VulcanHostLaunchPlan {
  command: string;
  args: string[];
  cwd: string | undefined;
  env: NodeJS.ProcessEnv;
  descriptor: string;
}

// GLOBAL_BOOTSTRAP_STATE_KEY stores one stable bootstrap slot on globalThis for the current Gateway process.
// GLOBAL_BOOTSTRAP_STATE_KEY 在当前 Gateway 进程的 globalThis 上保存稳定的唯一启动槽位。
const GLOBAL_BOOTSTRAP_STATE_KEY = Symbol.for("vulcan.openclaw.host-bootstrap.state");

// registerVulcanHostBootstrapService registers the optional background autostart service owned by vulcan-tools.
// registerVulcanHostBootstrapService 注册由 vulcan-tools 持有的可选后台自启动服务。
export function registerVulcanHostBootstrapService(
  api: OpenClawPluginApi,
  config: ResolvedVulcanConfig,
): void {
  if (!config.host.autoStart) {
    return;
  }

  api.registerService({
    id: BOOTSTRAP_SERVICE_ID,
    start: async (ctx) => {
      await ensureVulcanHostRunning(api, config, ctx);
    },
    stop: async () => {
      await stopBootstrappedChild();
    },
  });
}

// ensureVulcanHostRunning starts vulcan-host only when the configured endpoint is currently unreachable.
// ensureVulcanHostRunning 只会在配置端点当前不可达时启动 vulcan-host。
async function ensureVulcanHostRunning(
  api: OpenClawPluginApi,
  config: ResolvedVulcanConfig,
  ctx: OpenClawPluginServiceContext,
): Promise<void> {
  const state = getBootstrapState();
  if (await isEndpointReachable(config.endpoint, DEFAULT_PORT_PROBE_TIMEOUT_MS)) {
    ctx.logger.debug?.(
      `vulcan-host bootstrap skipped because endpoint ${config.endpoint} is already reachable.`,
    );
    return;
  }

  if (state.child && !state.child.killed) {
    ctx.logger.debug?.(
      `vulcan-host bootstrap is already waiting on a child process (${state.descriptor ?? "unknown"}).`,
    );
    return;
  }

  const launchPlan = resolveLaunchPlan(config);
  if (!launchPlan) {
    ctx.logger.warn?.(
      [
        "vulcan-host autostart is enabled, but no launch command could be resolved.",
        "Set plugins.entries.vulcan-tools.config.host.command or VULCAN_HOST_COMMAND.",
      ].join(" "),
    );
    return;
  }

  // Spawn one background child only after the endpoint probe fails so manual/external hosts are never duplicated.
  // 只有在端点探测失败后才启动后台子进程，避免和手工/外部 host 重复启动。
  const child = spawn(launchPlan.command, launchPlan.args, {
    cwd: launchPlan.cwd,
    env: launchPlan.env,
    stdio: "ignore",
    shell: false,
    windowsHide: true,
  });

  child.unref();
  state.child = child;
  state.descriptor = launchPlan.descriptor;

  // Keep the singleton state synchronized with the real child lifecycle so future restarts remain deterministic.
  // 让单例状态与真实子进程生命周期保持同步，确保后续重启路径仍然可预测。
  child.once("error", (error) => {
    if (state.child === child) {
      state.child = null;
      state.descriptor = null;
    }
    ctx.logger.warn?.(`vulcan-host bootstrap failed to start: ${String(error)}`);
  });

  child.once("exit", (code, signal) => {
    if (state.child === child) {
      state.child = null;
      state.descriptor = null;
    }
    if (!state.stopping) {
      ctx.logger.warn?.(
        `vulcan-host bootstrap child exited before plugin shutdown (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
      );
    }
  });

  const ready = await waitForEndpointReady(
    config.endpoint,
    config.host.readyTimeoutMs,
    DEFAULT_PORT_PROBE_TIMEOUT_MS,
  );

  if (ready) {
    ctx.logger.info?.(`vulcan-host autostart ready via ${launchPlan.descriptor}.`);
    return;
  }

  ctx.logger.warn?.(
    `vulcan-host autostart launched ${launchPlan.descriptor}, but ${config.endpoint} did not become reachable within ${config.host.readyTimeoutMs}ms.`,
  );
}

// stopBootstrappedChild stops the child only when this Gateway process previously launched it.
// stopBootstrappedChild 只会在当前 Gateway 进程此前亲自拉起子进程时尝试停止它。
async function stopBootstrappedChild(): Promise<void> {
  const state = getBootstrapState();
  const child = state.child;
  if (!child || child.killed) {
    state.child = null;
    state.descriptor = null;
    return;
  }

  state.stopping = true;
  try {
    child.kill();
    await waitForChildExit(child, 3_000);
  } finally {
    state.child = null;
    state.descriptor = null;
    state.stopping = false;
  }
}

// getBootstrapState resolves or initializes the process-wide bootstrap state container.
// getBootstrapState 解析或初始化进程级唯一启动状态容器。
function getBootstrapState(): VulcanHostBootstrapState {
  const globalRecord = globalThis as typeof globalThis & {
    [GLOBAL_BOOTSTRAP_STATE_KEY]?: VulcanHostBootstrapState;
  };
  if (!globalRecord[GLOBAL_BOOTSTRAP_STATE_KEY]) {
    globalRecord[GLOBAL_BOOTSTRAP_STATE_KEY] = {
      child: null,
      descriptor: null,
      stopping: false,
    };
  }
  return globalRecord[GLOBAL_BOOTSTRAP_STATE_KEY]!;
}

// resolveLaunchPlan builds one concrete launch plan from config, env, and common local binary locations.
// resolveLaunchPlan 基于配置、环境变量与常见本地二进制位置构建一份具体启动计划。
function resolveLaunchPlan(config: ResolvedVulcanConfig): VulcanHostLaunchPlan | null {
  const fileCandidates = [
    config.host.command,
    process.env.VULCAN_HOST_COMMAND,
    ...deriveProtoPathCommandCandidates(config.protoPath),
  ].filter((candidate): candidate is string => typeof candidate === "string" && Boolean(candidate.trim()));

  // Prefer concrete filesystem paths first so local developer installs stay deterministic across shells.
  // 优先使用明确的文件系统路径，确保本地开发安装在不同 shell 下仍保持确定性。
  for (const rawCandidate of fileCandidates) {
    const candidate = rawCandidate.trim();
    if (!candidate) {
      continue;
    }
    if (!looksLikeFilesystemCommand(candidate)) {
      return buildLaunchPlan(config, candidate, candidate);
    }
    const resolved = path.resolve(candidate);
    if (!fs.existsSync(resolved)) {
      continue;
    }
    return buildLaunchPlan(config, resolved, resolved);
  }

  for (const candidate of DEFAULT_PATH_COMMAND_CANDIDATES) {
    return buildLaunchPlan(config, candidate, candidate);
  }

  return null;
}

// buildLaunchPlan constructs the final spawn options after one command candidate has been chosen.
// buildLaunchPlan 在选定命令候选后构建最终的 spawn 选项。
function buildLaunchPlan(
  config: ResolvedVulcanConfig,
  command: string,
  descriptor: string,
): VulcanHostLaunchPlan {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...config.host.env,
  };

  // Mirror endpoint and proto path into the child environment so a plain vulcan-mcp binary can bootstrap correctly.
  // 将端点与 proto 路径同步到子进程环境中，确保裸 vulcan-mcp 二进制也能正确启动。
  if (!env.VULCAN_HOST_GRPC_ENDPOINT) {
    env.VULCAN_HOST_GRPC_ENDPOINT = config.endpoint;
  }
  if (!env.VULCAN_HOST_PROTO_PATH && config.protoPath) {
    env.VULCAN_HOST_PROTO_PATH = config.protoPath;
  }

  return {
    command,
    args: [...config.host.args],
    cwd: config.host.cwd ?? (path.isAbsolute(command) ? path.dirname(command) : undefined),
    env,
    descriptor,
  };
}

// deriveProtoPathCommandCandidates infers likely vulcan-mcp binary locations from the configured proto path.
// deriveProtoPathCommandCandidates 根据配置的 proto 路径推断可能的 vulcan-mcp 二进制位置。
function deriveProtoPathCommandCandidates(protoPath: string | undefined): string[] {
  if (!protoPath) {
    return [];
  }

  const repoRoot = path.resolve(path.dirname(protoPath), "..", "..");
  return process.platform === "win32"
    ? [
        path.join(repoRoot, "target", "release", "vulcan-mcp.exe"),
        path.join(repoRoot, "target", "debug", "vulcan-mcp.exe"),
      ]
    : [
        path.join(repoRoot, "target", "release", "vulcan-mcp"),
        path.join(repoRoot, "target", "debug", "vulcan-mcp"),
      ];
}

// looksLikeFilesystemCommand distinguishes absolute/relative executable paths from bare PATH commands.
// looksLikeFilesystemCommand 区分绝对/相对可执行路径与裸 PATH 命令名。
function looksLikeFilesystemCommand(command: string): boolean {
  return path.isAbsolute(command) || command.includes("\\") || command.includes("/");
}

// waitForEndpointReady repeatedly probes the endpoint until it becomes reachable or the timeout expires.
// waitForEndpointReady 会循环探测端点，直到端点可达或超时结束。
async function waitForEndpointReady(
  endpoint: string,
  timeoutMs: number,
  probeTimeoutMs: number,
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (await isEndpointReachable(endpoint, probeTimeoutMs)) {
      return true;
    }
    await delay(DEFAULT_PROBE_INTERVAL_MS);
  }
  return false;
}

// isEndpointReachable performs one cheap TCP connect probe against the configured gRPC endpoint.
// isEndpointReachable 对配置的 gRPC 端点执行一次轻量 TCP 连接探测。
async function isEndpointReachable(endpoint: string, timeoutMs: number): Promise<boolean> {
  const target = parseTcpEndpoint(endpoint);
  if (!target) {
    return false;
  }

  return await new Promise<boolean>((resolve) => {
    const socket = new net.Socket();

    const finalize = (value: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finalize(true));
    socket.once("timeout", () => finalize(false));
    socket.once("error", () => finalize(false));
    socket.connect(target.port, target.host);
  });
}

// parseTcpEndpoint normalizes one host:port gRPC endpoint into socket-ready coordinates.
// parseTcpEndpoint 把一个 host:port 形式的 gRPC 端点归一化为可用于 socket 的坐标。
function parseTcpEndpoint(endpoint: string): { host: string; port: number } | null {
  const normalized = endpoint.replace(/^https?:\/\//u, "").trim();
  if (!normalized) {
    return null;
  }

  const authority = normalized.split("/")[0]?.trim();
  if (!authority) {
    return null;
  }

  if (authority.startsWith("[")) {
    const match = /^\[(.+)\]:(\d+)$/u.exec(authority);
    if (!match) {
      return null;
    }
    const port = Number.parseInt(match[2] ?? "", 10);
    return Number.isFinite(port) && port > 0 ? { host: match[1] ?? "", port } : null;
  }

  const separatorIndex = authority.lastIndexOf(":");
  if (separatorIndex <= 0) {
    return null;
  }
  const host = authority.slice(0, separatorIndex).trim();
  const port = Number.parseInt(authority.slice(separatorIndex + 1), 10);
  if (!host || !Number.isFinite(port) || port <= 0) {
    return null;
  }
  return { host, port };
}

// waitForChildExit waits briefly for a child process to terminate after a stop request.
// waitForChildExit 在发送停止请求后短暂等待子进程退出。
async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve();
      }
    }, timeoutMs);
    timer.unref?.();

    child.once("exit", () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve();
    });
  });
}

// delay creates one small async wait used by repeated endpoint probes.
// delay 创建一个供重复端点探测复用的小型异步等待。
function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
}
