#!/usr/bin/env bash
# dsh-web launch wrapper：根据标记文件决定是否以"纯净模式"(剥离第三方插件)启动。
# systemd ExecStart 指向本脚本；用户用 dsh-mode clean/full 切换。
#
# 纯净模式: --patch $HOME/.dsh/profiles/web/clean.patch.yml (disable 掉 term-panels/dshmarket/mnemon/dsh-web-token-sync 等第三方)
# 完整模式: 不加 --patch (默认)
#
# 标记文件存在 = 纯净模式；不存在 = 完整模式。
# 路径/可执行文件全部动态获取（不硬编码用户名、家目录、安装位置），
# 便于部署到任何用户与机器。
set -euo pipefail

# PATH 自愈：确保 dsh 全局 bin 目录可见。
# 注意 systemd 单元的 Environment= 值不会展开 $HOME，因此不能把带家目录的
# PATH 写在单元里，统一在这里兜底。
export PATH="$HOME/.npm-global/bin:$PATH"

# node 动态定位（避免写死 /usr/bin/node 这类绝对安装路径）
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "web-launch: 未找到 node，请确认已安装且位于 PATH 中" >&2
  exit 127
fi

# dsh 可执行文件：优先 PATH，其次 npm 全局前缀
DSH_BIN="$(command -v dsh || echo "$(npm prefix -g)/bin/dsh")"
CLEAN_PATCH="$HOME/.dsh/profiles/web/clean.patch.yml"
MARK="$HOME/.dsh/.dsh-web-mode"

ARGS=("--profile" "web")

if [ -f "$MARK" ]; then
  ARGS+=("--patch" "$CLEAN_PATCH")
fi

ARGS+=("--" "--port" "3080" "--no-open")

exec "$NODE_BIN" "$DSH_BIN" "${ARGS[@]}"
