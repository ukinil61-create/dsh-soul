"""MiniMax 语音合成小助手。复用用户本机配好的工具，密钥只在这个进程里解密，不外传也不打印。

从标准输入读一行 JSON：{"id", "tool_dir", "text", "model", "voice", "speed"}
向标准输出写一行 JSON：{"id", "audio": base64} 或 {"id", "error"}
"""
import base64
import json
import sys
from pathlib import Path


def main():
    sys.stdin.reconfigure(encoding='utf-8')
    sys.stdout.reconfigure(encoding='utf-8')
    app = None
    for line in sys.stdin:
        line = line.strip().lstrip('﻿')
        if not line:
            continue
        request = json.loads(line)
        reply = {'id': request['id']}
        try:
            if app is None:
                sys.path.insert(0, request['tool_dir'])
                import app as loaded  # 用户的工具，里面有 load_key 和 synthesize
                app = loaded
            path = Path(app.synthesize(
                key=app.load_key(),
                text=request['text'],
                model=request['model'],
                voice=request['voice'],
                speed=float(request['speed']),
            ))
            reply['audio'] = base64.b64encode(path.read_bytes()).decode('ascii')
            # 工具会把每一句都存一份，念完的句子没必要留，不然文件夹会越积越多
            path.unlink(missing_ok=True)
            path.with_suffix('.txt').unlink(missing_ok=True)
        except Exception as error:  # 任何失败都交给调用方记录，这里不能退出
            reply['error'] = str(error)
        print(json.dumps(reply), flush=True)


if __name__ == '__main__':
    main()
