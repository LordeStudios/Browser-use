'use strict';
// Automatic model fallback: capability detection activates TextVision.
// A text-only LLM cannot accept native image inputs; TextVision converts
// raster -> TVF text so the model can still understand the visual.

// Detect whether a model can accept native image inputs.
// modelCaps: { vision: boolean } or a list of accepted content types.
function supportsNativeVision(modelCaps) {
  if (!modelCaps) return false;
  if (Array.isArray(modelCaps)) return modelCaps.includes('image') || modelCaps.includes('image_url');
  return !!modelCaps.vision;
}

// Decide whether TextVision should be used for a given model + input.
// Returns { useTextVision, reason }.
function shouldUseTextVision(modelCaps, input) {
  if (supportsNativeVision(modelCaps)) {
    return { useTextVision: false, reason: 'model accepts native image input' };
  }
  if (input && input.type === 'image') {
    return { useTextVision: true, reason: 'text-only model + image input' };
  }
  return { useTextVision: false, reason: 'no image input' };
}

// Wrap an image input into a TVF text block for a text-only model.
function toTextVisionBlock(tvfText, meta) {
  const m = meta || {};
  return {
    type: 'text',
    text: 'TEXTVISION/1\n' + tvfText,
    meta: { textvision: true, width: m.width, height: m.height, mode: m.mode }
  };
}

module.exports = { supportsNativeVision, shouldUseTextVision, toTextVisionBlock };
