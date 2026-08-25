#!/usr/bin/env python3
# 自动获取 DeepSeek 开放平台 userToken（2026-08-25 主需求：不想每次 F12 手动找）
# 原理：Chromium 系浏览器（Chrome/Edge/CentBrowser/Brave/Vivaldi 等）的 localStorage
# 存于各自 User Data 的 LevelDB（明文），platform.deepseek.com 的 userToken 在其中。
# 自动遍历本机常见浏览器目录，取第一个包含目标数据的（即用户实际登录的浏览器）。
# 用法：python3 fetch-platform-token.py            # 打印 token 到 stdout
#       python3 fetch-platform-token.py --write    # 写回 platform-token.json
# 依赖：plyvel（pip install plyvel；本机 WSL 无 pip 权限，已装到 /tmp/py-libs）
# 注意：浏览器运行中 LevelDB 有写锁，需先拷贝目录再解析（plyvel 需排他锁）。
import os, sys, json, shutil, tempfile

# 依赖自足：优先加载脚本同目录 plyvel-lib（部署包随带，无系统 pip 权限环境可用）
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_LIB_DIR = os.path.join(_SCRIPT_DIR, 'plyvel-lib')
if os.path.isdir(_LIB_DIR) and _LIB_DIR not in sys.path:
    sys.path.insert(0, _LIB_DIR)

OUT_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'platform-token.json')
TARGET_KEY = '_https://platform.deepseek.com\x00\x01userToken'

# 常见 Chromium 系浏览器（按 Windows 用户目录下的 AppData\Local 布局）
BROWSERS = ['Chrome', 'Edge', 'CentBrowser', 'BraveSoftware/Brave-Browser',
            'Vivaldi', 'Opera Software/Opera Stable', '360Chrome/Chrome',
            'Chromium', 'Microsoft/Edge']

def _candidate_dirs():
    """枚举 /mnt/c/Users 下真实用户目录 × 常见浏览器 → localStorage 候选路径。
    不硬编码用户名（2026-08-25 主要求：发布代码不含个人电脑名）。"""
    users_root = '/mnt/c/Users'
    users = []
    try:
        for name in sorted(os.listdir(users_root)):
            if name.startswith('.') or name in ('Public', 'Default', 'Default User', 'All Users'):
                continue
            users.append(name)
    except OSError:
        return []
    for u in users:
        for b in BROWSERS:
            yield os.path.join(users_root, u, 'AppData', 'Local', b,
                               'User Data', 'Default', 'Local Storage', 'leveldb')

def _candidate_dirs():
    """枚举 /mnt/c/Users 下真实用户目录 × 常见浏览器 → localStorage 候选路径。
    不硬编码用户名（2026-08-25 主要求：发布代码不含个人电脑名）。"""
    users_root = '/mnt/c/Users'
    users = []
    try:
        for name in sorted(os.listdir(users_root)):
            if name.startswith('.') or name in ('Public', 'Default', 'Default User', 'All Users'):
                continue
            users.append(name)
    except OSError:
        return []
    for u in users:
        for b in BROWSERS:
            yield os.path.join(users_root, u, 'AppData', 'Local', b,
                               'User Data', 'Default', 'Local Storage', 'leveldb')

def _read_leveldb(profile):
    """解析单个浏览器的 leveldb，返回 userToken 或 None。"""
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
            raise RuntimeError("plyvel 未安装（终端服务目录 plyvel-lib 缺失，需 pip install --target=plyvel-lib plyvel）")
        db = plyvel.DB(tmp, create_if_missing=False)
        try:
            for key, value in db:
                if key.decode('utf-8', 'replace') == TARGET_KEY:
                    v = value.decode('utf-8', 'replace')
                    # 格式: \x01{"value":"<token>","__version":"0"}
                    obj = json.loads(v[1:])
                    token = obj.get('value')
                    if token:
                        return token
        finally:
            db.close()
    except Exception:
        pass  # 单个浏览器解析失败（无数据/损坏/未装 plyvel 之外）不阻塞其他候选
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return None

def read_token():
    """遍历本机所有 Chromium 系浏览器，读第一个含 platform userToken 的
    （即用户实际登录开放平台的那个浏览器，不限于单一品牌）。"""
    found_err = None
    for cand in _candidate_dirs():
        if not os.path.isdir(cand):
            continue
        try:
            token = _read_leveldb(cand)
        except RuntimeError as e:
            found_err = str(e)
            break  # 依赖缺失（plyvel）属环境问题，直接报错
        if token:
            return token, None
    if found_err:
        return None, found_err
    return None, "未找到已登录 platform.deepseek.com 的浏览器（需用任一 Chromium 系浏览器登录开放平台）"

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
        old['note'] = '自动获取自本机浏览器 localStorage（platform.deepseek.com userToken）'
        with open(OUT_FILE, 'w', encoding='utf-8') as f:
            json.dump(old, f, ensure_ascii=False, indent=2)
        print(f"[ok] token 已更新到 {OUT_FILE}")
    else:
        print(token)

if __name__ == '__main__':
    main()
