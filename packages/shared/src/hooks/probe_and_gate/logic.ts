/**
 * A. SessionStart —— capabilities 探测 + trust_mode 切换门
 * (规范源: design §3.4 / §5 / §0.3)。
 *
 * 会话启动时:
 *   1. 探测宿主能力 (git 可用 / fs 可写)。
 *   2. 无活跃 run → 注入 capabilities 提示, 放行 (不干扰 loop 之外的会话)。
 *   3. 活跃 run + trust_mode=unattended + 无 §0.3 独立复跑通道 → block (拒绝静默降级)。
 *   4. 活跃 run + collaborative → 注入 active_run + trust_mode + capabilities, 放行。
 *
 * SessionStart 异常时**退化放行** (与其它 hook 的 fail-safe=deny 不同), 不锁死会话。
 *
 * §0.3 独立复跑通道探测在仓库内尚未实现 (设计 §0.3 保留项, MVP 未落地);
 * 当前 unattended 档总是判定"通道未就绪" → block。
 * 行为与 @e2e-loop/ssot/trust_mode (gate.ts) 的 probeUnattendedReadiness 一致;
 * hook 不直接 import ssot-ts (shared 不能反向依赖 ssot-ts), 但语义对齐。
 */

import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { HookInput, HookOutput } from "../../types.js";
import {
  injectContext,
  deny,
  passSilent,
  safeReadRunState,
} from "../common.js";
import { findActiveRun } from "../../runs.js";
import { readWorktreeMarker } from "../../worktree_marker.js";

/** 探测到的宿主能力 (Python `RunCapabilities` 等价)。 */
export interface Capabilities {
  git_diff: boolean;
  fs_snapshot: boolean;
  /** 探测异常时的错误信息 (Python `probe_error` 等价) */
  probe_error?: string;
}

/**
 * 探测宿主能力 (Python `scheduling/capabilities.py:probe_capabilities` 等价)。
 *
 *   - git_diff: `git --version` 返回 0 即认为 git 可用 (能跑 `git diff --name-only`)
 *   - fs_snapshot: 试写临时文件 `.e2e-loop-probe-<rand>` 后删, 成功即认为 fs 可遍历
 *
 * 异常时返回 `{git_diff:false, fs_snapshot:false, probe_error}`; 不抛。
 */
export function probeCapabilities(repoRoot: string): Capabilities {
  let git_diff = false;
  let fs_snapshot = false;

  try {
    const r = cp.execFileSync("git", ["--version"], {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    git_diff = /^git version /m.test(r);
  } catch {
    git_diff = false;
  }

  try {
    const probe = path.join(
      repoRoot,
      `.e2e-loop-probe-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
    );
    fs.writeFileSync(probe, "ok", { flag: "wx" });
    try {
      fs.unlinkSync(probe);
    } catch {
      /* 删除失败不影响判定: 能写就够 */
    }
    fs_snapshot = true;
  } catch {
    fs_snapshot = false;
  }

  return { git_diff, fs_snapshot };
}

/**
 * §0.3 独立复跑通道就绪判定 (与 @e2e-loop/ssot/trust_mode 的 probeUnattendedReadiness 行为对齐;
 * hook 不能直接 import ssot-ts, 故本模块内独立实现)。
 *
 * 当前实现: 总是返回"未就绪"——独立复跑通道是 design §0.3 保留项, 仓库内尚未实现。
 * unattended 档因此被拒绝 (拒绝静默降级, §5)。
 *
 * 通道实现落地后 (跨进程 IPC / 子进程健康检查), 把本函数改为真实探测。
 */
export function probeUnattendedReadiness(): {
  ready: boolean;
  reasons: string[];
} {
  return {
    ready: false,
    reasons: ["独立复跑通道未建 (§0.3 保留项, 仓库内未实现)"],
  };
}

/**
 * probe_and_gate 主入口 (Python `main` 等价)。
 *
 * SessionStart 异常 fail-safe = **退化放行** (不锁死会话)。
 */
export async function handle(input: HookInput): Promise<HookOutput> {
  try {
    // 1. 探测能力
    let caps: Capabilities;
    try {
      caps = probeCapabilities(input.cwd);
    } catch (e) {
      caps = {
        git_diff: false,
        fs_snapshot: false,
        probe_error: String(e),
      };
    }

    // 2. 无活跃 run → 注入 capabilities 提示, 放行
    const active = findActiveRun(input.cwd);
    if (active === null) {
      return injectContext({
        loop_engineering_session_start: true,
        active_run: null,
        capabilities: caps,
        note: "无活跃 run; loop-engineering hooks 已就位",
      });
    }

    // 改动② (worktree-only 一致性正向自检): 用 cwd 的根 marker 校验绑定的 run 与当前
    // active run 是否一致。不一致 → 注入 worktree 错位 warning (可能是 worktree 复用/状态错位)。
    // marker 一致 或 无 marker → markerWarning 为 null, 维持现有行为不变。
    let markerWarning: string | null = null;
    const marker = readWorktreeMarker(input.cwd);
    if (marker !== null && marker.run_id !== active.runId) {
      markerWarning =
        `worktree marker 绑定的 run (${marker.run_id}) 与当前 active run (${active.runId}) 不一致; ` +
        "可能是 worktree 复用或状态错位, 请确认当前会话是否在正确的 run worktree 内。";
    }

    // 3. 读 run-state; 缺失/不可解析 → 仅提示
    const state = safeReadRunState({ ...input, runDir: active.runDir });
    if (state === null) {
      const payload: Record<string, unknown> = {
        loop_engineering_session_start: true,
        active_run: active.runDir,
        capabilities: caps,
        warning: "run 目录存在但 run-state.json 缺失或不可解析",
      };
      if (markerWarning !== null) payload.worktree_marker_warning = markerWarning;
      return injectContext(payload);
    }

    const tm = state.trust_mode;
    const phase = state.phase;

    // 4. trust_mode=unattended 必须 §0.3 通道就绪 (拒绝静默降级, design §5)
    if (tm === "unattended") {
      const readiness = probeUnattendedReadiness();
      if (!readiness.ready) {
        return deny(
          `trust_mode=unattended 但独立复跑通道未就绪 (§0.3): ${readiness.reasons.join("; ")}; ` +
            "拒绝静默降级 (§5)",
        );
      }
    }

    // 5. 注入 capabilities + run 状态
    const payload: Record<string, unknown> = {
      loop_engineering_session_start: true,
      active_run: active.runDir,
      phase,
      trust_mode: tm,
      human_pending: state.human_pending ?? "",
      capabilities_detected: caps,
      capabilities_recorded: state.capabilities ?? null,
      note:
        "actual_writes 采集优先级: git_diff > fs_snapshot > worker_self_report (§3.4); " +
        "若 detected 与 recorded 不一致, 主 agent 应协调者写新 capabilities",
    };
    if (markerWarning !== null) payload.worktree_marker_warning = markerWarning;
    return injectContext(payload);
  } catch (e) {
    // SessionStart 异常 fail-safe: 退化放行, 不锁死会话
    void os; // 防 import 未用 (Node 内置, 始终可用, 此处显式 noop)
    return passSilent();
  }
}

/*
 * 用例预期 (从 Python tests/test_hooks_smoke.py 翻译, T5 落地):
 *
 *   1. 无活跃 run + git/fs 可用 → defer; context.capabilities.git_diff=true
 *   2. 无活跃 run + 无 git → defer; context.capabilities.git_diff=false (不 block)
 *   3. 活跃 run + trust_mode=collaborative → defer; context.trust_mode="collaborative"
 *   4. 活跃 run + trust_mode=unattended → deny; reason 含 "unattended" 和 "§0.3"
 *   5. run-state.json 缺失 → defer; context.warning 含 "run-state.json"
 *   6. 内部异常 → allow (退化放行, 不锁死)
 */
