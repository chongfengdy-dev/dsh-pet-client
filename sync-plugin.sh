#!/usr/bin/env bash
# dsh 插件同步工具 —— 把仓库里的插件源码同步进 profile 的 node_modules，并重启对应服务。
#
# 背景：profile 内必须是**真实目录副本**，不能用符号链接 —— ESM 会按真实路径解析依赖，
# 链接到仓库目录后找不到宿主 @deepseek-ai 包，插件会 failed to import。
# 因此仓库改完代码不会自动生效，需要在仓库目录跑本脚本同步。
#
# 用法：
#   ./sync-plugin.sh                                  # 默认：dsh-wechat → wechat → dsh-wechat.service
#   ./sync-plugin.sh dsh-term-panels web dsh-web.service
#   ./sync-plugin.sh --check                          # 只检查是否滞后，不做任何改动
#   ./sync-plugin.sh --check dsh-term-panels web
#
# 说明：路径全部动态解析（$DSH_HOME / $HOME / 脚本所在目录），不写死用户名或家目录。
set -euo pipefail

CHECK_ONLY=0
ARGS=()
for a in "$@"; do
	case "$a" in
		-c|--check) CHECK_ONLY=1 ;;
		-h|--help) sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
		*) ARGS+=("$a") ;;
	esac
done

PLUGIN="${ARGS[0]:-dsh-wechat}"
PROFILE="${ARGS[1]:-wechat}"
SERVICE="${ARGS[2]:-dsh-${PROFILE}.service}"

: "${PLUGIN:?插件名不能为空}"
: "${PROFILE:?profile 名不能为空}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SCRIPT_DIR/$PLUGIN"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
DST="$DSH_HOME/profiles/$PROFILE/node_modules/$PLUGIN"

[ -d "$SRC" ] || { echo "✘ 源目录不存在：$SRC" >&2; exit 1; }
[ -d "$DSH_HOME/profiles/$PROFILE" ] || { echo "✘ profile 不存在：$DSH_HOME/profiles/$PROFILE" >&2; exit 1; }
[ -e "$DST" ] || { echo "✘ 目标未安装：$DST" >&2; exit 1; }
[ -L "$DST" ] && { echo "✘ 目标当前是符号链接（会导致 ESM 依赖解析失败），请先改成复制品" >&2; exit 1; }

echo "🔍 源  ：$SRC"
echo "   目标：$DST"
echo

DIFF="$(diff -rq "$SRC" "$DST" 2>/dev/null || true)"
if [ -z "$DIFF" ]; then
	echo "✅ $PLUGIN 已与仓库一致，无需同步"
	exit 0
fi

COUNT="$(printf '%s\n' "$DIFF" | wc -l | tr -d ' ')"
echo "📦 检测到 $COUNT 处差异："
printf '%s\n' "$DIFF" | sed 's/^/   /' | head -20
[ "$COUNT" -gt 20 ] && echo "   …（其余 $((COUNT - 20)) 处略）"
echo

if [ "$CHECK_ONLY" = 1 ]; then
	echo "（--check 模式，未做任何改动）"
	exit 0
fi

# 备份 → 同步
STAMP="$(date +%Y%m%d%H%M%S)"
BAK="$DST.bak-$STAMP"
rm -rf -- "$BAK"
mv -- "$DST" "$BAK"
cp -a -- "$SRC" "$DST"
echo "✅ 已同步 → $DST"
echo "   旧版备份：$BAK"

# 只保留最近 3 个备份
ls -1dt -- "$DST".bak-* 2>/dev/null | tail -n +4 | while IFS= read -r old; do
	rm -rf -- "$old"
done

# 重启服务
if command -v systemctl >/dev/null 2>&1; then
	export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
	if systemctl --user restart "$SERVICE" 2>/dev/null; then
		sleep 3
		echo "🔄 $SERVICE → $(systemctl --user is-active "$SERVICE" 2>/dev/null || echo unknown)（重启次数 $(systemctl --user show "$SERVICE" -p NRestarts --value 2>/dev/null || echo '?')）"
	else
		echo "⚠ 未能重启 $SERVICE，请手动执行：systemctl --user restart $SERVICE"
	fi
fi
