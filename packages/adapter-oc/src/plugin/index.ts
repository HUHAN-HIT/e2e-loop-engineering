/**
 * OpenCode local plugin 入口 —— 把 4 个 hook 在 OC plugin 体系等价实现。
 *
 * 落盘后位于目标项目 `.opencode/plugins/loop-engineering.js`, OpenCode 启动自动加载
 * (local plugin 无需 opencode.json 注册)。本文件只写 **OC binding 层**: 把 OC plugin API 的
 * 事件翻译成 shared 的 HookInput, 调 handle*, 再把 HookOutput 翻译成 OC 动作。算法逻辑全在
 * @e2e-loop/shared, 本层不重写。
 *
 * 4 个 hook 的映射 (OC 事件 → shared handle):
 *
 *   1. tool.execute.before (write/edit) → handleGuardPaths
 *      OC: input.tool ∈ {write, edit}; output.args.filePath / output.args.content。
 *      翻译: {event:"PreToolUse", toolName:"Write", toolInput:{file_path, content}, cwd:directory}。
 *      deny → throw new Error(reason) 拦截工具; allow/defer → 放行。内部错误 → 退化放行 (不锁死)。
 *
 *   2. tool.execute.after (task) → handlePostTaskCollect
 *      OC: input.tool==="task"; output 即 task 工具返回 (子 agent 分发结束)。
 *      翻译: {event:"PostToolUse", toolName:"Task", toolInput:output.args, toolResponse:output, cwd}。
 *      落 sideEffect (actual-writes.json); deny → 劝告式告警 (after 无法真正阻断, 记录即可)。
 *
 *   3. event session.idle → handleGuardAnchors
 *      OC: event.type==="session.idle" (会话空闲/回合完成的等价物)。
 *      翻译: {event:"Stop", cwd:directory}。deny/defer → 劝告式告警 (非阻断, 已知差异 R9)。
 *
 *   4. event session.created + plugin-init → handleProbeAndGate
 *      OC: event.type==="session.created"; 另在 plugin 工厂体顶部跑一次 (plugin-init)。
 *      翻译: {event:"SessionStart", cwd:directory}。记录 capabilities (best-effort, 非阻断)。
 *
 * fail-safe: 所有 hook 包 safeRun, 内部错误退化放行; 唯一例外是 guard_paths 的有意 deny —— 它
 * 在 safeRun 之外单独 throw, 才能真正拦截工具 (safeRun 不会误吞)。
 *
 * @opencode-ai/plugin 仅类型, 本文件不 import 它 (用 runtime.ts 自写的最小类型), bundle 后零运行时依赖。
 */

import {
  handleGuardPaths,
  handlePostTaskCollect,
  handleGuardAnchors,
  handleProbeAndGate,
  type HookInput,
} from "@e2e-loop/shared";
import {
  advise,
  applySideEffect,
  hookOutputToThrow,
  safeRun,
  type OcClient,
  type OcEventArg,
  type OcPluginContext,
  type OcPluginHooks,
  type OcToolAfterOutput,
  type OcToolBeforeOutput,
  type OcToolInputMeta,
} from "./runtime.js";

/** OC 工具名 → 是否触发 guard_paths (写文件类)。 */
function isWriteTool(tool: string | undefined): boolean {
  return tool === "write" || tool === "edit";
}

// ---------------------------------------------------------------------------
// hook 1: tool.execute.before → guard_paths
// ---------------------------------------------------------------------------

/**
 * 处理 write/edit 工具的前置路径白名单。
 *
 * 设计要点 (deny 与内部错误的区分):
 *   - handleGuardPaths 调用包在 safeRun 里: 读 run-state / task-plan 等内部错误 → undefined → 放行。
 *   - 拿到 out 后, 在 safeRun 之外调 hookOutputToThrow(out): deny 时 throw 拦截工具。
 *     这样"内部错误退化放行"与"有意 deny 拦截"严格分离。
 */
async function beforeGuardPaths(
  meta: OcToolInputMeta,
  output: OcToolBeforeOutput,
  directory: string,
): Promise<void> {
  if (!isWriteTool(meta.tool)) return; // 非 write/edit 不受影响

  const args = output.args ?? {};
  // OC write/edit 入参: filePath / content。翻译成 shared 期望的 toolInput.file_path。
  const input: HookInput = {
    event: "PreToolUse",
    toolName: "Write",
    toolInput: {
      file_path: args.filePath,
      content: args.content,
    },
    cwd: directory,
  };

  // 内部错误退化放行: safeRun 失败返回 undefined → 视作 allow, 不 throw。
  const out = await safeRun("guard_paths", () => handleGuardPaths(input));
  if (out === undefined) return; // 内部错误 → 放行

  // 有意 deny → throw 拦截工具 (在 safeRun 之外, 不会被吞)。
  hookOutputToThrow(out);
}

// ---------------------------------------------------------------------------
// hook 2: tool.execute.after → post_task_collect
// ---------------------------------------------------------------------------

/**
 * 处理 task 工具结束 (子 agent 分发结束) 的防糊弄收集。
 *
 * after 阶段 OC 无法真正阻断, 故:
 *   - sideEffect (actual-writes.json) 仍按 handle 给的 file 落盘 (绝对路径)。
 *   - deny → 劝告式告警 (记录 reason, 不阻断)。
 */
async function afterPostTaskCollect(
  meta: OcToolInputMeta,
  output: OcToolAfterOutput,
  directory: string,
  client: OcClient | undefined,
): Promise<void> {
  if (meta.tool !== "task") return; // 仅 task 工具

  // 翻译: toolInput 取 task 工具入参 (含 subagent_type, classifyWorker 据此判定);
  // toolResponse 取整个 output (extractWorkerText 从中抽 worker 文本)。
  const input: HookInput = {
    event: "PostToolUse",
    toolName: "Task",
    toolInput: output.args ?? {},
    toolResponse: output,
    cwd: directory,
  };

  const out = await safeRun("post_task_collect", () =>
    handlePostTaskCollect(input),
  );
  if (out === undefined) return; // 内部错误 → 放行 (after 本就不阻断)

  // sideEffect 落盘: handle 给的 file 是绝对路径 (post_task_collect 用 path.join(runDir,...));
  // baseDir 兜底用 directory (相对路径时才用得到)。
  if (out.sideEffect) {
    applySideEffect(out, directory);
  }

  // deny → 劝告式告警 (after 不能 throw 阻断, 记录即可)。
  if (out.decision === "deny") {
    advise(
      client,
      `post_task_collect 判定不通过 (OC after 无法阻断, 仅告警): ${
        out.reason ?? ""
      }`,
    );
  }
}

// ---------------------------------------------------------------------------
// hook 3: event session.idle → guard_anchors
// ---------------------------------------------------------------------------

/**
 * 处理会话空闲 (回合完成的等价物) 的人锚点 / 完成定义自检。
 *
 * OC 的 event 是非阻断通知 (不能 throw 阻止回合), 这是已知差异 R9:
 *   - deny / defer → 劝告式告警 (劝主 agent 别停, 但 OC 拦不住)。
 *   - allow → 静默。
 */
async function eventGuardAnchors(
  directory: string,
  client: OcClient | undefined,
): Promise<void> {
  const input: HookInput = { event: "Stop", cwd: directory };
  const out = await safeRun("guard_anchors", () => handleGuardAnchors(input));
  if (out === undefined) return;

  if (out.decision === "deny" || out.decision === "defer") {
    advise(
      client,
      `guard_anchors 劝告 (OC session.idle 非阻断, 已知差异 R9): ${
        out.reason ?? ""
      }`,
    );
  }
}

// ---------------------------------------------------------------------------
// hook 4: session.created + plugin-init → probe_and_gate
// ---------------------------------------------------------------------------

/**
 * 处理会话启动的能力探测 + trust_mode 门。
 *
 * SessionStart 在 shared 里就是"退化放行"语义 (异常不锁死), 故这里 best-effort:
 *   - defer (注入 capabilities) → 记录 (OC 无下一轮注入等价物, 劝告式带上 capabilities 摘要)。
 *   - deny (unattended 通道未就绪) → 劝告式告警 (OC 拦不住会话启动, 但记录提醒)。
 */
async function probeAndGate(
  directory: string,
  client: OcClient | undefined,
): Promise<void> {
  const input: HookInput = { event: "SessionStart", cwd: directory };
  const out = await safeRun("probe_and_gate", () => handleProbeAndGate(input));
  if (out === undefined) return;

  if (out.decision === "deny") {
    advise(client, `probe_and_gate 门拒绝 (best-effort 告警): ${out.reason ?? ""}`);
  } else if (out.decision === "defer" && out.context) {
    // 记录 capabilities 摘要 (best-effort)。
    const caps = out.context.capabilities ?? out.context.capabilities_detected;
    advise(
      client,
      `probe_and_gate capabilities: ${JSON.stringify(caps ?? {})}`,
    );
  }
}

// ---------------------------------------------------------------------------
// plugin 工厂
// ---------------------------------------------------------------------------

/**
 * OpenCode local plugin 工厂 (命名导出, OC 自动发现)。
 *
 * @param ctx OC 注入的 { directory, client, ... }
 * @returns hooks 对象 (tool.execute.before / after / event)
 */
export const LoopEngineeringPlugin = async (
  ctx: OcPluginContext,
): Promise<OcPluginHooks> => {
  // directory 缺失时回退 process.cwd() (理论上 OC 总会给, 兜底防 undefined)。
  const directory = ctx.directory ?? process.cwd();
  const client = ctx.client;

  // plugin-init: 启动即跑一次 probe_and_gate (best-effort, 不阻断加载)。
  await safeRun("probe_and_gate(init)", () => probeAndGate(directory, client));

  return {
    "tool.execute.before": async (
      meta: OcToolInputMeta,
      output: OcToolBeforeOutput,
    ): Promise<void> => {
      // 注意: beforeGuardPaths 内部已分离 deny(throw) 与内部错误(safeRun 吞);
      // 这里不再包 safeRun, 否则会吞掉有意的 deny throw。
      await beforeGuardPaths(meta, output, directory);
    },

    "tool.execute.after": async (
      meta: OcToolInputMeta,
      output: OcToolAfterOutput,
    ): Promise<void> => {
      await safeRun("tool.execute.after", () =>
        afterPostTaskCollect(meta, output, directory, client),
      );
    },

    event: async (arg: OcEventArg): Promise<void> => {
      const type = arg.event?.type;
      if (type === "session.idle") {
        await safeRun("event(session.idle)", () =>
          eventGuardAnchors(directory, client),
        );
      } else if (type === "session.created") {
        await safeRun("event(session.created)", () =>
          probeAndGate(directory, client),
        );
      }
      // 其它事件忽略。
    },
  };
};

export default LoopEngineeringPlugin;
