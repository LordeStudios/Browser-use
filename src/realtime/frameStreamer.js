const DEFAULT_FRAME_OPTIONS = {
  format: 'jpeg',
  quality: 60,
  maxWidth: 1280,
  maxHeight: 720,
  everyNthFrame: 1
};

function encodeFrame(frame) {
  const metadata = Buffer.from(JSON.stringify({
    type: 'frame',
    sessionId: frame.sessionId,
    frameId: frame.frameId,
    timestamp: frame.timestamp,
    metadata: frame.metadata
  }));
  const image = Buffer.from(frame.data, 'base64');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(metadata.length);
  return Buffer.concat([header, metadata, image]);
}

export class FrameStreamer {
  constructor({ browser, sessionId, options = {}, onFrame, onError = () => {} } = {}) {
    if (!browser || typeof browser.ensure !== 'function') throw new Error('Frame streamer requires a browser');
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('Frame streamer requires a session id');
    if (typeof onFrame !== 'function') throw new Error('Frame streamer requires an onFrame handler');
    this.browser = browser;
    this.sessionId = sessionId;
    this.options = { ...DEFAULT_FRAME_OPTIONS, ...options };
    this.onFrame = onFrame;
    this.onError = onError;
    this.client = null;
    this.frameId = 0;
    this.active = false;
    this.handleFrame = this.handleFrame.bind(this);
  }

  async start() {
    if (this.active) return;
    this.client = await this.browser.ensure();
    this.client.Page.screencastFrame(this.handleFrame);
    await this.client.Page.startScreencast(this.options);
    this.active = true;
  }

  async stop() {
    if (!this.active) return;
    this.active = false;
    await this.client?.Page.stopScreencast().catch(() => {});
  }

  async restart() {
    await this.stop();
    await this.start();
  }

  async handleFrame(frame) {
    if (!this.active) return;
    try {
      const payload = encodeFrame({
        sessionId: this.sessionId,
        frameId: ++this.frameId,
        timestamp: Date.now(),
        metadata: frame.metadata,
        data: frame.data
      });
      await this.onFrame(payload, this.frameId);
    } catch (error) {
      this.onError(error);
    } finally {
      await this.client?.Page.screencastFrameAck({ sessionId: frame.sessionId }).catch((error) => this.onError(error));
    }
  }
}

export { DEFAULT_FRAME_OPTIONS, encodeFrame };
