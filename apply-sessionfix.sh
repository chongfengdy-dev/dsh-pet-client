#!/usr/bin/env bash
# apply-sessionfix: 放宽 dsh v0→v1 迁移器对 plugin source `summary` 的校验。
#
# 背景（2026-09-10 定）：
#   v0 时代插件（如 dsh-mnemon）在 user/message 的 plugin source 里用
#   form=instructions / form=recall 同时带 summary；dsh 0.1.5-rc.1 的迁移器
#   规定 summary 只能配 form=notice，否则整会话被拒绝观察
#   （failed to observe session ... "summary requires notice form"）。
#   本机 273 个会话全为 v0，其中 231 个中招（点不开），归档恢复亦然。
#
# 补丁：任何 form 下都接受字符串 summary（只放宽“读校验”，不改动任何日志数据）。
# 注意：dsh 升级（npm i -g @deepseek-ai/dsh）会覆盖 node_modules → 升级后重跑本脚本
#       （与 apply-favicon.sh 同批）。幂等：已打则跳过。
#
# 生效：改完需重启 dsh-web（sudo systemctl restart dsh-web）。
set -euo pipefail

TARGET="$(find "$(npm prefix -g)/lib/node_modules/@deepseek-ai/dsh" \
            -path "*dsh-session-format-v0-to-v1/lib/index.js" 2>/dev/null | head -1)"
if [ -z "$TARGET" ] || [ ! -f "$TARGET" ]; then
  echo "[apply-sessionfix] 未找到 v0→v1 迁移器，跳过"
  exit 1
fi

if grep -q "2026-09-10 补丁" "$TARGET"; then
  echo "[apply-sessionfix] 已打过补丁，无需处理: $TARGET"
  exit 0
fi

BAK_DIR="$HOME/.dsh/backup"
mkdir -p "$BAK_DIR"
BAK="$BAK_DIR/session-format-v0-to-v1.index.js.orig-$(date +%Y%m%d-%H%M%S)"
cp "$TARGET" "$BAK"
echo "[apply-sessionfix] 原文件已备份: $BAK"

python3 - "$TARGET" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
old = ('\tif (form === "notice") stringValue(source["summary"], `${label} summary`);\n'
       '\telse if (source["summary"] !== void 0) throw new SessionFormatError(`${label} summary requires notice form`);')
assert old in s, '未找到目标代码（dsh 版本可能已变，请人工检查迁移器实现）'
new = ('\t// 2026-09-10 补丁（定）：v0 时代插件（如 dsh-mnemon）在 form=instructions/recall 上带\n'
       '\t// summary，旧迁移器一律拒绝导致整个会话打不开（本机 231 个旧会话 + 归档会话）。\n'
       '\t// 放宽为：summary 只校验必须是字符串（v1 及后续格式不再校验这两者关系）。\n'
       '\tif (source["summary"] !== void 0) stringValue(source["summary"], `${label} summary`);')
open(p, 'w', encoding='utf-8').write(s.replace(old, new, 1))
print('[apply-sessionfix] 补丁已应用')
PY

node --check "$TARGET"
echo "[apply-sessionfix] 语法检查通过"
echo "[apply-sessionfix] 请重启 dsh-web 生效：sudo systemctl restart dsh-web"
