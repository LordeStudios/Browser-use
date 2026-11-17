#!/bin/sh
BIN=$(ls -d "$HOME"/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell 2>/dev/null | head -1)
ALL=$(ldd "$BIN" 2>&1 | grep "not found" | cut -d' ' -f1 | tr '\n' ',')
COUNT=$(ldd "$BIN" 2>&1 | grep -c "not found")
TOTAL=$(ldd "$BIN" 2>&1 | wc -l)
wget -q -O /dev/null "http://192.168.1.4:8099/report?missing=$COUNT&total=$TOTAL&libs=$ALL"
echo "reported: $COUNT missing of $TOTAL deps"
echo "$ALL" | tr ',' '\n' | head -20
