/**
 * 跨宿主核心抽象 (规范源: docs/loop-engineering-cross-host-design.md §5.1 + §5.2).
 *
 * 设计要点:
 * - HostAdapter 描述 adapter 必须实现的能力 (install/dryRun/uninstall)。
 * - HostHook 描述 4 个 hook 的统一形态 (CC stdin/stdout 命令 / OC plugin module 共享)。
 * - HookOutput.sideEffect 用于显式落盘副作用 (actual_writes 等), 保持 handle 是"纯函数 + 显式副作用"。
 */

// ---------------- §5.1 Host Adapter ----------------

/** 宿主标识, 用于 CLI 选择与日志 */
export type HostId = "claude-code" | "opencode";

/**
 * 该 adapter 落盘后的目标根目录名 (相对 projectDir)。
 * Claude Code 用 ".claude"; OpenCode 也兼容 ".claude/skills/", 但根目录习惯用 ".opencode"。
 */
export type TargetDir = ".claude" | ".opencode";

/** 用户级 / run 级偏好, 例如 hook 启用清单 */
export interface HookFeatures {
  /** 是否启用 git diff 通道 (actual_writes 第一层) */
  gitDiff?: boolean;
  /** 是否启用 fs snapshot 通道 (actual_writes 第二层) */
  fsSnapshot?: boolean;
  /** 是否启用 unattended 信任档 (决定 probe_and_gate 校验路径) */
  unattended?: boolean;
  /** 显式启用的 hook 子集; 缺省表示 4 个全部启用 */
  enabledHooks?: HookName[];
}

/** install 调用的入参 */
export interface InstallContext {
  /** 目标项目根目录 (绝对路径) */
  projectDir: string;
  /** 是否覆盖已存在文件 */
  force: boolean;
  /** hook 安装模式: local=复制入口, cli=写入 e2e-loop hook 命令, auto=installer 自行选择 */
  hookMode?: "local" | "cli" | "auto";
  /** CLI hook 模式使用的命令前缀, 例如 e2e-loop 或 node path/to/index.js */
  cliCommand?: string;
  /** 用户级偏好 */
  features?: HookFeatures;
}

/** install 前的 dry-run 预览结果 */
export interface AssetManifest {
  files: Array<{
    /** 落盘相对路径 (相对 projectDir) */
    path: string;
    /** 资产来源: core 公共目录或 adapter 私有目录 */
    source: "core" | "adapter";
    /** 文件字节数 */
    size: number;
  }>;
  /** 已存在且 force=false 时会冲突的文件相对路径列表 */
  conflictFiles: string[];
}

/** install 调用的结果 */
export interface InstallResult {
  /** 成功落盘的文件相对路径列表 */
  writtenFiles: string[];
  /** 跳过的文件 (冲突且 force=false) */
  skippedFiles: string[];
  /** 资产清单 (与 dryRun 返回结构一致) */
  manifest: AssetManifest;
}

/** uninstall 调用的结果 */
export interface UninstallResult {
  /** 成功删除的文件相对路径列表 */
  removedFiles: string[];
  /** 不存在的文件相对路径列表 (幂等友好) */
  notFoundFiles: string[];
}

/** 宿主 adapter 必须实现的接口 (§5.1) */
export interface HostAdapter {
  readonly host: HostId;
  readonly targetDir: TargetDir;
  install(ctx: InstallContext): Promise<InstallResult>;
  dryRun(ctx: InstallContext): Promise<AssetManifest>;
  uninstall?(projectDir: string): Promise<UninstallResult>;
}

// ---------------- §5.2 Hook 跨宿主抽象 ----------------

/** 4 个 hook 的名字 */
export type HookName =
  | "probe_and_gate"
  | "guard_paths"
  | "post_task_collect"
  | "guard_anchors";

/** hook 事件类型 (CC 用 hook_event_name; OC 用 plugin event 等价物) */
export type HookEvent =
  | "SessionStart"
  | "PreToolUse"
  | "PostToolUse"
  | "Stop"
  | "UserPromptSubmit";

/** 显式副作用, HookOutput.sideEffect 用 */
export interface SideEffect {
  /** 落盘文件相对路径 (通常相对 runDir) */
  file: string;
  /** 写入内容 (会被宿主/CLI 用 JSON.stringify 或纯文本写入) */
  content: unknown;
}

/** 统一 hook 入参 (宿主无关) */
export interface HookInput {
  event: HookEvent;
  /** 工具名, 如 Write/Edit/Task; PreToolUse/PostToolUse 必填, 其它事件可空 */
  toolName?: string;
  /** 工具入参对象 (路径、文件内容、Task 描述等), 由 binding 翻译 */
  toolInput?: unknown;
  /**
   * 工具返回结果 (PostToolUse 才有, 比如 Task 工具交回的 worker 输出)。
   * 由 adapter 从原生 payload 的 tool_response / tool_result 翻译而来。
   */
  toolResponse?: unknown;
  /** 仓库根 (绝对路径) */
  cwd: string;
  /** 当前 run 目录 (绝对路径), 从 cwd/runs/<id> 解析 */
  runDir?: string;
  /** 当前 run-state.phase */
  phase?: string;
  /** active task id 列表 */
  activeTasks?: string[];
  /**
   * 写者身份 (B 案新增, guard_paths 用). 来自 CC payload 的 agent_id/agent_type 字段.
   *
   * - "main": 主 agent 触发 (CC payload 无 agent_id 字段)
   * - { agent_id, agent_type }: 子 agent 触发 (CC payload 在子 agent 内运行时下发)
   * - undefined: 宿主未提供写者身份 (OC plugin runtime 无对应字段), guard_paths 退化到
   *   只看 phase+task, 不做身份治理 (避免误锁 OC 主流程).
   *
   * 字段存在性判别权威: CC 官方文档
   * https://code.claude.com/docs/en/hooks — agent_id 字段 "Present only when the hook
   * fires inside a subagent call".
   */
  caller?: "main" | { agent_id: string; agent_type: string };
}

/** 统一 hook 出参 (宿主无关) */
export interface HookOutput {
  /**
   * allow=放行; deny=拒绝并把 reason 注入工具调用结果; defer=放行但请求下一轮提示词注入。
   *
   * 与 Python 端的对应:
   * - allow   ↔ emit {} (静默放行) 或 emit {decision: "allow"}
   * - deny    ↔ emit {decision: "block", reason}
   * - defer   ↔ emit {decision: "block", reason} (但语义是"请求注入 additionalContext 后继续")
   *            probe_and_gate / post_task_collect 用 defer 表达"放行 + 注入 context"。
   *            adapter binding 时把 defer 翻译成 CC 的 additionalContext 注入或 OC 的 plugin notice。
   */
  decision: "allow" | "deny" | "defer";
  /** deny/defer 时给宿主/用户的解释 */
  reason?: string;
  /**
   * 注入主 agent 下一轮的上下文 (probe_and_gate 的 capabilities / post_task_collect 的 verified+actual_writes 等)。
   * adapter binding 时翻译成 CC 的 hookSpecificOutput.additionalContext (JSON 字符串) 或 OC 的 plugin notice。
   * 仅在 decision=defer 时有意义。
   */
  context?: Record<string, unknown>;
  /** 显式副作用 (actual_writes 落盘等); handle 主体仍是纯函数 */
  sideEffect?: SideEffect;
}

/** 4 个 hook 共同实现的接口 (§5.2) */
export interface HostHook {
  readonly name: HookName;
  readonly event: HookEvent;
  handle(input: HookInput): Promise<HookOutput>;
}
