"""Phase 级状态转换规则 (design §1, §8.1).

只管 run 级 phase 之间的合法迁移; 不跑调度、不解析 checks、不做 watchdog.
task 级状态 (pending/running/blocked/complete) 由 scheduling 模块维护, 不在此处.
"""
from __future__ import annotations

from datetime import datetime, timezone

from ..schema.run_state import Phase, RunState


class IllegalTransitionError(ValueError):
    """非法 phase 迁移 (design §1).

    含 current / target / legal_targets 三字段, 便于上层诊断与 UI 提示.
    """

    def __init__(
        self,
        current: Phase,
        target: Phase,
        legal_targets: frozenset[Phase],
    ) -> None:
        self.current = current
        self.target = target
        self.legal_targets = legal_targets
        super().__init__(
            f"非法 phase 迁移: {current} → {target}; "
            f"合法目标仅 {sorted(p.value for p in legal_targets) or '<终态, 无后继>'}"
        )


# design §1 主流程 + §8.1 (任意 phase 可放弃)
# CREATED 可跳过 CLARIFYING 直接进 PLANNING (§1: CLARIFYING 可选)
LEGAL_TRANSITIONS: dict[Phase, frozenset[Phase]] = {
    Phase.CREATED: frozenset({Phase.CLARIFYING, Phase.PLANNING, Phase.ABORTED}),
    Phase.CLARIFYING: frozenset({Phase.PLANNING, Phase.ABORTED}),
    # PLANNING 自环: plan-amendment 回到 PLANNING 重审 (§1)
    Phase.PLANNING: frozenset({Phase.IMPLEMENTING, Phase.PLANNING, Phase.ABORTED}),
    # 回 PLANNING: plan-amendment 改验收语义 (§1)
    Phase.IMPLEMENTING: frozenset({Phase.WRAPPING_UP, Phase.PLANNING, Phase.ABORTED}),
    # 集成测试红 → PLANNING; 就近返工 → IMPLEMENTING (§1)
    Phase.WRAPPING_UP: frozenset(
        {Phase.COMPLETE, Phase.PLANNING, Phase.IMPLEMENTING, Phase.ABORTED}
    ),
    # 终态, 不再推进 (§8 / §8.1)
    Phase.COMPLETE: frozenset(),
    Phase.ABORTED: frozenset(),
}


def can_transition(current: Phase, target: Phase) -> bool:
    """查询 current → target 是否合法."""
    return target in LEGAL_TRANSITIONS.get(current, frozenset())


def validate_transition(current: Phase, target: Phase) -> None:
    """校验迁移, 不合法 raise IllegalTransitionError."""
    legal = LEGAL_TRANSITIONS.get(current, frozenset())
    if target not in legal:
        raise IllegalTransitionError(current, target, legal)


def is_terminal(phase: Phase) -> bool:
    """是否终态 (§8 / §8.1): COMPLETE 或 ABORTED, 进入后 run 不再推进."""
    return phase in (Phase.COMPLETE, Phase.ABORTED)


def advance_phase(
    state: RunState,
    target: Phase,
    *,
    aborted_reason: str | None = None,
) -> RunState:
    """推进 phase, 返回新 RunState 实例 (不可变风格).

    - 校验 can_transition; 不通过 raise IllegalTransitionError.
    - target == ABORTED: aborted_reason 必填 (否则 ValueError); 写 aborted_at (UTC ISO 8601).
      run-state 的 model_validator 会保证其它字段一致.
    - target != ABORTED: 防御性清空 aborted_at / aborted_reason (应为 None).
    """
    validate_transition(state.phase, target)

    updates: dict[str, object] = {"phase": target}

    if target == Phase.ABORTED:
        if not aborted_reason:
            raise ValueError("进入 ABORTED 必须给出 aborted_reason (design §8.1)")
        updates["aborted_at"] = datetime.now(timezone.utc).isoformat()
        updates["aborted_reason"] = aborted_reason
    else:
        # 防御性: 非 ABORTED 时这两个字段必须为 None (model_validator 也会兜底)
        updates["aborted_at"] = None
        updates["aborted_reason"] = None

    return state.model_copy(update=updates)
