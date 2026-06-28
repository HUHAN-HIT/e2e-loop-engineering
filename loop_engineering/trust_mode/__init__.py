"""Trust-mode gating: refuse silent degradation to fake unattended.

规范源: design §5 (trust_mode 档位), §0.3 (独立复跑通道是 §0.3 保留的可选基础设施).
切 unattended 前必须做存在性校验, 未建独立复跑通道则拒绝切换.
"""
