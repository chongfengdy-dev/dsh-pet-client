#!/usr/bin/env bash
# dsh-mode: 一键切换 dsh web 纯净/完整模式
# 用法: dsh-mode clean   切纯净模式(剥离第三方插件, 保留官方 base+web-app)
#       dsh-mode full    切完整模式(默认, 含第三方插件)
#       dsh-mode status  查看当前模式
#
# 原理: 创建/删除标记文件 ~/.dsh/.dsh-web-mode, 然后重启 dsh-web 服务。
# 服务 ExecStart 由 web-launch.sh 读取该标记决定是否加 --patch。
#
# 用 stop→等3080释放→start 而非 restart，避免 Restart=always 在端口未释放时
# 反复重试、token 多次变化导致客户端跟不上(401)。
set -euo pipefail

# 真实用户目录动态获取：脚本可能被 sudo bash 调用（sudo 会把 $HOME 重置为 /root），
# 而 dsh-web.service 以 User=dream 运行，标记必须写在服务实际读取的 $HOME 下。
REAL_USER="${SUDO_USER:-$(id -un)}"
REAL_HOME="$(getent passwd "$REAL_USER" | cut -d: -f6)"

MARK="$REAL_HOME/.dsh/.dsh-web-mode"
SERVICE="dsh-web"
PORT=3080

# 等端口释放(最多 ~8s)
wait_port_free() {
  for _ in $(seq 1 40); do
    if ! (exec 3<>/dev/tcp/127.0.0.1/$PORT) 2>/dev/null; then return 0; fi
    exec 3>&- 3<&- 2>/dev/null || true
    sleep 0.2
  done
  echo "警告: 端口 $PORT 释放超时，继续尝试启动"
}

switch() {
  local mode="$1"
  echo "[1/3] 标记 $mode ..."
  if [ "$mode" = "clean" ]; then touch "$MARK"; else rm -f "$MARK"; fi
  echo "[2/3] 停止 $SERVICE ..."
  sudo systemctl stop "$SERVICE" 2>/dev/null || true
  wait_port_free
  echo "[3/3] 启动 $SERVICE ..."
  sudo systemctl start "$SERVICE"
  echo "完成: 已切到 $mode 模式(端口 $PORT)"
}

case "${1:-}" in
  clean)
    switch clean
    ;;
  full)
    switch full
    ;;
  status)
    if [ -f "$MARK" ]; then
      echo "当前: 纯净模式 (剥离第三方插件)"
    else
      echo "当前: 完整模式 (含第三方插件)"
    fi
    ;;
  *)
    echo "用法: dsh-mode {clean|full|status}"
    exit 1
    ;;
esac
