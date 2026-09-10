#!/usr/bin/env bash
# apply-favicon: 把 dsh web 的站点图标(PWA/标签 favicon)替换为 DSH-Pet-Client 黑鲸。
# 用途：PWA「DeepSeek Harness」安装时从服务端 favicon.svg 取图标，
# 官方默认是 dsh logo（黑/白剪影）。2026-09-06 要求换成我们的鲸鱼，
# 2026-09-10 起改为黑色鲸鱼（素材 fish_black 256px，与 fish_blue 同一路子从 ico 提取）。
#
# 注意：dsh 升级(npm i -g @deepseek-ai/dsh)会覆盖 node_modules → 升级后重跑本脚本。
# 幂等：内容一致则跳过；首次替换前备份官方原图(favicon-dsh-orig.svg 已入库 assets/)。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WHALE_SVG="$SCRIPT_DIR/assets/favicon-black.svg"   # 黑鲸 favicon（内嵌 256px PNG）

# 动态定位 dsh-web-frontend dist（npm 全局包结构随版本可能变化，不硬编码全路径）
FAV="$(find "$(npm prefix -g)/lib/node_modules/@deepseek-ai/dsh" \
        -path "*dsh-web-frontend/dist/favicon.svg" 2>/dev/null | head -1)"

if [ -z "$FAV" ] || [ ! -f "$WHALE_SVG" ]; then
  echo "[apply-favicon] 未找到 favicon.svg 或素材缺失，跳过"
  exit 1
fi

# 已是黑鲸内容 → 跳过（用 cmp 而非 grep：这样从蓝鲸换黑鲸时能被识别为需要替换）
if cmp -s "$WHALE_SVG" "$FAV"; then
  echo "[apply-favicon] 已是黑鲸图标，无需替换: $FAV"
  exit 0
fi

if [ ! -f "$SCRIPT_DIR/assets/favicon-dsh-orig.svg" ]; then
  cp "$FAV" "$SCRIPT_DIR/assets/favicon-dsh-orig.svg"   # 首次替换前留官方原件
fi
cp "$WHALE_SVG" "$FAV"
echo "[apply-favicon] 已替换为黑鲸: $FAV"
echo "PWA 图标更新：浏览器图标缓存顽固，需重装 PWA 或清站点数据后重开"
