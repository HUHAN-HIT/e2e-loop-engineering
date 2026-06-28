/**
 * §11.4 service → worktree 映射 (轻量, 无防伪, TS 版, 等价 Python
 * `loop_engineering/multi_service/service_map.py`)。
 *
 * 规范源: design §11.4 —— 多 repo 时 service name 落到物理 worktree 路径。
 * §11.5 明说多 repo 真实实现暂缓, 此处只做路径解析与校验 (不读写真实 git worktree)。
 *
 * 路径表示: Python 端用 `pathlib.Path`; TS 端用字符串表示路径 (跨平台稳定可断言),
 * 拼接统一用 POSIX 风格 ("/"), 对齐 Python `Path.as_posix()` 的行为。
 */
import { existsSync } from "node:fs";
import * as nodePath from "node:path";

import type { ServiceMap } from "../schema/service_contracts.js";
import type { Task } from "../schema/task_plan.js";

/**
 * service → worktree 路径。
 *
 * @param serviceMap planning/service-map.yaml 模型。
 * @param service service name。
 * @returns 路径字符串 (不校验存在性, 存在性由 validateServiceMap 检)。
 * @throws Error service 不在 map (等价 Python KeyError)。
 */
export function resolveWorktree(serviceMap: ServiceMap, service: string): string {
  const entry = serviceMap.services[service];
  if (entry === undefined) {
    throw new Error(`service '${service}' 不在 service-map.yaml`);
  }
  return entry.worktree;
}

/**
 * task.service → worktree。task.service=null → 返回当前目录 "." (单服务场景)。
 */
export function resolveWorktreeForTask(
  serviceMap: ServiceMap,
  task: Task,
): string {
  if (task.service === null || task.service === undefined) {
    return ".";
  }
  return resolveWorktree(serviceMap, task.service);
}

/**
 * 校验每个 worktree 路径存在。返回问题列表 (空列表 = 全部 OK)。不抛错。
 *
 * 相对路径以 baseDir 解析; 绝对路径原样使用。
 */
export function validateServiceMap(
  serviceMap: ServiceMap,
  baseDir: string,
): string[] {
  const problems: string[] = [];
  for (const [name, entry] of Object.entries(serviceMap.services)) {
    let wt = entry.worktree;
    if (!nodePath.isAbsolute(wt)) {
      wt = nodePath.join(baseDir, wt);
    }
    if (!existsSync(wt)) {
      problems.push(
        `service '${name}' 的 worktree '${entry.worktree}' 不存在 (解析为 ${wt})`,
      );
    }
  }
  return problems;
}

/**
 * 多 repo 下收集 actual_writes。
 *
 * 按 task.service 查 worktree, 从 collectionsByService[service] 取该 service 的写入清单,
 * 把每条相对路径前缀化为 "<worktree>/<path>" 以便上层跨 repo 统一比较。
 *
 * task.service=null 时退化为返回 collectionsByService[''] 原样 (单服务兜底,
 * 缺省再退回 collectionsByService[task.id])。
 */
export function collectActualWritesMultiRepo(
  serviceMap: ServiceMap,
  task: Task,
  collectionsByService: Record<string, string[]>,
): string[] {
  if (task.service === null || task.service === undefined) {
    const fallback =
      collectionsByService[""] ?? collectionsByService[task.id] ?? [];
    return [...fallback];
  }

  const worktree = resolveWorktree(serviceMap, task.service);
  const prefix = toPosix(worktree);
  const rawWrites = collectionsByService[task.service] ?? [];
  const out: string[] = [];
  for (const w of rawWrites) {
    if (!w) {
      continue;
    }
    if (prefix === "." || prefix === "") {
      out.push(w);
    } else {
      out.push(`${prefix}/${w}`);
    }
  }
  return out;
}

/** 路径转 POSIX 风格 (统一分隔符为 "/", 对齐 Python Path.as_posix())。 */
function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}
