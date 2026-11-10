'use strict';

const { preflightOllama } = require('../desktop/agent/ollamaProvider.cjs');

const model = process.env.OLLAMA_MODEL || 'kimi-k2.7-code:cloud';
const baseUrl = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';

preflightOllama({ model, baseUrl })
  .then((result) => console.log(JSON.stringify({ ok: result.ok, model: result.model, action: result.structuredAction })))
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
