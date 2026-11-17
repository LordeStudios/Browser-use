#!/bin/sh
# Browser-use device diagnostic: why the bundled browser will not start.
echo "=== platform ==="
uname -m
uname -s
echo "kernel: $(uname -r)"

echo
echo "=== binary ==="
BIN=$(ls -d "$HOME"/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell 2>/dev/null | head -1)
if [ -z "$BIN" ]; then
  echo "no bundled browser found under $HOME/.cache/ms-playwright"
  exit 1
fi
echo "path: $BIN"
ls -l "$BIN" 2>&1 | tail -1
echo "file type:"
head -c 20 "$BIN" | od -c 2>/dev/null | head -2

echo
echo "=== direct run (version) ==="
"$BIN" --version 2>&1 | head -20
echo "exit code: $?"

echo
echo "=== direct run (headless, no sandbox) ==="
"$BIN" --headless --no-sandbox --disable-gpu --dump-dom about:blank 2>&1 | head -25
echo "exit code: $?"

echo
echo "=== missing shared libraries ==="
if command -v ldd >/dev/null 2>&1; then
  ldd "$BIN" 2>&1 | grep -i "not found" | head -20
  echo "--- ldd total missing: $(ldd "$BIN" 2>&1 | grep -ci 'not found')"
else
  echo "ldd not available in this container"
fi

echo
echo "=== interpreter ==="
ls -l /lib/ld-* /lib64/ld-* 2>/dev/null | head -5
echo "--- glibc:"
ls /lib/*libc.so* /lib/*libc-* 2>/dev/null | head -5

echo
echo "=== done ==="
