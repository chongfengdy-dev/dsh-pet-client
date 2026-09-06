#!/usr/bin/env bash
# dsh-web launch wrapper：根据标记文件决定是否以"纯净模式"(剥离第三方插件)启动。
# systemd ExecStart 指向本脚本；主用 dsh-mode clean/full 切换。
#
# 纯净模式: --patch ~/.dsh/profiles/web/clean.patch.yml (disable 掉 term-panels/dshmarket/mnemon/dsh-web-token-sync 等第三方)
# 完整模式: 不加 --patch (默认)
#
# 标记文件存在 = 纯净模式；不存在 = 完整模式。
set -euo pipefail

DSH_BIN="/home/dream/.npm-global/bin/dsh"
CLEAN_PATCH="/home/dream/.dsh/profiles/web/clean.patch.yml"
MARK="/home/dream/.dsh/.dsh-web-mode"

ARGS=("--profile" "web")

if [ -f "$MARK" ]; then
  ARGS+=("--patch" "$CLEAN_PATCH")
fi

ARGS+=("--" "--port" "3080" "--no-open")

exec /usr/bin/node "$DSH_BIN" "${ARGS[@]}"
