#!/usr/bin/env bash
# ⚠️ 已废弃 —— 不要运行本脚本 ⚠️
#
# 历史：这是"401 自动认证"补丁（无 cookie 访问首页 → 种 30 天 cookie + 303 回 /），
# 2026-09-06 v2.2 已按决定**从代码里撤销**（commit 927ae3d）——"模式切换后自动刷新 /
# 自动认证"那一整套都移除了，改为手动 F5。
#
# 重新运行它会把当年的老问题引回来（个别浏览器 ERR_TOO_MANY_REDIRECTS）。
# 保留本文件仅为追溯历史；原实现见 git 历史（927ae3d 之前的版本）。
#
# dsh 升级后请改用：bash ~/deepseek-harness/nim-client/post-dsh-upgrade.sh [--fix]
set -euo pipefail
echo "[apply-auto-auth] 已废弃：v2.2 起不再使用（重跑会引入 ERR_TOO_MANY_REDIRECTS）。"
echo "                  dsh 升级后请跑 post-dsh-upgrade.sh（需要对齐微信依赖时加 --fix）。"
exit 1
