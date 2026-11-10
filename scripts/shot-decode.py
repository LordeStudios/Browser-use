"""Decode a Browser-use MCP screenshot JSON (base64 PNG) into a viewable,
downscaled PNG for reliable model inspection.

Usage: python shot-decode.py <screenshot-json-or-png-path> [out.png] [max-width]
- Accepts the raw JSON saved from the MCP screenshot tool ({"text": "{\"data\":...}"})
  or an already-decoded PNG.
- Downscales to max-width (default 1100px) so every detail stays legible in the
  model's image view instead of overflowing.
"""
import base64, json, sys
from pathlib import Path

src = Path(sys.argv[1])
out = Path(sys.argv[2]) if len(sys.argv) > 2 else src.with_suffix('.view.png')
max_w = int(sys.argv[3]) if len(sys.argv) > 3 else 1100

raw = src.read_bytes()
data = raw
if raw[:1] == b'{':
    obj = json.loads(raw.decode('utf-8', 'replace'))
    inner = obj
    # unwrap {"text": "<json>"} from the MCP tool envelope
    if isinstance(inner, dict) and 'text' in inner and isinstance(inner['text'], str):
        inner = json.loads(inner['text'])
    data = base64.b64decode(inner['data'])

tmp = src.with_suffix('.full.png')
tmp.write_bytes(data)

from PIL import Image
img = Image.open(tmp)
if img.width > max_w:
    h = round(img.height * max_w / img.width)
    img = img.resize((max_w, h), Image.LANCZOS)
img.convert('RGB').save(out, 'PNG', optimize=True)
tmp.unlink(missing_ok=True)
print(f'{out} ({img.width}x{img.height})')
