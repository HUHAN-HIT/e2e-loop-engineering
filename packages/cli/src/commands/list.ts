/**
 * e2e-loop list 子命令。
 *
 * 用法:
 *   e2e-loop list --project-dir <path>
 *
 * 行为:
 *   扫描 .claude/ 下本工具管理的资产, 输出文件路径 + 大小。adapter 无关 (只看磁盘)。
 *
 *   扫描范围:
 *     - .claude/skills/loop-engineering/        (递归)
 *     - .claude/agents/                          (本工具装的 4 个 *.md)
 *     - .claude/hooks/loop_engineering/          (4 个 .mjs)
 *     - .claude/settings.json
 *
 *   不存在的目录跳过, 不报错。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Args } from "../args.js";
import { resolveProjectDir } from "../util.js";

interface FileItem {
  rel: string;
  size: number;
}

/** 递归收集 dir 下所有文件 (相对 baseDir 的 POSIX 路径)。 */
function walkDir(baseDir: string, sub: string): FileItem[] {
  const abs = path.join(baseDir, sub);
  if (!fs.existsSync(abs)) return [];
  const items: FileItem[] = [];
  const stack: string[] = [sub];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const curAbs = path.join(baseDir, cur);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(curAbs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      let entries: string[] = [];
      try {
        entries = fs.readdirSync(curAbs);
      } catch {
        continue;
      }
      for (const e of entries) {
        // 保持 POSIX 风格输出
        stack.push(`${cur}/${e}`);
      }
    } else if (stat.isFile()) {
      items.push({ rel: cur, size: stat.size });
    }
  }
  items.sort((a, b) => a.rel.localeCompare(b.rel));
  return items;
}

export async function runList(args: Args): Promise<number> {
  const projectDir = resolveProjectDir(args.values["project-dir"]);
  const claudeDir = path.join(projectDir, ".claude");
  if (!fs.existsSync(claudeDir)) {
    process.stdout.write(
      `${projectDir} 下未找到 .claude/ (尚未安装)\n`,
    );
    return 0;
  }

  const sections: Array<{ title: string; items: FileItem[] }> = [
    {
      title: ".claude/skills/loop-engineering/",
      items: walkDir(projectDir, ".claude/skills/loop-engineering"),
    },
    {
      title: ".claude/agents/",
      items: walkDir(projectDir, ".claude/agents").filter((f) =>
        f.rel.endsWith(".md"),
      ),
    },
    {
      title: ".claude/hooks/loop_engineering/",
      items: walkDir(projectDir, ".claude/hooks/loop_engineering"),
    },
  ];

  // settings.json 单独列
  const settingsAbs = path.join(projectDir, ".claude/settings.json");
  if (fs.existsSync(settingsAbs)) {
    const size = fs.statSync(settingsAbs).size;
    sections.push({
      title: ".claude/settings.json",
      items: [{ rel: ".claude/settings.json", size }],
    });
  }

  let total = 0;
  let count = 0;
  for (const s of sections) {
    if (s.items.length === 0) continue;
    process.stdout.write(`\n== ${s.title} (${s.items.length}) ==\n`);
    for (const it of s.items) {
      process.stdout.write(
        `  ${String(it.size).padStart(8)}B  ${it.rel}\n`,
      );
      total += it.size;
      count += 1;
    }
  }

  if (count === 0) {
    process.stdout.write(
      `${projectDir}/.claude/ 存在但本工具管理的资产为空\n`,
    );
  } else {
    process.stdout.write(
      `\n共 ${count} 个文件, 合计 ${total} 字节\n`,
    );
  }
  return 0;
}
