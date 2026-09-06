#!/usr/bin/env bash
# apply-favicon: 把 dsh web 的站点图标(PWA/标签 favicon)替换为 DSH-Pet-Client 蓝鲸。
# 用途：PWA「DeepSeek Harness」安装时从服务端 manifest(/favicon.svg) 取图标，
# 官方默认是 dsh logo（黑/白剪影）。主 2026-09-06 要求换成我们的蓝色鲸鱼。
#
# 注意：dsh 升级(npm i -g @deepseek-ai/dsh)会覆盖 node_modules → 升级后重跑本脚本。
# 幂等：先备份官方原图(favicon-dsh-orig.svg 已入库 assets/)，重复执行安全。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BLUE_SVG="$SCRIPT_DIR/assets/favicon-blue.svg"        # 蓝鲸 favicon（内嵌 256px PNG）

# 动态定位 dsh-web-frontend dist（npm 全局包结构随版本可能变化，不硬编码全路径）
FAV="$(find "$(npm prefix -g)/lib/node_modules/@deepseek-ai/dsh" \
        -path "*dsh-web-frontend/dist/favicon.svg" 2>/dev/null | head -1)"

if [ -z "$FAV" ] || [ ! -f "$BLUE_SVG" ]; then
  echo "[apply-favicon] 未找到 favicon.svg 或素材缺失，跳过"
  exit 1
fi

# 已是我们蓝鲸内容（base64 图片行）→ 跳过；否则替换
if grep -q "data:image/png;base64" "$FAV"; then
  echo "[apply-favicon] 已是蓝鲸图标，无需替换: $FAV"
  exit 0
fi

if [ ! -f "$SCRIPT_DIR/assets/favicon-dsh-orig.svg" ]; then
  cp "$FAV" "$SCRIPT_DIR/assets/favicon-dsh-orig.svg"   # 首次替换前留官方原件
fi
cp "$BLUE_SVG" "$FAV"
echo "[apply-favicon] 已替换为蓝鲸: $FAV"
echo "PWA 图标更新：重装一次 PWA（或等浏览器图标缓存刷新）"
