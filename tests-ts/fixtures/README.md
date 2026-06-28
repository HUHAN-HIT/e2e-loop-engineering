# tests-ts/fixtures/ — 共享 run 目录夹具

环境变量 `LOOP_RUNS_ROOT` 指向本目录 (`tests-ts/fixtures`) 时, 4 个 hook 测试可共享
单一活跃 run。

## 布局

```
fixtures/runs/20260101-001/
  run-state.json     phase=IMPLEMENTING, active_tasks=["t1"], trust_mode=collaborative
  planning/
    task-plan.yaml   单 task, allowed_write_paths=["src/**"], status=running
  tasks/
  clarification/
```

## 用法

部分独立用例 (见各 *.test.ts) 自建独立 tmpdir 夹具, 不依赖本目录;
本目录主要作为:

1. 跨用例共享的"已知"run, 便于调试时手工指向;
2. CI 文档样例与教程引用。

```bash
LOOP_RUNS_ROOT=$PWD/tests-ts/fixtures bun test tests-ts/
```
