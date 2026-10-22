#!/bin/bash
TODAY=$(date +%Y-%m-%d)
TS=$(date +%s)000

node /home/xenhive/amu-platform/ingest.js "{\"channel\":\"amu\",\"user_id\":\"111\",\"username\":\"testuser1\",\"display_name\":\"Test User 1\",\"timestamp\":${TS},\"text\":\"Hey everyone check this out https://xentraffic.com\",\"is_thread_start\":1}"

node /home/xenhive/amu-platform/ingest.js "{\"channel\":\"amu\",\"user_id\":\"222\",\"username\":\"testuser2\",\"display_name\":\"Test User 2\",\"timestamp\":${TS},\"text\":\"Interesting!\",\"reply_to_msg_id\":999,\"reply_to_user_id\":\"111\"}"

node /home/xenhive/amu-platform/ingest.js "{\"channel\":\"amu\",\"user_id\":\"111\",\"username\":\"testuser1\",\"display_name\":\"Test User 1\",\"timestamp\":${TS},\"text\":\"Another one\"}"

echo "--- Stats ---"
node /home/xenhive/amu-platform/tracker.js stats $TODAY amu

echo "--- Highlights Preview ---"
node /home/xenhive/amu-platform/tracker.js highlights $TODAY amu
