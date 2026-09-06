#!/usr/bin/env bash
# apply-auto-auth: 给 dsh web 认证模块打"401 自动认证"补丁（幂等）。
# 效果：无 cookie 访问首页 → 直接种 30 天持久 cookie 并 303 回 /（PWA/新浏览器首次
# 访问自动认证，无需手动带 token）。v2 单层跳转，避免 302→303 链在个别浏览器触发
# ERR_TOO_MANY_REDIRECTS。dsh 升级(npm i -g @deepseek-ai/dsh)会覆盖 node_modules →
# 升级后重跑本脚本（与 apply-favicon.sh 同批）。
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

python3 - <<PYEOF
p = "$AUTH_JS"
s = open(p, encoding='utf-8').read()
old = "\t\tif (this.isAuthenticated(req)) return true;\n\t\tthis.writeUnauthorized(req, res);\n\t\treturn false;\n\t}"
new = "\t\tif (this.isAuthenticated(req)) return true;\n" \
      "\t\t// [dsh-pet-client 补丁 2026-09-06 v2] 401 自动处理：无 cookie 访问首页 → 直接种\n" \
      "\t\t// 持久 cookie 并 303 回 /（与官方 token 交换分支同构，单层跳转无循环风险）。\n" \
      "\t\tif (req.method === \"GET\" && url.pathname === \"/\") {\n" \
      "\t\t\tconst authority = requestAuthority(req.headers);\n" \
      "\t\t\tif (authority !== void 0) {\n" \
      "\t\t\t\tconst issuedAt = Date.now();\n" \
      "\t\t\t\tconst expiresAt = issuedAt + this.maxAgeMilliseconds;\n" \
      "\t\t\t\tconst value = encodeCookie({\n" \
      "\t\t\t\t\tversion: COOKIE_PAYLOAD_VERSION,\n" \
      "\t\t\t\t\tauthority,\n" \
      "\t\t\t\t\tissuedAt,\n" \
      "\t\t\t\t\texpiresAt\n" \
      "\t\t\t\t}, this.secret);\n" \
      "\t\t\t\tres.writeHead(303, {\n" \
      "\t\t\t\t\t\"cache-control\": \"no-store\",\n" \
      "\t\t\t\t\t\"location\": \"/\",\n" \
      "\t\t\t\t\t\"referrer-policy\": \"no-referrer\",\n" \
      "\t\t\t\t\t\"set-cookie\": sessionCookie(cookieName(authority), value, expiresAt, Math.floor(this.maxAgeMilliseconds / 1e3))\n" \
      "\t\t\t\t});\n" \
      "\t\t\t\tres.end();\n" \
      "\t\t\t\treturn false;\n" \
      "\t\t\t}\n" \
      "\t\t}\n" \
      "\t\tthis.writeUnauthorized(req, res);\n" \
      "\t\treturn false;\n" \
      "\t}"
assert s.count(old) == 1, '补丁锚点匹配 %d' % s.count(old)
s = s.replace(old, new)
open(p, 'w', encoding='utf-8').write(s)
print('[apply-auto-auth] 已打补丁:', p)
PYEOF
