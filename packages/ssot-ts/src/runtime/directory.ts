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

import { parseRunState } from "../schema/run_state.js";
import type { RunState } from "../schema/run_state.js";
import { parseTaskPlan } from "../schema/task_plan.js";
import type { TaskPlan } from "../schema/task_plan.js";
import { dumpTaskPlanYaml, loadTaskPlanYaml } from "./yaml_io.js";

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

/** 从 planning/task-plan.yaml 读 + parse。文件不存在 → throw。 */
export function readTaskPlan(planPath: string): TaskPlan {
  if (!fs.existsSync(planPath)) {
    throw new Error(`task-plan.yaml 不存在: ${planPath}`);
  }
  const data = loadTaskPlanYaml(fs.readFileSync(planPath, "utf-8"));
  return parseTaskPlan(data);
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
 */
export function nextRunId(runsRoot: string): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const mo = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const prefix = `${y}${mo}${d}-`;
  let n = 1;
  if (fs.existsSync(runsRoot)) {
    const seqs: number[] = [];
    for (const ent of fs.readdirSync(runsRoot, { withFileTypes: true })) {
      if (!ent.isDirectory() || !ent.name.startsWith(prefix)) continue;
      const tail = ent.name.slice(prefix.length);
      // 等价 Python `int(tail)` (非纯数字 ValueError → 跳过)。
      if (/^\d+$/.test(tail)) seqs.push(Number.parseInt(tail, 10));
    }
    if (seqs.length > 0) n = Math.max(...seqs) + 1;
  }
  return `${prefix}${String(n).padStart(3, "0")}`;
}

/** tmp 临时 run 目录 (测试夹具用; 与 os.tmpdir 配合)。 */
export function makeTmpRunsRoot(prefix = "loop-run-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
