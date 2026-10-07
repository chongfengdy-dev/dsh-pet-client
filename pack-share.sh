#!/usr/bin/env bash
# pack-share.sh — 打包 DSH-Pet-Client 发布 zip（安全优先，2026-09-10 定）
#
# 设计原则（此前踩过的坑都在这）：
#   1. 清单以 `git ls-files` 为准 → .gitignore 里的私有/敏感文件天然排除：
#      platform-token.json（开放平台 userToken）、term-state.json、
#      terminal-server/backgrounds/（本机终端背景图，510KB）、*.log、*.exe 等。
#      不要再用 rsync 整目录 —— rsync 不认 .gitignore，会把上面这些搬进包。
#   2. 显式补充 "被 gitignore 但发布必需" 的文件（dsh-web.service）。
#   3. Windows 侧产物（exe + DLL + assets + 使用说明.md）从 exe 所在目录单独取。
#   4. 打包前跑敏感串扫描，命中即中止、不产出 zip。
#   5. **说明文档格式（2026-09-11 主定）：包内所有说明文档一律 .md，不再用 .txt。**
#
# 用法: ./pack-share.sh <版本号> <exe路径> [输出目录]
#   例: ./pack-share.sh v2.2.0 ~/Desktop/DSH-Pet-Client/dsh_client_full.exe
set -euo pipefail

VERSION="${1:?用法: pack-share.sh <版本号 如 v2.2.0> <exe路径> [输出目录]}"
EXE="${2:?缺少 dsh_client_full.exe 路径}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
OUTDIR="${3:-$(dirname "$EXE")}"
ZIP="$OUTDIR/DSH-Pet-Client-${VERSION}-share.zip"
BASE="DSH-Pet-Client-${VERSION}"

[ -f "$EXE" ] || { echo "❌ 找不到 exe: $EXE"; exit 1; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
PKG="$STAGE/$BASE"
mkdir -p "$PKG"

echo "[1/5] 复制 git 跟踪文件（$(git -C "$ROOT" ls-files | wc -l) 个；.gitignore 自动生效）"
cd "$ROOT"
git ls-files -z | while IFS= read -r -d '' f; do
  mkdir -p "$PKG/$(dirname "$f")"
  cp "$f" "$PKG/$f"
done

echo "[2/5] 补充被 gitignore 但发布必需的文件"
for extra in dsh-web.service; do
  if [ -f "$ROOT/$extra" ]; then
    cp "$ROOT/$extra" "$PKG/$extra"
    echo "    + $extra"
  else
    echo "    (跳过缺失: $extra)"
  fi
done

echo "[3/5] 复制 Windows 侧产物"
mkdir -p "$PKG/DSH-Pet-Client"
cp "$EXE" "$PKG/DSH-Pet-Client/dsh_client_full.exe"
EXEDIR="$(cd "$(dirname "$EXE")" && pwd)"
# 2026-10-06：exe 已改为 MinGW 静态链接（编译时加 --passL:-static），
# PE 导入表核验只剩系统 DLL（KERNEL32 / USER32 / api-ms-win-crt-*），
# 历史上随包分发的 libstdc++-6 / libgcc_s_seh-1 / libwinpthread-1 经查全为冗余
# （旧 exe 的导入表同样不含它们），故不再复制任何 DLL。
# 若将来改回动态链接构建，请恢复下面的复制逻辑。
# for dll in "$EXEDIR"/*.dll; do
#   [ -e "$dll" ] && cp "$dll" "$PKG/DSH-Pet-Client/"
# done
echo "    (跳过 DLL：静态链接版零第三方依赖，2026-10-06 核验)"
if [ -d "$EXEDIR/assets" ]; then cp -r "$EXEDIR/assets" "$PKG/DSH-Pet-Client/"; fi
if [ -f "$ROOT/使用说明.md" ]; then cp "$ROOT/使用说明.md" "$PKG/DSH-Pet-Client/使用说明.md"; fi

# 防御性剔除：本机私有资源（终端背景图等），即使将来 .gitignore 变动也不进包
rm -rf "$PKG/terminal-server/backgrounds"
echo "    (已剔除 terminal-server/backgrounds 私有背景图)"

echo "[4/5] 敏感内容扫描"
python3 - "$PKG" <<'PY'
import os, re, sys
PKG = sys.argv[1]
PATS = [(rb'userToken"\s*:\s*"[A-Za-z0-9_\-]{20,}', 'userToken 实值'),
        (rb'/home/[a-z][a-z0-9_-]*/', '绝对家目录 /home/*'),
        (rb'C:\\\\Users\\\\[^\\\\"\' ]+', r'C:\Users\*'),
        (rb'sk-[A-Za-z0-9]{20,}', 'sk- API key'),
        (rb'ghp_[A-Za-z0-9]{20,}', 'ghp_ token'),
        (rb'DESKTOP-[A-Z0-9]{7}', 'DESKTOP 主机名')]
EXTS = ('.py', '.js', '.json', '.sh', '.md', '.txt', '.yml', '.yaml', '.service', '.bat', '.nim', '.cjs', '.mjs')
ALLOW_FILES = {'platform-token.example.json'}   # 占位符示例，放行
hits = []
for dp, dn, fn in os.walk(PKG):
    if 'node_modules' in dp:
        continue
    for f in fn:
        if not f.endswith(EXTS) or f in ALLOW_FILES:
            continue
        fp = os.path.join(dp, f)
        try:
            d = open(fp, 'rb').read()
        except OSError:
            continue
        for pat, label in PATS:
            if re.search(pat, d):
                hits.append(f"{label}  ->  {os.path.relpath(fp, PKG)}")
if hits:
    print('❌ 发现敏感内容，已中止（不会产出 zip）：')
    for h in hits:
        print('    ' + h)
    sys.exit(1)
print('    ✅ 未发现敏感内容')
PY

echo "[5/5] 打包"
python3 - "$STAGE" "$BASE" "$ZIP" <<'PY'
import os, sys, zipfile
stage, base, zpath = sys.argv[1], sys.argv[2], sys.argv[3]
if os.path.exists(zpath):
    os.remove(zpath)
n = 0
root = os.path.join(stage, base)
with zipfile.ZipFile(zpath, 'w', zipfile.ZIP_DEFLATED) as z:
    for dp, dn, fn in os.walk(root):
        for f in fn:
            full = os.path.join(dp, f)
            z.write(full, os.path.relpath(full, stage))
            n += 1
print(f"    ✅ {n} 文件  {os.path.getsize(zpath)/1024:.0f} KB")
print(f"    📦 {zpath}")
PY
