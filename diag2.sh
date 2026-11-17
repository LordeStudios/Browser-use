#!/bin/sh
BIN=$(ls -d "$HOME"/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell 2>/dev/null | head -1)
OUT=/sdcard/bu-diag.txt
{
  echo "BIN=$BIN"
  echo "--- missing libs:"
  ldd "$BIN" 2>&1 | grep -i "not found" | sed 's/^[[:space:]]*//'
  echo "--- total missing: $(ldd "$BIN" 2>&1 | grep -ci 'not found')"
  echo "--- present libs sample:"
  ldd "$BIN" 2>&1 | grep -v "not found" | head -8
  echo "--- lib dirs:"
  ls /lib /usr/lib 2>/dev/null | head -20
} > "$OUT" 2>&1
echo "written to $OUT"
