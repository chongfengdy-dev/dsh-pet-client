#!/usr/bin/env bash
# post-dsh-upgrade.sh — dsh 升级（npm i -g @deepseek-ai/dsh）之后必做的收尾。
#
# 为什么需要：dsh 升级会覆盖 node_modules，我们在里面打的补丁全部失效；
# 同时少数内部 API 可能改名，配套插件需要复核。2026-09-10 主定。
#
# 用法（升级完 dsh 后跑一次即可，幂等、可重复执行）：
#     bash ~/deepseek-harness/nim-client/post-dsh-upgrade.sh          # 只检查 + 重打两处补丁
#     bash ~/deepseek-harness/nim-client/post-dsh-upgrade.sh --fix       # 对齐 wechat profile 依赖（危险，见下）
#     bash ~/deepseek-harness/nim-client/post-dsh-upgrade.sh --rollback  # 出事时从最近备份还原 wechat 依赖
#
# ⚠️ --fix 已知坑（2026-09-10 实测）：只升依赖、不升 dsh-wechat 插件 → 服务启动失败
#     （ERR_PACKAGE_PATH_NOT_EXPORTED）。修法：mnemon 全家一起升（脚本已内置）。
#
# 需要提权的地方（写全局包）脚本会明确提示，其余都是只读检查。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"

# --fix：检测到 wechat profile 依赖滞后时自动对齐（默认只提示、不动文件）
FIX=0
[ "${1:-}" = "--fix" ] && FIX=1

# --rollback：从最近一次备份还原 wechat profile 依赖（--fix 出事时用）
if [ "${1:-}" = "--rollback" ]; then
  WP="$HOME/.dsh/profiles/wechat"
  BK="$HOME/.dsh/backup"
  A=$(ls -t "$BK"/wechat-deepseek-ai-*.tar.gz 2>/dev/null | head -1)
  M=$(ls -t "$BK"/wechat-mnemon-*.tar.gz 2>/dev/null | head -1)
  if [ -z "$A" ] || [ -z "$M" ]; then
    echo "❌ 没找到备份（$BK/wechat-*.tar.gz）"; exit 1
  fi
  echo "从备份还原 wechat 依赖："
  echo "  $A"
  echo "  $M"
  rm -rf "$WP/node_modules/@deepseek-ai"
  tar xzf "$A" -C "$WP/node_modules"
  rm -rf "$WP/node_modules/dsh-mnemon"
  tar xzf "$M" -C "$WP/node_modules"
  echo "  ✅ 还原完成（@deepseek-ai $(ls "$WP/node_modules/@deepseek-ai" | wc -l) 个包）"
  echo "  请重启：systemctl --user restart dsh-wechat"
  exit 0
fi

echo "──────────────────────────────────────────────"
echo " dsh 升级后收尾（$(date '+%Y-%m-%d %H:%M')）"
echo "──────────────────────────────────────────────"

echo
echo "[1/4] 重打 v0→v1 迁移器补丁（否则 273 个 v0 旧会话会全部打不开）"
if bash "$ROOT/apply-sessionfix.sh"; then :; else
  echo "  ⚠️ 迁移器补丁失败：dsh 可能改了实现，需人工检查 dsh-session-format-v0-to-v1/lib/index.js"
fi

echo
echo "[2/4] 重贴黑鲸 favicon（PWA/标签页图标）"
if bash "$ROOT/apply-favicon.sh"; then :; else
  echo "  ⚠️ favicon 替换失败：检查 dsh-web-frontend/dist/favicon.svg 是否还在同一路径"
fi

echo
echo "[3/4] 自动检查"
GLOBAL="$(npm prefix -g 2>/dev/null)/lib/node_modules/@deepseek-ai/dsh"
# 3.1 插件 API 兼容性
if [ -d "$GLOBAL/node_modules/@deepseek-ai/dsh-workspace" ]; then
  if grep -q "setState(state)" "$GLOBAL/node_modules/@deepseek-ai/dsh-workspace/lib/index.js" 2>/dev/null; then
    echo "  ✅ dsh-workspace 仍有 setState —— dsh-archive-sync 应可用"
  else
    echo "  ⚠️ dsh-workspace 的 setState 不见了 —— dsh-archive-sync 需按新版适配"
  fi
fi
# 3.2 会话日志文件名（terminal-server / ask-pending.py 依赖）
if [ -d "$GLOBAL/node_modules/@deepseek-ai/dsh-session-format-v2-to-v3" ]; then
  echo "  ℹ️ 当前会话格式链含 v2→v3；若日志文件名再变（现为 session.v3.jsonl.zstd），"
  echo "     需同步 terminal-server/server.js 与 ask-pending.py 的候选名列表"
fi
# 3.3 wechat profile 本地依赖滞后检查（2026-09-06 / 2026-09-10 两次踩坑）
WP="$HOME/.dsh/profiles/wechat"
if [ -d "$WP/node_modules/@deepseek-ai" ]; then
  LAG=0
  for pkg in dsh-session dsh-agent dsh-llm; do
    LV=$(python3 -c "import json;print(json.load(open('$WP/node_modules/@deepseek-ai/$pkg/package.json'))['version'])" 2>/dev/null || echo "-")
    GV=$(python3 -c "import json;print(json.load(open('$GLOBAL/node_modules/@deepseek-ai/$pkg/package.json'))['version'])" 2>/dev/null || echo "-")
    if [ "$LV" != "$GV" ] && [ "$LV" != "-" ]; then
      echo "  ⚠️ wechat profile 本地依赖滞后：$pkg 本地 $LV vs 全局 $GV"
      LAG=1
    fi
  done
  if [ "$LAG" = "1" ]; then
    echo "     修法：把全局官方包复制过去（历史教训：滞后会导致 session.events is not iterable /"
    echo "     undefined.filter 等诡异报错，微信通道会坏）："
    echo "       cp -r $GLOBAL/node_modules/@deepseek-ai/* $WP/node_modules/@deepseek-ai/"
    echo "     然后重启：sudo systemctl restart dsh-wechat"
    if [ "$FIX" = "1" ]; then
      echo "     ⚠️ 警告：只有【同时升级 dsh-wechat 插件】时才应执行本步。"
      echo "        2026-09-10 实测：@deepseek-ai 升级没问题，但 mnemon 只升主包会启动失败"
      echo "        出事后可一键回滚：bash $0 --rollback"
      echo "     --fix 已启用，开始对齐（原 package.json 会先备份）…"
      cp "$WP/package.json" "$HOME/.dsh/backup/wechat-package.json.bak-$(date +%Y%m%d-%H%M%S)" 2>/dev/null || true
      mkdir -p "$WP/node_modules/@deepseek-ai"
      cp -r "$GLOBAL/node_modules/@deepseek-ai/." "$WP/node_modules/@deepseek-ai/" && echo "       ✅ 官方包已同步（$(ls "$WP/node_modules/@deepseek-ai" | wc -l) 个）"
      # mnemon 必须全家一起升：只升主包会让配套子包缺导出（实测
      # dsh-mnemon-source-memory-spaces 的 ./native-cli 找不到 → ERR_PACKAGE_PATH_NOT_EXPORTED）
      WEBNM="$HOME/.dsh/profiles/web/node_modules"
      if [ -d "$WEBNM/dsh-mnemon" ]; then
        n=0
        for d in "$WEBNM"/dsh-mnemon*; do
          [ -d "$d" ] || continue
          pkg="$(basename "$d")"
          rm -rf "$WP/node_modules/$pkg"
          cp -r "$d" "$WP/node_modules/$pkg" && n=$((n+1))
        done
        echo "       ✅ mnemon 全家已同步（$n 个包；主包与配套子包必须同批升级）"
      fi
      echo "       → 请重启：sudo systemctl restart dsh-wechat"
    else
      echo "     提示：加 --fix 可自动完成对齐（bash $0 --fix）"
    fi
  else
    echo "  ✅ wechat profile 本地依赖与全局一致"
  fi
fi

echo
echo "[4/4] 重启服务（需要主手动，脚本不代劳）"
echo "     sudo systemctl restart dsh-web dsh-terminal"
echo "     然后刷新浏览器（Ctrl+Shift+R）"

echo
echo "──────────────────────────────────────────────"
echo " 完成。若 [3/4] 有 ⚠️，按提示处理后再重启。"
echo "──────────────────────────────────────────────"
