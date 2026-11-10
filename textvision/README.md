# TextVision

Visual information codec for text-only AI models (TEXTVISION/1.0).

## Pipeline

RASTER IMAGE -> VISUAL ANALYSIS -> VECTORIZATION -> STRUCTURAL OPTIMIZATION
-> TEXTUAL VISUAL REPRESENTATION (TVF) -> TEXT-ONLY LLM

## TVF format (TVF/1)

```
TVF/1
IMAGE <width>x<height> <colorspace>      e.g. IMAGE 1920x1080 sRGB
BACKGROUND #RRGGBB
MODE <overview|standard|detailed>
RECT <id> <x>,<y> <w>x<h> #RRGGBB
TEXT <id> <x>,<y> <w>x<h> "<content>"
REL <id> <x>,<y> <w>x<h> <ref-id>         relative containment
```

Coordinates are original raster pixels. Colors are 6-digit hex sRGB.

## Modules (lib/)

- `png.js`      - pure-Node PNG/BMP decode (no native deps)
- `analyze.js`  - visual decomposition: regions, edges, text detection
- `tvf.js`      - vectorize, detectText, encodeTVF, decodeTVF, toSVG,
                  MODES, reconstructTVF, metricsTVF, diff, inspectTVF,
                  transforms, capabilities
- `incremental.js` - frame differencing and region index (incremental updates)
- `color.js`    - DeltaE, contrast ratio, gradient stops
- `canvas.js`   - raster<->viewBox<->display coordinate transforms
- `format.js`   - TVF text formatting / token accounting
- `fallback.js` - supportsNativeVision, shouldUseTextVision, toTextVisionBlock

## CLI

```
node cli.js encode|bench <png> [mode]
node cli.js inspect <png> x0 y0 x1 y1
node cli.js tvf|svg <png> [mode]
```

Modes: overview (compact, <200 tokens), standard, detailed.

## Tests & benchmark

```
node test.js     # 21 tests, all modules
node bench.js    # synthetic fixtures + shot.png, PSNR/SSIM/DeltaE
```

## Integration

`fallback.js` decides automatically: when the selected model cannot accept
native image input (`supportsNativeVision` false) and an image is present,
`shouldUseTextVision` returns true and `toTextVisionBlock` wraps the TVF
representation for the text-only model.
