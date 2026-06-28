"""Scheduling: ready_frontier, path overlap, watchdog, actual_writes, capabilities.

规范源: design §3.1–§3.4 (调度与写路径隔离, 唯一"硬"机制).
本模块是 review-report AR3 的轻量兑现点: 调度算法的唯一规范源在 design §3.
"""
