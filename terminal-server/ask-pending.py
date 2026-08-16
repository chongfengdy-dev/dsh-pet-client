#!/usr/bin/env python3
# 检测是否有"等待用户交互"（主定稿 2026-08-16：凡是要主确认的都要橙闪提示）：
# 1. ask_user_question 提问未决（tool/call 精确匹配 name + callId 配对 + answered 集合防重试）
# 2. approval/asked 审批/授权请求未决（asked > decided，最近 10 分钟内）
# 时间窗：只认最近 10 分钟内的未决（历史遗留不提醒）
import os, re, json, time, zstandard

SESS_ROOT = os.path.expanduser('~/.dsh/sessions')
CALLID_RE = re.compile(rb'"callId":"([^"]+)"')
TIME_RE = re.compile(rb'"time":(\d+)')
ASK_WINDOW_MS = 10 * 60 * 1000   # 10 分钟窗口

def latest_session_file():
    best = None
    best_mt = 0
    if not os.path.isdir(SESS_ROOT):
        return None
    for scope in os.listdir(SESS_ROOT):
        sp = os.path.join(SESS_ROOT, scope)
        if not os.path.isdir(sp):
            continue
        for sid in os.listdir(sp):
            f = os.path.join(sp, sid, 'session.jsonl.zstd')
            if not os.path.isfile(f):
                continue
            mt = os.path.getmtime(f)
            if mt > best_mt:
                best_mt = mt
                best = f
    return best

def main():
    f = latest_session_file()
    if not f:
        print(json.dumps({'asking': False}))
        return
    now = int(time.time() * 1000)
    called = {}       # ask_user_question: callId -> 最近 call 时间
    answered = set()  # ask_user_question: 出现过 result → 已答
    ask_asked = ask_decided = 0   # approval 计数（10 分钟窗口内）
    try:
        d = zstandard.ZstdDecompressor()
        with open(f, 'rb') as fh:
            with d.stream_reader(fh) as r:
                buf = b''
                while True:
                    chunk = r.read(1 << 20)
                    if not chunk:
                        break
                    buf += chunk
                    while b'\n' in buf:
                        line, buf = buf.split(b'\n', 1)
                        if b'"name":"ask_user_question"' in line:
                            m = CALLID_RE.search(line)
                            if m:
                                tm = TIME_RE.search(line)
                                called[m.group(1)] = int(tm.group(1)) if tm else 0
                        elif b'"tool/result"' in line:
                            m = CALLID_RE.search(line)
                            if m:
                                answered.add(m.group(1))
                        elif b'"approval/asked"' in line:
                            tm = TIME_RE.search(line)
                            if tm and now - int(tm.group(1)) <= ASK_WINDOW_MS:
                                ask_asked += 1
                        elif b'"approval/decided"' in line:
                            tm = TIME_RE.search(line)
                            if tm and now - int(tm.group(1)) <= ASK_WINDOW_MS:
                                ask_decided += 1
    except Exception:
        pass
    ask_pending = any((now - t) <= ASK_WINDOW_MS and cid not in answered
                      for cid, t in called.items())
    approval_pending = ask_asked > ask_decided
    print(json.dumps({'asking': ask_pending or approval_pending}))

if __name__ == '__main__':
    main()
