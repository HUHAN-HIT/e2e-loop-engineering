/**
 * 宿主能力探测 (design §3.4)。
 *
 * 行为权威: Python `loop_engineering/scheduling/capabilities.py`。
 * 规范源: design §3.4 —— run 启动 (CREATED) 时 coordinator 一次性探测 git/fs diff 能力,
 * 写入 run-state.capabilities, 此后整个 run 的 actual_writes 采集路径据此固定。
 *
 * 不预设 True, 以探测结果为准 (§3.4 原文)。任何探测异常都被吞掉返回 False,
 * 避免脏环境导致 run 启动失败。
 *
 * 可注入的探测 seam (对齐 Python 测试用 `unittest.mock.patch` 替换 subprocess.run / Path.exists
 * 的做法): `gitProbe` / `fsProbe` 默认走真实实现, 测试可注入桩函数复刻 mock 场景。
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";

import type { RunCapabilities } from "../schema/run_state.js";
import { RunCapabilitiesSchema } from "../schema/run_state.js";

/** git/fs 探测 seam 类型: 输入 workdir, 输出布尔能力。 */
export type CapabilityProbe = (workdir: string) => boolean;

/**
 * 跑 `git -C <workdir> rev-parse --is-inside-work-tree`。
 *
 * 退出码 0 且 stdout 含 'true' → True。任何异常 / 非零退出 / 超时 → False。
 * 不 raise, 不污染 stderr (stderr 重定向到忽略)。
 */
export function checkGitAvailable(workdir: string): boolean {
  try {
    const out = execFileSync(
      "git",
      ["-C", workdir, "rev-parse", "--is-inside-work-tree"],
      { encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] },
    );
    return (out || "").trim().includes("true");
  } catch {
    // 非 git / git 不存在 / 非零退出 / 超时 → False。
    return false;
  }
}

/**
 * workdir 存在且为目录 → True。
 *
 * 不实际做快照 (快照逻辑在 actual_writes)。此处只验证基本可访问性。
 */
export function checkFsSnapshotAvailable(workdir: string): boolean {
  try {
    return fs.existsSync(workdir) && fs.statSync(workdir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * CREATED 时一次性探测宿主能力, 返回 `RunCapabilities{git_diff, fs_snapshot}`。
 *
 * 顺序与优先级 (§3.4): git_diff 优先; fs_snapshot 始终尝试 (workdir 不可读时为 False)。
 * 探测结果固化为 RunCapabilities (经 zod 校验), 由 coordinator 写入 run-state。
 *
 * @param workdir 工作目录
 * @param gitProbe 可注入的 git 探测桩 (默认 checkGitAvailable)
 * @param fsProbe  可注入的 fs 探测桩 (默认 checkFsSnapshotAvailable)
 */
export function probeCapabilities(
  workdir: string,
  gitProbe: CapabilityProbe = checkGitAvailable,
  fsProbe: CapabilityProbe = checkFsSnapshotAvailable,
): RunCapabilities {
  return RunCapabilitiesSchema.parse({
    git_diff: gitProbe(workdir),
    fs_snapshot: fsProbe(workdir),
  });
}
