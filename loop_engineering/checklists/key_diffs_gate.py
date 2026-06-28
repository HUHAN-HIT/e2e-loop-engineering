"""key-diffs.yaml 硬 gate (design §2.3).

§2.3: risk:high 或 exclusive:true 的 task, 收口前 key-diffs.yaml 必须
存在、可解析、且 key_diffs 非空 —— 机制硬 gate. 其它 task 是软约束
(文件可选, 不强制).

调用方 (收口阶段) 用 validate_many + all_hard_gates_pass 检验:
任一硬 gate task FAIL 则整体不能进 COMPLETE.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from loop_engineering.schema.artifacts import KeyDiffsFile
from loop_engineering.schema.task_plan import RiskLevel, Task


class GateStatus(StrEnum):
    """gate 校验结果三态."""

    PASS = "pass"  # 硬 gate 通过 / 普通 task 自愿提交且非空
    FAIL = "fail"  # 硬 gate 失败 (缺文件 / 空 / 解析失败)
    SOFT = "soft"  # 软约束未满足 (普通 task 缺 key-diffs.yaml), 不阻断


@dataclass(frozen=True)
class KeyDiffsGateResult:
    """单个 task 的 key-diffs gate 校验结果."""

    task_id: str
    status: GateStatus
    reason: str


def is_hard_gate_task(task: Task) -> bool:
    """该 task 是否触发 key-diffs 硬 gate.

    design §2.3: risk==high 或 exclusive==True -> 硬 gate.
    """
    return task.risk == RiskLevel.high or bool(task.exclusive)


def validate_key_diffs_submission(
    task: Task,
    key_diffs: KeyDiffsFile | None,
    *,
    raw_yaml_text: str | None = None,
) -> KeyDiffsGateResult:
    """校验单个 task 的 key-diffs 提交.

    Args:
        task: 计划中的 task.
        key_diffs: 已解析的 KeyDiffsFile (若 None 表示文件缺失或解析失败).
        raw_yaml_text: 调用方可传入原始 YAML 文本用于诊断 (例如解析失败时回显).
            本函数本身不重新解析 YAML (调用方负责 try/except); 此参数仅用于
            错误信息富化, 可省略.

    Returns:
        KeyDiffsGateResult: task_id + status + reason.
    """
    hard = is_hard_gate_task(task)

    if hard:
        if key_diffs is None:
            tail = f" (raw_yaml_text 前 80 字符: {raw_yaml_text[:80]!r})" if raw_yaml_text else ""
            return KeyDiffsGateResult(
                task_id=task.id,
                status=GateStatus.FAIL,
                reason=f"硬 gate task 缺 key-diffs.yaml 或解析失败{tail}",
            )
        if not key_diffs.is_meaningful():
            return KeyDiffsGateResult(
                task_id=task.id,
                status=GateStatus.FAIL,
                reason="硬 gate task 的 key_diffs 为空 (must be 非空)",
            )
        return KeyDiffsGateResult(
            task_id=task.id,
            status=GateStatus.PASS,
            reason=f"硬 gate 通过: {len(key_diffs.key_diffs)} 条 key diff",
        )

    # 普通 task —— 软约束
    if key_diffs is None or not key_diffs.is_meaningful():
        return KeyDiffsGateResult(
            task_id=task.id,
            status=GateStatus.SOFT,
            reason="普通 task, key-diffs.yaml 可省 (软约束)",
        )
    return KeyDiffsGateResult(
        task_id=task.id,
        status=GateStatus.PASS,
        reason=f"普通 task 自愿提交: {len(key_diffs.key_diffs)} 条 key diff",
    )


def validate_many(
    tasks: list[Task],
    key_diffs_by_task: dict[str, KeyDiffsFile | None],
) -> list[KeyDiffsGateResult]:
    """批量校验: 每 task 一条结果.

    Args:
        tasks: 计划中的全部 task.
        key_diffs_by_task: task_id -> KeyDiffsFile | None.

    Returns:
        与 tasks 一一对应的 KeyDiffsGateResult 列表.
    """
    results: list[KeyDiffsGateResult] = []
    for t in tasks:
        kd = key_diffs_by_task.get(t.id)
        results.append(validate_key_diffs_submission(t, kd))
    return results


def all_hard_gates_pass(results: list[KeyDiffsGateResult]) -> bool:
    """是否所有硬 gate task 都 PASS.

    用于收口阶段: 任一 FAIL status 的硬 gate task 存在 -> 不能进 COMPLETE.
    SOFT 状态 (普通 task 缺文件) 不阻断.
    """
    return all(r.status != GateStatus.FAIL for r in results)
