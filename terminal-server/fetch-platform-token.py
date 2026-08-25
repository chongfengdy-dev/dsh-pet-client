#!/usr/bin/env python3
# 自动获取 DeepSeek 开放平台 userToken（2026-08-25 主需求：不想每次 F12 手动找）
# 原理：CentBrowser（Chromium 系）的 localStorage 存于 LevelDB（明文），
# platform.deepseek.com 的 userToken 在其中。直接解析 LevelDB 读出。
# 用法：python3 fetch-platform-token.py            # 打印 token 到 stdout
#       python3 fetch-platform-token.py --write    # 写回 platform-token.json
# 依赖：plyvel（pip install plyvel；本机 WSL 无 pip 权限，已装到 /tmp/py-libs）
# 注意：浏览器运行中 LevelDB 有写锁，需先拷贝目录再解析（plyvel 需排他锁）。
import os, sys, json, shutil, tempfile

OUT_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'platform-token.json')
TARGET_KEY = '_https://platform.deepseek.com\x00\x01userToken'

def find_profile_ls():
    """动态定位 CentBrowser localStorage：枚举 /mnt/c/Users 下真实用户目录，
    不硬编码用户名（2026-08-25 主要求：发布代码不含个人电脑名）。"""
    users_root = '/mnt/c/Users'
    try:
        for name in sorted(os.listdir(users_root)):
            if name.startswith('.') or name in ('Public', 'Default', 'Default User', 'All Users'):
                continue
            cand = os.path.join(users_root, name, 'AppData', 'Local', 'CentBrowser',
                                'User Data', 'Default', 'Local Storage', 'leveldb')
            if os.path.isdir(cand):
                return cand
    except OSError:
        pass
    return None

def read_token():
    profile = find_profile_ls()
    if not os.path.isdir(profile):
        return None, f"localStorage 目录不存在: {profile}"
    # 拷贝 leveldb 目录到临时位置（浏览器运行中 LOCK 被占，plyvel 需要排他锁）
    tmp = tempfile.mkdtemp(prefix='dsh-ls-')
    try:
        for name in os.listdir(profile):
            src = os.path.join(profile, name)
            if os.path.isfile(src):
                try:
                    shutil.copy2(src, os.path.join(tmp, name))
                except Exception:
                    pass  # LOCK 等被占文件跳过
        try:
            import plyvel
        except ImportError:
            return None, "plyvel 未安装（pip install plyvel 或 PYTHONPATH=/tmp/py-libs）"
        db = plyvel.DB(tmp, create_if_missing=False)
        try:
            for key, value in db:
                if key.decode('utf-8', 'replace') == TARGET_KEY:
                    v = value.decode('utf-8', 'replace')
                    # 格式: \x01{"value":"<token>","__version":"0"}
                    obj = json.loads(v[1:])
                    token = obj.get('value')
                    if token:
                        return token, None
        finally:
            db.close()
        return None, "leveldb 中未找到 platform.deepseek.com 的 userToken（可能未登录该站点）"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

def main():
    token, err = read_token()
    if err:
        print(f"[error] {err}", file=sys.stderr)
        sys.exit(1)
    if '--write' in sys.argv:
        # 保留 note 字段，仅更新 token
        old = {}
        try:
            with open(OUT_FILE, 'r', encoding='utf-8') as f:
                old = json.load(f)
        except Exception:
            pass
        old['userToken'] = token
        old['note'] = '自动获取自 CentBrowser localStorage（platform.deepseek.com userToken）'
        with open(OUT_FILE, 'w', encoding='utf-8') as f:
            json.dump(old, f, ensure_ascii=False, indent=2)
        print(f"[ok] token 已更新到 {OUT_FILE}")
    else:
        print(token)

if __name__ == '__main__':
    main()
