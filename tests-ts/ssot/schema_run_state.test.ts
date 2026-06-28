/**
 * run_state schema 等价测试 (P4-M1 go/no-go)。
 *
 * 行为权威: Python `tests/test_schema_run_state.py` + `loop_engineering/schema/run_state.py`。
 * 被测实现: `packages/ssot-ts/src/schema/run_state.ts` (zod)。
 *
 * 逐条翻译 Python 用例: 枚举值、最小构造默认、ABORTED 一致性校验四态、JSON 往返 (含 exclude_none)。
 */
import { test, expect } from "bun:test";
import {
  Phase,
  PhaseSchema,
  HumanPending,
  TrustMode,
  RunConfigSchema,
  RunStateSchema,
  parseRunState,
} from "@e2e-loop/ssot";

test("[py: test_phase_enum_values] 7 个 phase 值与 design §6 一致", () => {
  expect(Phase.CREATED).toBe("CREATED");
  expect(Phase.CLARIFYING).toBe("CLARIFYING");
  expect(Phase.PLANNING).toBe("PLANNING");
  expect(Phase.IMPLEMENTING).toBe("IMPLEMENTING");
  expect(Phase.WRAPPING_UP).toBe("WRAPPING_UP");
  expect(Phase.COMPLETE).toBe("COMPLETE");
  expect(Phase.ABORTED).toBe("ABORTED");
  expect(PhaseSchema.options.length).toBe(7);
});

test("[py: test_run_state_minimal] 最小 run-state: run_id + complexity 必填, 其他默认", () => {
  const rs = parseRunState({ run_id: "20260627-001", complexity: "complex" });
  expect(rs.run_id).toBe("20260627-001");
  expect(rs.phase).toBe("CREATED");
  expect(rs.complexity).toBe("complex");
  expect(rs.trust_mode).toBe("collaborative");
  expect(rs.human_pending).toBeNull();
  expect(rs.active_tasks).toEqual([]);
  expect(rs.key_artifacts).toEqual([]);
  expect(rs.capabilities).toBeNull();
  // config 默认实例化, 字段齐全
  expect(rs.config.max_retries_per_task).toBe(1);
  expect(rs.config.max_concurrency).toBe(4);
  expect(rs.config.watchdog_timeout_min).toEqual({
    simple: 15,
    medium: 30,
    complex: 60,
  });
  expect(rs.aborted_at).toBeNull();
  expect(rs.aborted_reason).toBeNull();
});

test("[py: test_run_state_aborted_requires_aborted_at] phase=ABORTED 但 aborted_at 缺 → 抛错", () => {
  expect(() =>
    parseRunState({
      run_id: "r1",
      complexity: "simple",
      phase: "ABORTED",
      aborted_at: null,
      aborted_reason: "环境异常",
    }),
  ).toThrow(/aborted_at/);
});

test("[py: test_run_state_aborted_ok_with_aborted_at] phase=ABORTED 且 aborted_at 提供 → 合法", () => {
  const rs = parseRunState({
    run_id: "r1",
    complexity: "simple",
    phase: "ABORTED",
    aborted_at: "2026-06-27T10:00:00Z",
    aborted_reason: "环境异常",
  });
  expect(rs.aborted_at).toBe("2026-06-27T10:00:00Z");
});

test("[py: test_run_state_non_aborted_forbids_aborted_at] 非 ABORTED 设 aborted_at → 抛错", () => {
  expect(() =>
    parseRunState({
      run_id: "r1",
      complexity: "simple",
      phase: "IMPLEMENTING",
      aborted_at: "2026-06-27T10:00:00Z",
      aborted_reason: null,
    }),
  ).toThrow(/aborted_at|ABORTED/);
});

test("[py: test_run_state_non_aborted_forbids_aborted_reason] 非 ABORTED 单设 aborted_reason → 抛错", () => {
  expect(() =>
    parseRunState({
      run_id: "r1",
      complexity: "simple",
      phase: "IMPLEMENTING",
      aborted_at: null,
      aborted_reason: "某种描述",
    }),
  ).toThrow();
});

test("[py: test_run_state_json_roundtrip] 解析 → JSON 序列化 → 再解析 往返一致", () => {
  const rs = parseRunState({
    run_id: "20260627-001",
    complexity: "complex",
    phase: "IMPLEMENTING",
    human_pending: null,
    active_tasks: ["T02", "T03"],
    key_artifacts: ["planning/design.md", "planning/task-plan.yaml"],
    capabilities: { git_diff: true, fs_snapshot: true },
    config: {
      watchdog_timeout_min: {},
      max_retries_per_task: 1,
      max_concurrency: 4,
    },
  });
  const raw = JSON.parse(JSON.stringify(rs));
  const rs2 = parseRunState(raw);
  expect(rs2.run_id).toBe(rs.run_id);
  expect(rs2.phase).toBe(rs.phase);
  expect(rs2.complexity).toBe(rs.complexity);
  expect(rs2.active_tasks).toEqual(rs.active_tasks);
  expect(rs2.key_artifacts).toEqual(rs.key_artifacts);
  expect(rs2.capabilities).toEqual(rs.capabilities);
  expect(rs2.config).toEqual(rs.config);
  expect(rs2.aborted_at).toBeNull();
});

test("[py: test_human_pending_optional] human_pending 默认 null, 也能设非空值", () => {
  const rs = parseRunState({ run_id: "r1", complexity: "medium" });
  expect(rs.human_pending).toBeNull();
  for (const v of [HumanPending.plan_signoff, HumanPending.wrap_up_signoff]) {
    const rs2 = parseRunState({
      run_id: "r1",
      complexity: "medium",
      human_pending: v,
    });
    expect(rs2.human_pending).toBe(v);
  }
});

test("[py: test_run_state_json_excludes_none_when_serialized] 非 ABORTED 时可省略 aborted 字段", () => {
  // Python 用 exclude_none 序列化使 aborted_* 不落盘; zod 侧等价语义是这两个字段
  // 缺省时默认 null, 且省略它们仍能合法解析。
  const rs = parseRunState({ run_id: "r1", complexity: "simple" });
  // 模拟"产物里不含 aborted_* 键"的反序列化
  const raw: Record<string, unknown> = {
    run_id: rs.run_id,
    complexity: rs.complexity,
  };
  expect("aborted_at" in raw).toBe(false);
  expect("aborted_reason" in raw).toBe(false);
  const rs2 = parseRunState(raw);
  expect(rs2.aborted_at).toBeNull();
  expect(rs2.aborted_reason).toBeNull();
});

test("[补充] RunConfig 默认实例化 (对齐 Python RunConfig())", () => {
  const cfg = RunConfigSchema.parse({});
  expect(cfg.max_concurrency).toBe(4);
  expect(cfg.watchdog_timeout_min.complex).toBe(60);
});

test("[补充] 非法 phase / complexity → 抛错", () => {
  expect(() => RunStateSchema.parse({ run_id: "r1", complexity: "bogus" })).toThrow();
  expect(() =>
    RunStateSchema.parse({ run_id: "r1", complexity: "simple", phase: "WAT" }),
  ).toThrow();
});
