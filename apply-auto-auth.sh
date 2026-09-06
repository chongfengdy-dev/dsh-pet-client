#!/usr/bin/env bash
# apply-auto-auth: 给 dsh web 认证模块打"401 自动认证"补丁（幂等）。
# 效果：无 cookie 访问首页 → 自动用本进程 launch token 302 种 cookie（PWA/新浏览器
# 首次访问自动认证，无需手动带 token）。dsh 升级(npm i -g @deepseek-ai/dsh)会覆盖
# node_modules → 升级后重跑本脚本（与 apply-favicon.sh 同批）。
set -euo pipefail

AUTH_JS="$(find "$(npm prefix -g)/lib/node_modules/@deepseek-ai/dsh" \
  -path "*@deepseek-ai/dsh-client-connection/lib/index.js" 2>/dev/null | head -1)"

if [ -z "$AUTH_JS" ]; then
  echo "[apply-auto-auth] 未找到 dsh-client-connection/lib/index.js，跳过"
  exit 1
fi

# 已打补丁（含标记注释）→ 跳过
if grep -q "dsh-pet-client 补丁 2026-09-06" "$AUTH_JS"; then
  echo "[apply-auto-auth] 已是自动认证版，无需重复打补丁"
  exit 0
fi

python3 - <<EOF
p = "$AUTH_JS"
s = open(p, encoding='utf-8').read()
old = "\t\tif (this.isAuthenticated(req)) return true;\n\t\tthis.writeUnauthorized(req, res);\n\t\treturn false;\n\t}"
new = "\t\tif (this.isAuthenticated(req)) return true;\n" \\
      "\t\t// [dsh-pet-client 补丁 2026-09-06] 401 自动处理：无 cookie 访问首页 → 自动用本进程\\n" \\
      "\t\t// launch token 302 到 /?token=xxx → 服务端验 token 种 cookie → 303 落回干净 /。\\n" \\
      "\t\tif (req.method === \"GET\" && url.pathname === \"/\") {\n" \\
      "\t\t\tres.writeHead(302, { \"location\": \"/?token=\" + encodeURIComponent(this.launchToken) });\n" \\
      "\t\t\tres.end();\n" \\
      "\t\t\treturn false;\n" \\
      "\t\t}\n" \\
      "\t\tthis.writeUnauthorized(req, res);\n" \\
      "\t\treturn false;\n" \\
      "\t}"
assert s.count(old) == 1, '补丁锚点匹配 %d' % s.count(old)
s = s.replace(old, new)
open(p, 'w', encoding='utf-8').write(s)
print('[apply-auto-auth] 已打补丁:', p)
EOF
