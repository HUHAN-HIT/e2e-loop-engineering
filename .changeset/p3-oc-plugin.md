---
"@e2e-loop/adapter-opencode": minor
---

P3: OpenCode plugin —— 4 个 hook 在 OC plugin 体系等价实现 (复用 @e2e-loop/shared 的宿主无关 logic), 自包含 bundle 落 .opencode/plugins/loop-engineering.js (OC 启动自动加载)。guard_paths/post_task_collect 完全等价, probe_and_gate 功能等价, guard_anchors 劝告式 (OC 无硬阻断 stop hook, R9)。OpenCode 全功能 (0.5.0-alpha)。
