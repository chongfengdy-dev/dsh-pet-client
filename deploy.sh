#!/usr/bin/env bash
# DSH-Pet-Client v2.1.4 — WSL 一键部署
# 跑一遍 = 安装 + 配置 + systemd 服务自启 + 重启 WSL（之后 Windows 双击 exe 即用）
# 用法：bash deploy.sh
set -e

PKG_DIR="$(cd "$(dirname "$0")" && pwd)"
USER_NAME="$(whoami)"

echo "=============================================="
echo " DSH-Pet-Client v2.1.4 WSL 部署"
echo " 包目录: $PKG_DIR"
echo "=============================================="

echo ""
echo "== 1/6 检查依赖 =="
command -v node >/dev/null || { echo "[错误] 未找到 node，请先安装 Node.js 20+：https://nodejs.org"; exit 1; }
command -v npm >/dev/null || { echo "[错误] 未找到 npm"; exit 1; }
command -v sudo >/dev/null || { echo "[错误] 未找到 sudo（需要 root 配置 systemd 服务）"; exit 1; }
command -v pnpm >/dev/null || { echo "[信息] 安装 pnpm..."; npm install -g pnpm; }
python3 -c "import zstandard" 2>/dev/null || { echo "[信息] 安装 python zstandard..."; pip3 install --user zstandard 2>/dev/null || pip3 install zstandard; }

echo ""
echo "== 2/6 安装 dsh =="
npm install -g @deepseek-ai/dsh
DSH_BIN="$(npm prefix -g)/bin/dsh"
echo "[信息] dsh 位于: $DSH_BIN"

echo ""
echo "== 3/6 配置 DeepSeek API Key =="
if [ ! -f "$HOME/.dsh/.credentials.yaml" ]; then
  mkdir -p "$HOME/.dsh"
  read -r -p "请输入 DeepSeek API Key: " KEY
  echo "DEEPSEEK_API_KEY: $KEY" > "$HOME/.dsh/.credentials.yaml"
  chmod 600 "$HOME/.dsh/.credentials.yaml"
  echo "[信息] 已写入 $HOME/.dsh/.credentials.yaml"
else
  echo "[信息] 检测到已有 API Key 配置，跳过"
fi

echo ""
echo "== 4/6 安装终端服务（3081）依赖 =="
cd "$PKG_DIR/terminal-server"
npm install
cd "$PKG_DIR"

echo ""
echo "== 5/6 安装 dsh-term-panels 插件 =="
dsh plugin --profile web add "$PKG_DIR/dsh-term-panels" 2>/dev/null || \
  dsh plugin --profile web add "$PKG_DIR/dsh-term-panels"

echo ""
echo "== 6/6 配置 systemd 服务（自启）=="
sed -e "s|<USER>|$USER_NAME|g" -e "s|<PKG_DIR>|$PKG_DIR|g" \
    -e "s|/home/<USER>/.npm-global/bin/dsh|$DSH_BIN|g" \
    "$PKG_DIR/dsh-web.service" > /tmp/dsh-web.generated
sed -e "s|<USER>|$USER_NAME|g" -e "s|<PKG_DIR>|$PKG_DIR|g" \
    "$PKG_DIR/dsh-terminal.service" > /tmp/dsh-terminal.generated
sudo cp /tmp/dsh-web.generated /etc/systemd/system/dsh-web.service
sudo cp /tmp/dsh-terminal.generated /etc/systemd/system/dsh-terminal.service
sudo systemctl daemon-reload
sudo systemctl enable --now dsh-web dsh-terminal
echo "[信息] dsh-web + dsh-terminal 服务已启用并启动"

echo ""
echo "=============================================="
echo " 部署完成！"
echo " 服务已配置为 WSL 开机自启。"
echo " 即将重启 WSL（当前会话会关闭）——"
echo " 重新打开 WSL 后，Windows 双击 DSH-Pet-Client.exe 即可使用。"
echo "=============================================="
sleep 3
echo "[信息] 正在重启 WSL..."
wsl.exe --shutdown
