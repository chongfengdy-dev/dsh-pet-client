#!/usr/bin/env bash
# apply-favicon: 把 dsh web 的站点图标(PWA/标签 favicon)替换为 DSH-Pet-Client 黑鲸。
# 用途：PWA「DeepSeek Harness」安装时从服务端 favicon.svg 取图标，
# 官方默认是 dsh logo（黑/白剪影）。2026-09-06 要求换成我们的鲸鱼，
# 2026-09-10 起改为黑色鲸鱼（素材 fish_black 256px，与 fish_blue 同一路子从 ico 提取）。
# 2026-09-28：dsh 0.1.7 起前端同时提供 favicon.svg（浅色）与 favicon-dark.svg（深色），
#             index.html 按 prefers-color-scheme 二选一 → 两个都必须替换，
#             否则深色模式（如本机）看到的仍是官方图标。
#
# 注意：dsh 升级(npm i -g @deepseek-ai/dsh)会覆盖 node_modules → 升级后重跑本脚本。
# 幂等：内容一致则跳过；首次替换前按变体分别备份官方原图到 assets/。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WHALE_SVG="$SCRIPT_DIR/assets/favicon-black.svg"   # 黑鲸 favicon（内嵌 256px PNG）

# 动态定位 dsh-web-frontend dist（npm 全局包结构随版本可能变化，不硬编码全路径）
FAV="$(find "$(npm prefix -g)/lib/node_modules/@deepseek-ai/dsh" \
        -path "*dsh-web-frontend/dist/favicon.svg" 2>/dev/null | head -1)"

if [ -z "$FAV" ] || [ ! -f "$FAV" ] || [ ! -f "$WHALE_SVG" ]; then
  echo "[apply-favicon] 未找到 favicon.svg 或素材缺失，跳过"
  exit 1
fi

DIST_DIR="$(dirname "$FAV")"
changed=0

for name in favicon.svg favicon-dark.svg; do
  T="$DIST_DIR/$name"
  [ -f "$T" ] || continue
  [ -L "$T" ] && continue                      # 符号链接跳过（防误改素材本体）
  if cmp -s "$WHALE_SVG" "$T"; then
    echo "[apply-favicon] $name 已是黑鲸，跳过"
    continue
  fi
  # 首次替换前留官方原件（按变体分别备份）
  if [ "$name" = "favicon-dark.svg" ]; then
    ORIG="$SCRIPT_DIR/assets/favicon-dsh-orig-dark.svg"
  else
    ORIG="$SCRIPT_DIR/assets/favicon-dsh-orig.svg"
  fi
  [ -f "$ORIG" ] || cp "$T" "$ORIG"
  cp "$WHALE_SVG" "$T"
  echo "[apply-favicon] 已替换为黑鲸: $T"
  changed=1
done

if [ "$changed" = "1" ]; then
  echo "PWA 图标更新：浏览器图标缓存顽固，需重装 PWA 或清站点数据后重开"
else
  echo "[apply-favicon] 两个变体均已是黑鲸，无需处理"
fi
