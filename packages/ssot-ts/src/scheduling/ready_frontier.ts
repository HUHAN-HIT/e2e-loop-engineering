/**
 * 调度: ready frontier (design §3.2)。
 *
 * 行为权威: Python `loop_engineering/scheduling/ready_frontier.py`。
 * 唯一规范源: design §3.2 ready_frontier 伪代码 + §11.1 conflicts service-aware 修正。
 *
 * 关键修正 (design §3.2 原文): "候选不仅和 active 比, 还要和本批已选候选两两比"
 * —— 通过 `committed = [...activeTasks, ...本批已选]` 实现。
 *
 * 本函数**只选, 不翻转** status (design §3.2: 调用方拿到 ready 后, 由 coordinator
 * 负责把 status 从 pending 翻 running)。
 */
import type { Task } from "../schema/task_plan.js";
import { TaskStatus } from "../schema/task_plan.js";
import { conflicts } from "./path_overlap.js";

/**
 * 选本 tick 可派发的 pending task (design §3.2)。
 *
 * 过滤规则 (按短路顺序):
 * 1. status 非 pending → 跳过。
 * 2. depends_on 任一未 complete (或悬空 id) → 跳过。
 * 3. 与 active 或本批已选任一冲突 → 跳过。
 * 4. exclusive 且 committed 非空 → 跳过 (独占本服务一批)。
 *
 * 排序: 按 task.id 字典序稳定遍历, 保证多次调用结果一致。
 */
export function readyFrontier(
  tasks: readonly Task[],
  activeTasks: readonly Task[],
): Task[] {
  // 反查 id → Task, 用于 depends_on 求值。
  const byId = new Map<string, Task>();
  for (const t of tasks) byId.set(t.id, t);

  // 按字典序稳定排序 (复制一份, 不改调用方输入)。
  const ordered = [...tasks].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

  const ready: Task[] = [];
  const committed: Task[] = [...activeTasks];

  for (const task of ordered) {
    // 规则 1: 仅 pending 才入选。
    if (task.status !== TaskStatus.pending) continue;

    // 规则 2: depends_on 必须全部 complete。
    let depsOk = true;
    for (const depId of task.depends_on) {
      const dep = byId.get(depId);
      // 依赖不存在 (悬空 id): 保守视为未满足, 跳过。
      if (dep === undefined || dep.status !== TaskStatus.complete) {
        depsOk = false;
        break;
      }
    }
    if (!depsOk) continue;

    // 规则 3: 与 active + 本批已选两两不冲突。
    if (committed.some((other) => conflicts(task, other))) continue;

    // 规则 4: exclusive 独占本服务一批 (committed 非空即让位)。
    if (task.exclusive && committed.length > 0) continue;

    ready.push(task);
    committed.push(task);
  }

  return ready;
}
