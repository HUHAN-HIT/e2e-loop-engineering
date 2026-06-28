/**
 * e2e-loop 用法说明。
 *
 * 输出到 stdout; 调用方决定 exit code (--help → 0, 无参数/错误 → 1)。
 */

export function printHelp(stream: NodeJS.WriteStream = process.stdout): void {
  stream.write(`e2e-loop — Loop Engineering 跨宿主 CLI

用法:
  e2e-loop <command> [options]

命令:
  install       安装 Claude Code / OpenCode 资产到目标项目 .claude/
  uninstall     卸载已安装的资产 (只删本工具装的)
  list          列出目标项目 .claude/ 下本工具管理的资产
  hook <hook-name>  执行 Claude Code hook stdin/stdout 入口
  help          显示本帮助

算法 dry-run 命令 (本地骨架验证, worker 用 echo 占位):
  init             建 run, 写 input/requirement.md + run-state.json, 打印 run_id
  status           打印当前 phase / human_pending / active_tasks
  plan             进入 PLANNING, 提交 design + task-plan
  run              IMPLEMENTING tick 循环, 跑到等人或终态
  wrap-up          WRAPPING_UP 收口自检
  signoff-plan     人盯点 1: 接受 / 拒绝计划
  signoff-wrap-up  人盯点 2: 接受 / 拒绝收口
  abort            任意 phase → ABORTED (必须给 --reason)
  amend            处理 plan-amendment (回滚触及 AC 的 task, 回 PLANNING)

通用选项:
  --help, -h            显示本帮助
  --runs-root <dir>     dry-run 命令的 runs 根目录 (缺省: ./runs)

install 选项:
  --host <cc|oc|both>   必需。选择宿主 adapter
                          cc   → Claude Code (.claude/)
                          oc   → OpenCode (.claude/skills/ + .opencode/)
                          both → 同时装两套 (共享 .claude/skills/)
  --project-dir <path>  目标项目根目录 (缺省: 当前工作目录)
  --force               覆盖已存在的文件 (默认: 跳过冲突文件)
  --dry-run             只预览不写盘
  --hook-mode <local|cli|auto>
                       hook 安装模式; 默认 local
  --cli-command <cmd>   cli 模式写入 settings 的命令前缀; 默认 e2e-loop

uninstall 选项:
  --host <cc|oc|both>   必需。要卸载哪个 adapter 的产物 (both = 两套都卸)
  --project-dir <path>  目标项目根目录 (缺省: 当前工作目录)

list 选项:
  --project-dir <path>  目标项目根目录 (缺省: 当前工作目录)

dry-run 命令选项:
  init        <requirement.md> [--complexity <auto|simple|medium|complex>]
  status      <run_id>
  plan        <run_id> --design <file> --task-plan <file>
  run         <run_id> [--max-ticks <n>]
  wrap-up     <run_id>
  signoff-plan      <run_id> [--reject] [--feedback <text>]
  signoff-wrap-up   <run_id> [--reject]
  abort       <run_id> --reason <text>
  amend       <run_id> --reason <text> --ac <AC_ID> [--ac <AC_ID> ...]
  (以上命令均接受 --runs-root <dir>)

示例:
  e2e-loop install --host cc --project-dir ./my-project
  e2e-loop install --host cc --project-dir ./my-project --force
  e2e-loop install --host cc --dry-run
  e2e-loop list --project-dir ./my-project
  e2e-loop install --host cc --hook-mode cli --cli-command e2e-loop
  e2e-loop hook guard-paths
  e2e-loop uninstall --host cc --project-dir ./my-project
  e2e-loop init ./req.md --runs-root ./runs
  e2e-loop plan 20260628-001 --design ./design.md --task-plan ./task-plan.yaml
  e2e-loop signoff-plan 20260628-001
  e2e-loop run 20260628-001
  e2e-loop signoff-wrap-up 20260628-001

退出码:
  0   成功
  1   运行期错误 / 参数错误 / 未实现的 host / 其它失败
  2   dry-run 命令的参数缺失或文件不存在
`);
}
