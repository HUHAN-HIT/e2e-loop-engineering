/**
 * Run 目录初始化与 run-state.json / task-plan.yaml 原子读写 (design §6)。
 *
 * 行为权威: Python `loop_engineering/runtime/directory.py` + schema 的 to_json_file /
 * to_yaml_file (run-state.json 用 exclude_none=True; task-plan.yaml 用 exclude_none=False)。
 * 规范源: design §6 (Run 目录与 schema)。
 *
 * coordinator 是 run-state.json 的单写者, 但本模块提供底层原子写工具。任何调用方都应通过
 * 本模块读写 run-state / task-plan。
 *
 * run_id 格式: YYYYMMDD-NNN (按当日已有 run 数取最大序号 +1, 避免冲突)。
 *
 * 与 Python 的差异处理:
 * - schema 在 TS 是 zod 纯数据 (无 to_json_file/to_yaml_file 实例方法), 故序列化逻辑落在
 *   本模块: writeRunState 走 JSON.stringify + 剔除 null/undefined (对齐 exclude_none=True);
 *   write/read TaskPlan 走 js-yaml (保留 null, 对齐 exclude_none=False)。
 * - Windows 文件锁竞态: Python `os.replace` 重试 5 次退避 25ms。Node `fs.renameSync` 在杀软
 *   扫描下偶发 EPERM/EBUSY, 用同步忙等复刻同样的重试逻辑 (atomicReplace)。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { FsSnapshot } from "../dispatch/collect.js";
import type { WorkerPacket } from "../dispatch/packet.js";
import type { TaskCheckItem } from "../checklists/task_check.js";
import { parseRunState } from "../schema/run_state.js";
import type { RunState } from "../schema/run_state.js";
import { parseTaskPlan } from "../schema/task_plan.js";
import { parseTaskDetail } from "../schema/task_detail.js";
import type { TaskPlan } from "../schema/task_plan.js";
import type { TaskDetail } from "../schema/task_detail.js";
import { parseYamlSafe } from "@e2e-loop/shared";
import { dumpTaskPlanYaml } from "./yaml_io.js";

/** design §6 子目录清单 (tasks 下每个 task 还会有自己的 <id>/ 子目录)。 */
export const RUN_SUBDIRS: readonly string[] = [
  "input",
  "clarification",
  "planning",
  "tasks",
  "wrap-up",
];

/**
 * 建 runs/<run_id>/ 与子目录, 写 input/requirement.md。返回 runDir。
 *
 * @throws Error run_dir 已存在 (run_id 必须唯一)。
 */
export function initRunDir(
  runsRoot: string,
  runId: string,
  requirementText: string,
): string {
  const runDir = path.join(runsRoot, runId);
  if (fs.existsSync(runDir)) {
    throw new Error(`run_dir 已存在: ${runDir} (run_id 必须唯一)`);
  }

  fs.mkdirSync(runsRoot, { recursive: true });
  fs.mkdirSync(runDir);
  for (const sub of RUN_SUBDIRS) {
    fs.mkdirSync(path.join(runDir, sub));
  }

  // 写 input/requirement.md
  fs.writeFileSync(path.join(runDir, "input", "requirement.md"), requirementText, "utf-8");
  return runDir;
}

/**
 * 把对象中值为 null / undefined 的键递归剔除 (对齐 Pydantic `exclude_none=True`)。
 *
 * 仅处理普通对象与数组; 其它原始值原样返回。run-state.json 用此保持极简
 * (非 ABORTED 时不出现 aborted_at/aborted_reason; human_pending=null 不落盘)。
 */
function stripNone(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => stripNone(v));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === null || v === undefined) continue;
      out[k] = stripNone(v);
    }
    return out;
  }
  return value;
}

/**
 * 原子写 run-state.json (写到同目录 tmp 再 rename, 防半写状态)。
 *
 * 单写者约束由 coordinator 维护, 本函数不强制加锁。
 * 序列化对齐 Python `model_dump_json(exclude_none=True, indent=2)`: 先 zod 解析补默认值,
 * 再剔除 null/undefined。
 * Windows 文件锁竞态: rename 偶发 EPERM (杀软扫描 / 句柄未释放), 重试 5 次 (退避 25ms)。
 */
export function writeRunState(runDir: string, state: RunState): void {
  fs.mkdirSync(runDir, { recursive: true });
  const target = path.join(runDir, "run-state.json");
  // 经 zod 解析 (补默认值并校验 ABORTED 一致性) 后剔除 None, 对齐 exclude_none。
  const validated = parseRunState(state);
  const payload = `${JSON.stringify(stripNone(validated), null, 2)}`;

  // 同目录 tmp, 保证 rename 原子 (跨设备 rename 非原子)。
  const tmpPath = path.join(
    runDir,
    `.run-state-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    fs.writeFileSync(tmpPath, payload, "utf-8");
    atomicReplace(tmpPath, target);
  } catch (err) {
    // 出错清掉 tmp, 不留垃圾。
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/** rename 注入 seam (默认 fs.renameSync; 测试可注入桩复刻杀软锁竞态)。 */
export type RenameFn = (src: string, dst: string) => void;

/**
 * Windows 友好的原子替换: 失败重试, 处理杀软 / 文件锁竞态
 * (复刻 Python `_atomic_replace`: 重试 5 次, 每次退避 25ms)。
 *
 * Node 无同步 sleep, 用忙等 (busy-wait) 实现退避 —— 与 Python `time.sleep` 等价的阻塞语义,
 * 单写者路径上偶发重试, 不在 hot loop, 25ms 忙等可接受。
 *
 * renameFn 通过参数注入 (对齐 capabilities 子包 gitProbe/fsProbe 的可注入 seam 风格),
 * 默认走真实 fs.renameSync; 测试注入桩来模拟前 N 次 EPERM/EBUSY 失败 —— 无需 monkey-patch
 * 只读的 fs 命名空间。
 */
export function atomicReplace(
  src: string,
  dst: string,
  retries = 5,
  backoffMs = 25,
  renameFn: RenameFn = (s, d) => fs.renameSync(s, d),
): void {
  let lastErr: unknown = null;
  for (let i = 0; i < retries; i += 1) {
    try {
      renameFn(src, dst);
      return;
    } catch (err) {
      lastErr = err;
      if (i < retries - 1) {
        sleepSync(backoffMs);
      }
    }
  }
  throw lastErr;
}

/** 同步忙等 ms 毫秒 (无原生同步 sleep; 单写者重试路径偶发调用)。 */
function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* busy wait */
  }
}

/**
 * 读 run-state.json + parse。文件不存在 → throw。
 */
export function readRunState(runDir: string): RunState {
  const target = path.join(runDir, "run-state.json");
  if (!fs.existsSync(target)) {
    throw new Error(`run-state.json 不存在: ${target}`);
  }
  const data: unknown = JSON.parse(fs.readFileSync(target, "utf-8"));
  return parseRunState(data);
}

/**
 * 原子写 planning/task-plan.yaml (对齐 Python `to_yaml_file`: sort_keys=False,
 * exclude_none=False —— 保留 null 字段如 service: null)。
 *
 * 复用 writeRunState 的同目录 tmp + 原子 rename 重试模式, 防半写。
 */
export function writeTaskPlan(planPath: string, plan: TaskPlan): void {
  const dir = path.dirname(planPath);
  fs.mkdirSync(dir, { recursive: true });
  const payload = dumpTaskPlanYaml(plan);

  const tmpPath = path.join(
    dir,
    `.task-plan-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    fs.writeFileSync(tmpPath, payload, "utf-8");
    atomicReplace(tmpPath, planPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/**
 * 从 planning/task-plan.yaml 读 + parse。文件不存在 → throw。
 *
 * YAML 语法错误 (如 plan-agent 手写 scenario 值含未引用冒号) → 抛带文件/行号/冒号提示的
 * 可读错误 (parseYamlSafe/describeYamlError), 而非裸 js-yaml 堆栈 —— 否则每个重建
 * Coordinator 的 CLI 子命令都会在构造函数崩且报错不可读。
 */
export function readTaskPlan(planPath: string): TaskPlan {
  if (!fs.existsSync(planPath)) {
    throw new Error(`task-plan.yaml 不存在: ${planPath}`);
  }
  const text = fs.readFileSync(planPath, "utf-8");
  const res = parseYamlSafe(planPath, text);
  if (!res.ok) throw new Error(res.message);
  return parseTaskPlan(res.data);
}

/** 从 planning/task-details/<id>.yaml 读 + parse。文件不存在 → throw; YAML 语法错 → 可读诊断。 */
export function readTaskDetail(detailPath: string): TaskDetail {
  if (!fs.existsSync(detailPath)) {
    throw new Error(`task detail 不存在: ${detailPath}`);
  }
  const text = fs.readFileSync(detailPath, "utf-8");
  const res = parseYamlSafe(detailPath, text);
  if (!res.ok) throw new Error(res.message);
  return parseTaskDetail(res.data);
}

/** 建 tasks/<id>/ 与 logs/ 子目录。已存在不报错 (幂等)。 */
export function initTaskDir(runDir: string, taskId: string): string {
  const taskDir = path.join(runDir, "tasks", taskId);
  fs.mkdirSync(path.join(taskDir, "logs"), { recursive: true });
  return taskDir;
}

/**
 * 生成下一个 run_id: YYYYMMDD-NNN (UTC 当日)。
 *
 * 按当日已有 run 的最大序号 +1。不预留 (调用方拿到 id 后应尽快 initRunDir 占位)。
 * 单源版本, 保持原行为; 多源见 nextRunIdFromRoots。
 */
export function nextRunId(runsRoot: string): string {
  return nextRunIdFromRoots([runsRoot]);
}

/**
 * 生成下一个 run_id: YYYYMMDD-NNN, 序号取"所有给定源目录中当日已有 run 的最大序号 +1"。
 *
 * 为什么要多源: worktree 模式下 run 目录写进 <worktree>/runs, 主仓 ./runs 永远空。若只扫主仓
 * ./runs, 计数器永不前进, 每次都返回 ...-001 → 撞已存在的 worktree/分支 (即便上一个 run 成功也撞,
 * 因为 .worktrees/<run_id> 仍在)。故 worktree 模式应把 worktree 根 (其下每个 created worktree
 * 目录名即 run_id) 一并纳入序号源。none 模式 / 单源调用 (nextRunId) 行为不变, dryrun 测试不受影响。
 */
export function nextRunIdFromRoots(roots: readonly string[]): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const mo = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const prefix = `${y}${mo}${d}-`;
  const seqs: number[] = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
      if (!ent.isDirectory() || !ent.name.startsWith(prefix)) continue;
      const tail = ent.name.slice(prefix.length);
      // 等价 Python `int(tail)` (非纯数字 ValueError → 跳过)。
      if (/^\d+$/.test(tail)) seqs.push(Number.parseInt(tail, 10));
    }
  }
  const n = seqs.length > 0 ? Math.max(...seqs) + 1 : 1;
  return `${prefix}${String(n).padStart(3, "0")}`;
}

/** tmp 临时 run 目录 (测试夹具用; 与 os.tmpdir 配合)。 */
export function makeTmpRunsRoot(prefix = "loop-run-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// dispatch.json / collect-failures.json / actual-writes.json (P5-M7C 新增)
//
// 真实 run (非 dryrun) 下, 主 agent 当 coordinator, 通过 CLI `dispatch` / `collect-outcome`
// 推进 task 状态。这两个命令跨进程, 内存 map (startedAtByTask / beforeSnapshots / 等) 会丢,
// 故把"派发时"的运行时元数据落到 tasks/<tid>/dispatch.json, 收回时读回重建 packet + base_ref
// + before_snapshot。collect-failures.json 记录失败详情供主 agent 派 fix 子 agent 用;
// actual-writes.json 落到 complete task 目录, 供后续 task 的 collect-outcome 跨进程重建
// earlierTaskWrites (越界检测第 2 层)。
//
// 单写者: Coordinator (不经 worker, 不经 hook)。worker 红线: 不能写这三个文件。
// ---------------------------------------------------------------------------

/**
 * 派发元数据。dispatch 命令产出, collect-outcome 命令消费。
 *
 * 必须在 task.status 翻 running 之前落盘 (崩溃恢复: 文件在, 状态机就能重建)。
 */
export interface DispatchMeta {
  /** 当前 task id。 */
  readonly task_id: string;
  /** 派发时刻 ISO 8601 UTC。 */
  readonly dispatched_at: string;
  /** 派发前的 git base ref (capabilities.git_diff=true 时取; 否则 null)。 */
  readonly base_ref: string | null;
  /** 派发前的 fs snapshot (capabilities.fs_snapshot=true 时取; 否则 null)。 */
  readonly before_snapshot: FsSnapshot | null;
  /** 当前 task 重试次数 (与 task-plan.yaml 的 task.attempt 同步)。 */
  readonly attempt: number;
  /** 派发时的 WorkerPacket (collect-outcome 时直接用, 不需重建)。 */
  readonly packet: WorkerPacket;
}

/**
 * collect-outcome 失败时的详情记录, 供主 agent 读后派 fix 子 agent。
 *
 * reason ∈ {task_check_fail, failed, oob}; plan_amendment 走 amend 命令, 不落此文件。
 */
export interface CollectFailures {
  readonly task_id: string;
  /** "task_check_fail" | "failed" | "oob" */
  readonly reason: string;
  /** 自检未通过的项 (passed=false 的 TaskCheckItem)。 */
  readonly failures: TaskCheckItem[];
  /** 越界路径列表 (reason=oob 时非空)。 */
  readonly oob_paths: string[];
  /** 当前重试次数 (不递增; 由下次 dispatch 递增)。 */
  readonly attempt: number;
  /** collect 时刻 ISO 8601 UTC。 */
  readonly collected_at: string;
}

/**
 * 通用 JSON 文件原子写 (复用 atomicReplace 的 Windows 文件锁重试模式)。
 *
 * 同目录 tmp + rename, 防半写状态。Coordinator 单写者路径上调用。
 */
function writeAtomicJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const payload = `${JSON.stringify(data, null, 2)}\n`;
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    fs.writeFileSync(tmpPath, payload, "utf-8");
    atomicReplace(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/** 通用 JSON 文件读 (不存在返回 null; 解析失败返回 null)。 */
function readJsonOrNull<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

/** tasks/<tid>/dispatch.json 路径。 */
export function dispatchMetaPath(runDir: string, taskId: string): string {
  return path.join(runDir, "tasks", taskId, "dispatch.json");
}

/** tasks/<tid>/collect-failures.json 路径。 */
export function collectFailuresPath(runDir: string, taskId: string): string {
  return path.join(runDir, "tasks", taskId, "collect-failures.json");
}

/** tasks/<tid>/actual-writes.json 路径。 */
export function actualWritesPath(runDir: string, taskId: string): string {
  return path.join(runDir, "tasks", taskId, "actual-writes.json");
}

/** 读 dispatch.json (不存在 → null; collect-outcome 据 null 进入 bootstrap 降级)。 */
export function readDispatchMeta(runDir: string, taskId: string): DispatchMeta | null {
  return readJsonOrNull<DispatchMeta>(dispatchMetaPath(runDir, taskId));
}

/** 原子写 dispatch.json。 */
export function writeDispatchMeta(runDir: string, taskId: string, meta: DispatchMeta): void {
  writeAtomicJson(dispatchMetaPath(runDir, taskId), meta);
}

/** 读 collect-failures.json (不存在 → null)。 */
export function readCollectFailures(runDir: string, taskId: string): CollectFailures | null {
  return readJsonOrNull<CollectFailures>(collectFailuresPath(runDir, taskId));
}

/** 原子写 collect-failures.json。 */
export function writeCollectFailures(
  runDir: string,
  taskId: string,
  failures: CollectFailures,
): void {
  writeAtomicJson(collectFailuresPath(runDir, taskId), failures);
}

/** actual-writes.json 文件形状 (collect-outcome 通过时落盘, 后续 task 重建 earlierTaskWrites)。 */
export interface ActualWritesFile {
  readonly source: string;
  readonly is_authoritative: boolean;
  readonly writes: string[];
}

/** 读 actual-writes.json (不存在 → null)。 */
export function readActualWrites(runDir: string, taskId: string): ActualWritesFile | null {
  return readJsonOrNull<ActualWritesFile>(actualWritesPath(runDir, taskId));
}

/** 原子写 actual-writes.json。 */
export function writeActualWrites(
  runDir: string,
  taskId: string,
  data: ActualWritesFile,
): void {
  writeAtomicJson(actualWritesPath(runDir, taskId), data);
}
