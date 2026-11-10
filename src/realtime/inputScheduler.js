function isPointerMove(event) {
  return event?.type === 'input.pointer' && event.action === 'move';
}

export class InputScheduler {
  constructor({ dispatch, maxQueueSize = 128 } = {}) {
    if (typeof dispatch !== 'function') throw new Error('Input scheduler requires a dispatch function');
    if (!Number.isInteger(maxQueueSize) || maxQueueSize < 1) throw new Error('maxQueueSize must be a positive integer');
    this.dispatch = dispatch;
    this.maxQueueSize = maxQueueSize;
    this.queue = [];
    this.lastSequence = 0;
    this.draining = null;
  }

  enqueue(event) {
    if (!Number.isInteger(event?.sequence) || event.sequence <= this.lastSequence) {
      throw new Error('Input sequence must be strictly increasing');
    }
    this.lastSequence = event.sequence;
    this.coalesce(event);
    if (this.queue.length > this.maxQueueSize) {
      const removableIndex = this.queue.findIndex(isPointerMove);
      if (removableIndex === -1) throw new Error('Input queue is full');
      this.queue.splice(removableIndex, 1);
    }
  }

  coalesce(event) {
    if (!isPointerMove(event)) {
      this.queue.push(event);
      return;
    }
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      if (isPointerMove(this.queue[index])) {
        this.queue[index] = event;
        return;
      }
      if (this.queue[index]?.type === 'input.pointer' && this.queue[index]?.action !== 'move') break;
    }
    this.queue.push(event);
  }

  async drain() {
    if (this.draining) return this.draining;
    this.draining = (async () => {
      while (this.queue.length > 0) {
        const event = this.queue.shift();
        await this.dispatch(event);
      }
    })();
    try {
      await this.draining;
    } finally {
      this.draining = null;
    }
  }
}
