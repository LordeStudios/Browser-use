'use strict';

// Record & Learn orchestrator.
//
// start() begins observing the user through EXISTING infrastructure (the
// native probe child, the browser view controller, terminal and agent-tool
// taps) and feeds one local event processor. Nothing waits on the model while
// recording runs. stop() performs the final reconstruction ON THE ACTIVE
// MODEL and emits a proposal; only the skills the user checks in the UI are
// written to the persistent store.

const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { createEventProcessor, domainOf, shortApp } = require('./processor.cjs');
const { complete, parseJsonObject, providerLabel } = require('./modelClient.cjs');

const RAW_RETENTION_MS = 48 * 60 * 60 * 1000;
const SCREENSHOT_MIN_INTERVAL_MS = 2_500;
const MAX_MID_SESSION_INFERENCES = 8;
const MAX_RECONSTRUCTION_CHUNKS = 3;
const RECONSTRUCTION_SYSTEM_PROMPT = [
  'You are the reconstruction engine of a desktop activity recorder. You receive a compact semantic timeline of what the user did (apps visited, pages opened, buttons clicked, terminal commands, agent tool usage). Keyboard content is never present by design.',
  'Reconstruct the user\'s INTENT: which concrete tasks they performed, which actions served each task, and which actions were casual or irrelevant.',
  'Propose reusable skills ONLY for repeatable, goal-directed work that a future agent could execute with browser and computer tools. A skill must be grounded in observed actions, not invented. Do not propose skills for casual browsing or one-off judgments.',
  'Be conservative: fewer, better skills. Return ONLY one JSON object with exactly this shape:',
  '{"tasks":[{"title":"...","intent":"...","apps":["..."],"relevantActions":["..."],"casualActions":["..."]}],"skills":[{"name":"...","when":"when the user asks to ...","steps":[{"action":"...","detail":"..."}],"trigger":{"phrases":["..."],"domains":["..."],"apps":["..."]},"grounding":"which observed actions prove this"}],"discarded":[{"title":"...","reason":"..."}]}'
].join(' ');

function chunkTimeline(episodes, maxChunks) {
  if (episodes.length <= maxChunks) return episodes.map(episode => [episode]);
  const perChunk = Math.ceil(episodes.length / maxChunks);
  const chunks = [];
  for (let index = 0; index < episodes.length; index += perChunk) chunks.push(episodes.slice(index, index + perChunk));
  return chunks;
}

function timelineText(episodes) {
  return episodes.map(episode => {
    const lines = episode.actions.map(action => `- ${new Date(action.at).toISOString().slice(11, 19)} ${action.text}`);
    const header = `Episode ${new Date(episode.startedAt).toISOString().slice(11, 19)} (${Math.round(episode.spanMs / 1000)}s; apps: ${episode.apps.join(', ') || 'n/a'}; domains: ${episode.domains.join(', ') || 'none'}; clicks: ${episode.clickCount}; typing: ~${episode.keystrokes} chars)`;
    return [header, ...lines].join('\n');
  }).join('\n\n');
}

function mergeReconstructions(chunkResults) {
  const tasks = [], skills = [], discarded = [];
  const seenSkills = new Set();
  for (const result of chunkResults.filter(Boolean)) {
    for (const task of Array.isArray(result.tasks) ? result.tasks : []) {
      if (task?.title) tasks.push({
        title: String(task.title).slice(0, 200),
        intent: String(task.intent || '').slice(0, 600),
        apps: (Array.isArray(task.apps) ? task.apps : []).map(app => String(app).slice(0, 60)).slice(0, 6),
        relevantActions: (Array.isArray(task.relevantActions) ? task.relevantActions : []).map(item => String(item).slice(0, 200)).slice(0, 12),
        casualActions: (Array.isArray(task.casualActions) ? task.casualActions : []).map(item => String(item).slice(0, 200)).slice(0, 12)
      });
    }
    for (const skill of Array.isArray(result.skills) ? result.skills : []) {
      const steps = (Array.isArray(skill?.steps) ? skill.steps : []).filter(step => step?.action);
      const name = String(skill?.name || '').slice(0, 120);
      const key = `${name.toLowerCase()}::${steps.length}`;
      if (!name || !steps.length || seenSkills.has(key)) continue;
      seenSkills.add(key);
      skills.push({
        name,
        when: String(skill.when || '').slice(0, 400),
        steps: steps.map(step => ({ action: String(step.action).slice(0, 200), detail: String(step.detail || '').slice(0, 400) })),
        trigger: {
          phrases: (Array.isArray(skill.trigger?.phrases) ? skill.trigger.phrases : []).map(item => String(item).toLowerCase().slice(0, 80)).filter(Boolean).slice(0, 12),
          domains: (Array.isArray(skill.trigger?.domains) ? skill.trigger.domains : []).map(item => String(item).toLowerCase().replace(/^www\./, '')).filter(Boolean).slice(0, 8),
          apps: (Array.isArray(skill.trigger?.apps) ? skill.trigger.apps : []).map(item => String(item).slice(0, 60)).filter(Boolean).slice(0, 8)
        },
        grounding: String(skill.grounding || '').slice(0, 500)
      });
    }
    for (const item of Array.isArray(result.discarded) ? result.discarded : []) {
      if (item?.title) discarded.push({ title: String(item.title).slice(0, 200), reason: String(item.reason || '').slice(0, 300) });
    }
  }
  return { tasks, skills, discarded };
}

class Recorder {
  constructor({ userDataDir, emit = () => {}, getProviderConfig = () => null, capture = null, tapRegistry = new Set() } = {}) {
    this.userDataDir = String(userDataDir);
    this.emit = emit;
    this.getProviderConfig = getProviderConfig;
    this.capture = capture; // existing DesktopCapture instance — reused, not duplicated
    this.tapRegistry = tapRegistry; // sources register their tap functions here
    this.session = null;
    this.pendingProposals = new Map();
  }

  get active() { return Boolean(this.session); }

  status() {
    if (!this.session) return { recording: false, proposals: [...this.pendingProposals.keys()] };
    return {
      recording: true,
      sessionId: this.session.id,
      startedAt: this.session.startedAt,
      events: this.session.rawCount,
      episode: this.session.processor.snapshot(),
      inferenceCalls: this.session.inferenceCalls,
      modelState: this.session.modelState,
      modelError: this.session.modelError,
      model: this.session.model
    };
  }

  proposal(proposalId) {
    return this.pendingProposals.get(String(proposalId)) || null;
  }

  start() {
    if (this.session) throw new Error('Recording is already active.');
    const id = `rec-${Date.now()}`;
    const directory = path.join(this.userDataDir, 'record-sessions', id);
    fs.mkdirSync(directory, { recursive: true });
    const rawPath = path.join(directory, 'raw-events.jsonl');
    const session = {
      id, directory, rawPath, rawStream: fs.createWriteStream(rawPath, { flags: 'a' }), rawCount: 0,
      startedAt: Date.now(), evidenceCount: 0, lastScreenshotAt: 0, inferenceCalls: 0, inferencesQueued: 0,
      summaries: [], lastObserved: { url: null, title: null }, taps: [],
      modelState: 'checking', modelError: '', model: ''
    };
    this.session = session;
    this.cleanupOldSessions();

    const processor = createEventProcessor({
      onSemantic: () => this.publishStatus(),
      onEpisodeClosed: closed => this.onEpisodeClosed(closed)
    });
    session.processor = processor;
    processor.begin(Date.now());

    // Native input probe: the ONLY new capture surface, isolated in a child.
    let probe = null;
    try {
      probe = fork(path.join(__dirname, 'nativeProbe.cjs'), [], { stdio: 'ignore', serialization: 'json' });
      probe.on('message', message => {
        for (const event of message?.record || []) this.ingest(event);
        if (message?.recordStopped) this.publishStatus();
      });
      probe.on('error', () => { /* recording continues from the other sources */ });
      probe.on('exit', () => { if (session.probe === probe) session.probe = null; });
      probe.send({ start: true });
    } catch { /* native capture unavailable; browser/terminal/tool taps still work */ }
    session.probe = probe;

    this.emit({ type: 'record.started', sessionId: id });
    this.publishStatus();
    void this.checkModel(session);
    return this.status();
  }

  // A recording starts immediately, then validates the active AI model in the
  // background. Failure is surfaced while the user can still switch models;
  // captured work is never discarded and no fallback model is substituted.
  async checkModel(targetSession = this.session) {
    const session = targetSession;
    if (!session || this.session !== session) return { ok: false, stale: true };
    const config = this.getProviderConfig();
    session.model = config?.model ? `${providerLabel(config)} · ${config.model}` : '';
    session.modelState = 'checking';
    session.modelError = '';
    this.publishStatus();
    if (!config?.model) {
      session.modelState = 'failed';
      session.modelError = 'No active AI model is selected.';
      this.emit({ type: 'record.model-error', error: session.modelError, status: this.status() });
      return { ok: false, error: session.modelError };
    }
    try {
      const text = await complete(config, {
        system: 'Reply only with the JSON object {"ready":true}.',
        user: 'Confirm that this model can interpret a Record & Learn session.',
        maxTokens: 64, timeoutMs: 30_000
      });
      const parsed = parseJsonObject(text);
      if (parsed?.ready !== true) throw new Error('The active model did not complete the Record & Learn readiness check.');
      if (this.session !== session) return { ok: false, stale: true };
      session.modelState = 'ready';
      session.modelError = '';
      this.emit({ type: 'record.model-ready', status: this.status() });
      this.publishStatus();
      return { ok: true, model: session.model };
    } catch (error) {
      if (this.session !== session) return { ok: false, stale: true };
      session.modelState = 'failed';
      session.modelError = String(error?.message || 'The active model could not interpret the readiness check.');
      this.emit({ type: 'record.model-error', error: session.modelError, status: this.status() });
      this.publishStatus();
      return { ok: false, error: session.modelError };
    }
  }

  // ── Tap points (called from main.cjs wiring) ──────────────────────────────

  ingest(event) {
    const session = this.session;
    if (!session) return;
    try {
      session.rawStream.write(`${JSON.stringify(event)}\n`);
      session.rawCount += 1;
    } catch { /* raw evidence is best-effort; the semantic stream is primary */ }
    if (event.type === 'click') this.enrichClick(event);
    session.processor.push(event);
    if (event.type === 'app_switch') this.captureEvidence('app_switch');
  }

  tapNavigation({ url, title }) {
    if (!this.session) return;
    this.session.lastObserved = { url, title };
    this.ingest({ type: 'navigation', url, title, at: Date.now() });
    this.captureEvidence('navigation');
  }

  tapTabSwitch({ url, title }) {
    if (!this.session) return;
    this.session.lastObserved = { url, title };
    this.ingest({ type: 'tab_switch', url, title, at: Date.now() });
  }

  tapTerminal(summary) {
    this.ingest({ type: 'terminal', summary, at: Date.now() });
  }

  tapToolCall({ tool, summary }) {
    this.ingest({ type: 'tool_call', tool, summary, at: Date.now() });
  }

  // Browser context for native clicks: the active tab's URL gives the domain.
  enrichClick(event) {
    const session = this.session;
    const url = session?.lastObserved?.url;
    if (url) {
      const domain = domainOf(url);
      if (domain) { event.domain = domain; event.title = session.lastObserved.title || undefined; }
    }
  }

  // Selective screenshots — reuse the existing DesktopCapture, throttled, as
  // LOCAL evidence only. Screenshots are never sent to the model.
  captureEvidence(reason, { force = false } = {}) {
    const session = this.session;
    if (!session || !this.capture) return;
    const now = Date.now();
    if (!force && now - session.lastScreenshotAt < SCREENSHOT_MIN_INTERVAL_MS) return;
    if (reason !== 'navigation' && reason !== 'stop' && reason !== 'app_switch' && !force) return;
    session.lastScreenshotAt = now;
    try {
      const image = this.capture.screenshot();
      const data = String(image?.data || '');
      if (!data || data.length > 20_000_000) return;
      session.evidenceCount += 1;
      const evidenceId = `ev-${session.evidenceCount}`;
      fs.writeFileSync(path.join(session.directory, `${evidenceId}.png`), Buffer.from(data, 'base64'));
      session.processor.push({ type: 'screenshot', evidenceId, reason, at: now });
    } catch { /* evidence is optional */ }
  }

  // ── Episode lifecycle ─────────────────────────────────────────────────────

  onEpisodeClosed(episode) {
    const session = this.session;
    if (!session) return;
    // Selective inference: an episode that is novel and substantial earns ONE
    // async intent guess on the active model. Repeats and noise never cost a
    // call. The user never waits — results only enrich the stop-time proposal.
    if (session.inferencesQueued >= 2 || session.inferenceCalls >= MAX_MID_SESSION_INFERENCES) return;
    if (episode.significant < 4 || episode.spanMs < 5_000 || session.processor.isRepeating(episode)) return;
    if (!this.getProviderConfig()) return;
    session.inferencesQueued += 1;
    session.inferenceCalls += 1;
    const summary = { episodeId: episode.id, intent: null, tasks: [] };
    session.summaries.push(summary);
    const input = timelineText([episode]);
    void (async () => {
      try {
        const text = await complete(this.getProviderConfig(), {
          system: 'You summarize a short recording episode from a desktop activity recorder. Return ONLY a JSON object: {"intent":"one sentence describing what the user is trying to accomplish","task":"two to five word task name"}.',
          user: input, maxTokens: 200, timeoutMs: 45_000
        });
        const parsed = parseJsonObject(text);
        summary.intent = String(parsed.intent || '').slice(0, 300);
        summary.tasks = String(parsed.task || '').slice(0, 120);
      } catch (error) {
        // A failed interpretation is actionable feedback, not a silent drop:
        // keep recording, but let the user change the active model early.
        if (this.session === session) {
          session.modelState = 'failed';
          session.modelError = String(error?.message || 'The active model could not interpret this observation.');
          this.emit({ type: 'record.model-error', error: session.modelError, status: this.status() });
        }
      }
      finally {
        if (this.session) this.session.inferencesQueued -= 1;
      }
    })();
  }

  publishStatus() {
    if (!this.session) return;
    this.emit({ type: 'record.status', status: this.status() });
  }

  recheckModel() {
    return this.checkModel(this.session);
  }

  // ── Stop → reconstruction → proposal ──────────────────────────────────────

  async stop() {
    const session = this.session;
    if (!session) throw new Error('No recording is active.');
    this.session = null;
    this.captureEvidence('stop', { force: true });
    session.processor.stop();
    try { session.probe?.send({ stop: true }); session.probe?.send({ die: true }); } catch {}
    await new Promise(resolve => { session.probe ? session.probe.once('exit', resolve) : resolve(); setTimeout(resolve, 1_500); });
    session.rawStream.end();
    this.emit({ type: 'record.stopped', sessionId: session.id });
    this.publishStatus();

    // The processor retained every closed episode of the session as compact
    // digests — that list IS the reconstruction input.
    const closedEpisodes = session.processor.closedEpisodes.slice();

    const providerConfig = this.getProviderConfig();
    const proposal = {
      sessionId: session.id,
      createdAt: Date.now(),
      model: providerLabel(providerConfig),
      events: session.rawCount,
      episodes: closedEpisodes.length,
      spanMs: (closedEpisodes.at(-1)?.endedAt || Date.now()) - (closedEpisodes[0]?.startedAt || session.startedAt),
      error: null
    };
    if (!closedEpisodes.length) {
      proposal.tasks = []; proposal.skills = []; proposal.discarded = [];
      proposal.error = 'Nothing significant was captured during the recording.';
      proposal.state = 'empty';
    } else if (!providerConfig?.model) {
      proposal.tasks = []; proposal.skills = []; proposal.discarded = [];
      proposal.error = 'No active model is configured, so the recording could not be reconstructed. Configure a model and record again — the semantic stream was shown live meanwhile.';
      proposal.state = 'no-model';
    } else {
      try {
        const merged = await this.reconstruct(providerConfig, closedEpisodes, session);
        Object.assign(proposal, merged, { state: 'ready' });
      } catch (error) {
        proposal.tasks = []; proposal.skills = []; proposal.discarded = [];
        proposal.error = String(error?.message || 'The reconstruction failed.');
        proposal.state = 'failed';
      }
    }
    const proposalId = `prop-${session.id}`;
    this.pendingProposals.set(proposalId, proposal);
    this.emit({ type: 'record.proposal', proposalId, proposal });
    return proposal;
  }

  async reconstruct(providerConfig, episodes, session) {
    const chunks = chunkTimeline(episodes, MAX_RECONSTRUCTION_CHUNKS);
    const results = [];
    for (const chunk of chunks) {
      const hints = session.summaries.filter(summary => chunk.some(episode => episode.id === summary.episodeId));
      const user = [
        `Recorded on ${new Date(session.startedAt).toISOString()} using ${providerLabel(providerConfig)} (the active model).`,
        hints.filter(item => item.intent).length ? `Live intent hints observed while recording: ${hints.map(item => item.intent).filter(Boolean).join(' | ')}` : '',
        'Semantic timeline:',
        timelineText(chunk),
        'Return ONLY the JSON object described.'
      ].filter(Boolean).join('\n\n');
      const text = await complete(providerConfig, { system: RECONSTRUCTION_SYSTEM_PROMPT, user, maxTokens: 3_072, timeoutMs: 150_000 });
      results.push(parseJsonObject(text));
    }
    return mergeReconstructions(results);
  }

  // The human gate: only checked drafts become persistent skills.
  resolveProposal(proposalId, { keep = [], tasksAcked = true } = {}) {
    const proposal = this.pendingProposals.get(String(proposalId));
    if (!proposal) throw new Error('That proposal no longer exists.');
    void tasksAcked;
    const saved = [];
    for (const item of Array.isArray(keep) ? keep : []) {
      const draft = item && typeof item === 'object' ? item : proposal.skills?.[Number(item)];
      if (!draft?.name || !Array.isArray(draft.steps) || !draft.steps.length) continue;
      saved.push(this.skillsStore.add(draft, { sessionId: proposal.sessionId, recordedAt: proposal.createdAt }));
    }
    this.pendingProposals.delete(String(proposalId));
    this.cleanupSession(proposal.sessionId);
    this.emit({ type: 'record.proposal.resolved', proposalId, saved: saved.map(skill => ({ id: skill.id, name: skill.name })) });
    return saved;
  }

  attachSkillsStore(skillsStore) {
    this.skillsStore = skillsStore;
  }

  cleanupSession(sessionId) {
    const directory = path.join(this.userDataDir, 'record-sessions', String(sessionId || ''));
    try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
  }

  cleanupOldSessions() {
    const root = path.join(this.userDataDir, 'record-sessions');
    try {
      for (const entry of fs.readdirSync(root)) {
        const directory = path.join(root, entry);
        try {
          const stat = fs.statSync(directory);
          if (Date.now() - stat.mtimeMs > RAW_RETENTION_MS) fs.rmSync(directory, { recursive: true, force: true });
        } catch { /* per-entry failures are non-fatal */ }
      }
    } catch { /* no sessions yet */ }
  }
}

module.exports = { Recorder, mergeReconstructions, chunkTimeline, timelineText };
