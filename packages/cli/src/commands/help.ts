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
  help          显示本帮助

通用选项:
  --help, -h            显示本帮助

install 选项:
  --host <cc|oc|both>   必需。选择宿主 adapter
                          cc   → Claude Code (.claude/)
                          oc   → OpenCode (P2 实现)
                          both → 同时装两套 (P2 实现)
  --project-dir <path>  目标项目根目录 (缺省: 当前工作目录)
  --force               覆盖已存在的文件 (默认: 跳过冲突文件)
  --dry-run             只预览不写盘

uninstall 选项:
  --host <cc|oc>        必需。要卸载哪个 adapter 的产物
  --project-dir <path>  目标项目根目录 (缺省: 当前工作目录)

list 选项:
  --project-dir <path>  目标项目根目录 (缺省: 当前工作目录)

示例:
  e2e-loop install --host cc --project-dir ./my-project
  e2e-loop install --host cc --project-dir ./my-project --force
  e2e-loop install --host cc --dry-run
  e2e-loop list --project-dir ./my-project
  e2e-loop uninstall --host cc --project-dir ./my-project

退出码:
  0   成功
  1   参数错误 / 未实现的 host / 其它失败
`);
}
