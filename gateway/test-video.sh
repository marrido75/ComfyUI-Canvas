#!/bin/bash
# MiniMax H3 视频接口端到端测试（在 gateway 目录外任意位置可运行）
# 用法: bash gateway/test-video.sh [prompt] [seconds]
PROMPT="${1:-一只橘猫在雨中的霓虹街道上缓慢走过，电影感，有雨声}"
SECONDS="${2:-3}"
GW="http://127.0.0.1:8190"
cd "$(dirname "$0")/.."

echo "=== 1. 提交视频任务 ==="
RESP=$(curl -s --max-time 30 -X POST "$GW/v1/videos" \
  -F "model=video-minimax-h3" \
  -F "prompt=$PROMPT" \
  -F "seconds=$SECONDS" \
  -F "size=864x480")
echo "$RESP"
TASK_ID=$(echo "$RESP" | python -c "import json,sys; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
if [ -z "$TASK_ID" ]; then echo "提交失败"; exit 1; fi

echo ""
echo "=== 2. 轮询状态（任务 $TASK_ID，最长 20 分钟）==="
for i in $(seq 1 240); do
  STATE=$(curl -s --max-time 10 "$GW/v1/videos/$TASK_ID")
  STATUS=$(echo "$STATE" | python -c "import json,sys; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
  echo "[$i] $STATUS"
  if [ "$STATUS" = "completed" ]; then break; fi
  if [ "$STATUS" = "failed" ]; then echo "$STATE"; exit 1; fi
  sleep 5
done

echo ""
echo "=== 3. 下载 MP4 ==="
curl -s --max-time 120 "$GW/v1/videos/$TASK_ID/content" -o "test-video-$TASK_ID.mp4" -w "HTTP:%{http_code} 大小:%{size_download} bytes\n"
ls -lh "test-video-$TASK_ID.mp4"
echo "完成: test-video-$TASK_ID.mp4"
