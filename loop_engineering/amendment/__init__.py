"""Plan-amendment rollback via AC↔task mapping.

规范源: design §3.6 (plan-amendment 的并发回滚).
worker 报 plan-amendment-needed 必带 touched_acceptance_refs, coordinator 反查
AC↔task 映射, 相交 complete task 降级 pending、running 召回, 不相交不动.
保守扩围到同 task 邻居 AC, 跨 task 间接影响是诚实软约束残留.
"""
