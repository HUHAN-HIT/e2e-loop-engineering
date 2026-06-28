"""D. SessionStart —— capabilities 探测 + trust_mode 切换门 (design §3.4 / §5 / §0.3).

会话启动时:
1. 调 SSOT probe_capabilities 探测 git/fs 能力.
2. 若有活跃 run (用户接着上次的工作):
   - 读 run-state 的 trust_mode 与 capabilities.
   - 若 trust_mode=unattended, 验证独立复跑通道 (§0.3) 就绪; 不就绪 → block (拒绝静默降级).
   - 把 capabilities 探测结果作为 additionalContext 注入, 让主 agent 知道能否用 git_diff
     采集 actual_writes.
3. 无活跃 run → 仅注入 capabilities 提示, 不阻止.

SessionStart 异常时退化放行 (不锁死会话), 与其它 hook 的 fail-safe=block 不同.
"""
from __future__ import annotations

import json
import sys
import traceback

import common
from common import (
    additional_context,
    emit,
    emit_pass_silent,
    safe_read_run_state,
)


def _phase_value(state) -> str:
    if state is None:
        return ""
    ph = getattr(state, "phase", "")
    return getattr(ph, "value", str(ph))


def _trust_mode_value(state) -> str:
    tm = getattr(state, "trust_mode", None)
    if tm is None:
        return ""
    return getattr(tm, "value", str(tm))


def main() -> int:
    try:
        # 探测宿主能力 (用 REPO_ROOT 作为 workdir)
        try:
            from loop_engineering.scheduling.capabilities import probe_capabilities
            caps = probe_capabilities(common.REPO_ROOT)
            caps_payload = {"git_diff": caps.git_diff, "fs_snapshot": caps.fs_snapshot}
        except Exception as e:  # noqa: BLE001
            # 探测失败不阻塞会话, 退化为"无能力"提示
            caps_payload = {"git_diff": False, "fs_snapshot": False, "probe_error": str(e)}

        run_dir = common.active_run_dir()
        if run_dir is None:
            # 无活跃 run: 仅注入 capabilities 提示, 不阻止
            emit(additional_context({
                "loop_engineering_session_start": True,
                "active_run": None,
                "capabilities": caps_payload,
                "note": "无活跃 run; loop-engineering hooks 已就位",
            }))
            return 0

        state = safe_read_run_state(run_dir)
        if state is None:
            # run 目录在但 run-state.json 缺失, 仅提示
            emit(additional_context({
                "loop_engineering_session_start": True,
                "active_run": str(run_dir),
                "capabilities": caps_payload,
                "warning": "run 目录存在但 run-state.json 缺失或不可解析",
            }))
            return 0

        tm = _trust_mode_value(state)
        phase = _phase_value(state)

        # trust_mode=unattended 必须 §0.3 独立复跑通道就绪 (拒绝静默降级, design §5)
        block_reason = None
        if tm == "unattended":
            try:
                from loop_engineering.trust_mode.gate import (
                    probe_unattended_readiness,
                    can_switch_to_unattended,
                )
                readiness = probe_unattended_readiness()
                if not can_switch_to_unattended(readiness):
                    block_reason = (
                        f"trust_mode=unattended 但独立复跑通道未就绪 (§0.3): "
                        f"{readiness.reasons}; 拒绝静默降级 (§5)"
                    )
            except Exception as e:  # noqa: BLE001
                block_reason = (
                    f"trust_mode=unattended 探测失败: {e}; "
                    "拒绝静默降级 (§5)"
                )

        if block_reason:
            # SessionStart 块仅作提示 (additionalContext + decision=block 不一定被宿主尊重,
            # 但按设计要求明确表达拒绝)
            from common import emit_block
            return emit_block(block_reason)

        # 注入 capabilities 让主 agent 决策采集路径
        emit(additional_context({
            "loop_engineering_session_start": True,
            "active_run": str(run_dir),
            "phase": phase,
            "trust_mode": tm,
            "human_pending": _human_pending(state),
            "capabilities_detected": caps_payload,
            "capabilities_recorded": _caps_recorded(state),
            "note": (
                "actual_writes 采集优先级: git_diff > fs_snapshot > worker_self_report "
                "(§3.4); 若 detected 与 recorded 不一致, 主 agent 应协调者写新 capabilities"
            ),
        }))
        return 0
    except Exception as e:  # noqa: BLE001
        # SessionStart 异常 fail-safe: 退化放行, 不锁死会话
        tb = traceback.format_exc()
        sys.stderr.write(f"[probe_and_gate] 内部错误, 退化放行: {e}\n{tb}\n")
        emit_pass_silent()
        return 0


def _human_pending(state) -> str:
    hp = getattr(state, "human_pending", None)
    if hp is None:
        return ""
    return getattr(hp, "value", str(hp))


def _caps_recorded(state):
    caps = getattr(state, "capabilities", None)
    if caps is None:
        return None
    return {"git_diff": caps.git_diff, "fs_snapshot": caps.fs_snapshot}


if __name__ == "__main__":
    sys.exit(main() or 0)
