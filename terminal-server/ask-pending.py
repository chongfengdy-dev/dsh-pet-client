#!/usr/bin/env python3
# 检测会话状态（主定稿 2026-08-16 橙闪；2026-08-21 新增回复完成绿闪）：
# 1. ask_user_question 提问未决（tool/call 精确匹配 name + callId 配对 + answered 集合防重试）
# 2. approval/asked 审批/授权请求未决（asked > decided，最近 10 分钟内）
# 3. 回复完成（2026-08-21 主需求：提问后 dsh 干完活绿闪提示）——
#    turn 配对：最后一个 turn/end(completed) 的 turn 内存在 user/message（用户提问触发的轮次）
#    → done=true, doneAt=turn/end 时间戳。自动任务（无 user/message）不误报。
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
        print(json.dumps({'asking': False, 'done': False}))
        return
    now = int(time.time() * 1000)
    called = {}       # ask_user_question: callId -> 最近 call 时间
    answered = set()  # ask_user_question: 出现过 result → 已答
    ask_asked = ask_decided = 0   # approval 计数（10 分钟窗口内）
    # ---- 回复完成判定（turn 顺序配对，2026-09-06 修复）----
    # dsh 0.1.2 事件流 turn/start|turn/end 行无 "turn":N 字段（仅 type/seq/time），
    # 旧版按 turn 号配对永远匹配不上 → done 恒 false、绿闪永不触发。
    # 改为顺序配对：turn/start 开启区间，区间内出现 user/message 记为"用户提问轮"；
    # turn/end(kind=completed) 关闭区间并记录 (time, has_user)。
    last_user_msg = None      # 最后 user/message 时间
    turn_active = False       # 是否处于 turn/start..turn/end 区间
    cur_has_user = False      # 当前区间内是否出现过 user/message
    last_completed_end = None # 最后一个 completed turn/end: (time, has_user)
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
                        elif b'"type":"turn/start"' in line:
                            turn_active = True
                            cur_has_user = False
                        elif b'"type":"user/message"' in line:
                            tm = TIME_RE.search(line)
                            if tm:
                                last_user_msg = int(tm.group(1))
                                if turn_active:
                                    cur_has_user = True
                        elif b'"type":"turn/end"' in line:
                            tm = TIME_RE.search(line)
                            if tm:
                                # 只认 completed 结束（进行中/中断不算完成）
                                if b'"kind":"completed"' in line:
                                    last_completed_end = (int(tm.group(1)), cur_has_user)
                            turn_active = False
                            cur_has_user = False
    except Exception:
        pass
    ask_pending = any((now - t) <= ASK_WINDOW_MS and cid not in answered
                      for cid, t in called.items())
    approval_pending = ask_asked > ask_decided
    # 回复完成：最后一个 turn/end(completed) 存在，其区间内有 user/message（用户提问触发），
    # 且该轮之后没有更新的 user/message（新提问未完成前不算旧轮完成）
    done = False
    done_at = None
    if last_completed_end is not None and last_completed_end[1]:
        t = last_completed_end[0]
        # 该轮结束后没有再发新的提问（最后 user/message 时间 < turn/end 时间）
        if last_user_msg is None or last_user_msg <= t:
            done = True
            done_at = t
    print(json.dumps({'asking': ask_pending or approval_pending, 'done': done,
                      'doneAt': done_at}))

if __name__ == '__main__':
    main()
