'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sanitizeLedgerValue } = require('./providerTurnLedger.cjs');

// Owned by one conversation. IDs are digests, never caller-supplied paths.
class AgentResultStore {
  constructor(directory, conversationId) {
    const owner = crypto.createHash('sha256').update(String(conversationId)).digest('hex');
    this.directory = path.join(directory, owner);
  }
  write(value) {
    const content = JSON.stringify(sanitizeLedgerValue(value));
    const id = crypto.createHash('sha256').update(content).digest('hex');
    fs.mkdirSync(this.directory, { recursive: true });
    const destination = path.join(this.directory, id + '.json');
    try { fs.writeFileSync(destination, content, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    return id;
  }
  read({ resultId, offset = 0, limit = 8000 }) {
    if (!/^[a-f0-9]{64}$/.test(String(resultId))) throw new Error('Invalid agent result ID.');
    const content = fs.readFileSync(path.join(this.directory, resultId + '.json'), 'utf8');
    const start = Math.max(0, Math.floor(Number(offset) || 0));
    const size = Math.min(16000, Math.max(1, Math.floor(Number(limit) || 8000)));
    return { resultId, offset: start, totalCharacters: content.length, content: content.slice(start, start + size), nextOffset: start + size < content.length ? start + size : null };
  }
}
module.exports = { AgentResultStore };
