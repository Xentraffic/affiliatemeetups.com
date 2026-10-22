#!/bin/bash
# AMU Platform — OpenClaw message ingest hook
# Add to openclaw.json as a postMessage hook for AMU + XenTraffic groups
# Called with: CHANNEL, USER_ID, USERNAME, DISPLAY_NAME, MSG_ID, REPLY_TO_ID, REPLY_TO_USER, TEXT, THREAD_ID, TIMESTAMP

CHANNEL="$1"
USER_ID="$2"
USERNAME="$3"
DISPLAY_NAME="$4"
MSG_ID="$5"
REPLY_TO_MSG_ID="$6"
REPLY_TO_USER_ID="$7"
TEXT="$8"
THREAD_ID="$9"
TIMESTAMP="${10:-$(date +%s)000}"

# Determine is_thread_start (no reply, no thread_id = new top-level message)
IS_THREAD_START=0
if [ -z "$REPLY_TO_MSG_ID" ] && [ -z "$THREAD_ID" ]; then
  IS_THREAD_START=1
fi

node /home/xenhive/amu-platform/ingest.js "{
  \"channel\": \"$CHANNEL\",
  \"telegram_msg_id\": $MSG_ID,
  \"user_id\": \"$USER_ID\",
  \"username\": \"$USERNAME\",
  \"display_name\": \"$DISPLAY_NAME\",
  \"timestamp\": $TIMESTAMP,
  \"text\": $(echo "$TEXT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'),
  \"reply_to_msg_id\": ${REPLY_TO_MSG_ID:-null},
  \"reply_to_user_id\": ${REPLY_TO_USER_ID:+\"$REPLY_TO_USER_ID\"}${REPLY_TO_USER_ID:-null},
  \"thread_id\": ${THREAD_ID:-null},
  \"is_thread_start\": $IS_THREAD_START
}" 2>/dev/null

exit 0
