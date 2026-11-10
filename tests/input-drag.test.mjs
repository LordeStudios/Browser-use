import assert from 'node:assert/strict';
import test from 'node:test';
import { drag, scroll } from '../src/browser/input.js';

function createDragContext({ throwMoveStep = -1 } = {}) {
  const dispatched = [];
  const evaluations = [];
  let moveStepCount = 0;
  const cdp = {
    Input: {
      dispatchMouseEvent: async (event) => {
        if (event.type === 'mouseMoved') {
          moveStepCount += 1;
          if (throwMoveStep >= 0 && moveStepCount === throwMoveStep) {
            throw new Error('simulated CDP failure');
          }
        }
        dispatched.push(event);
      }
    }
  };
  const browser = {
    lastPointer: undefined,
    async evaluate(expression) {
      evaluations.push(expression);
      return { visible: true };
    },
    async ensure() {
      return cdp;
    }
  };
  return { ctx: { browser }, dispatched, evaluations };
}

test('drag dispatches pressed, interpolated moves, released, and updates pointer memory', async () => {
  const { ctx, dispatched, evaluations } = createDragContext();

  const result = await drag(ctx, { fromX: 10, fromY: 20, toX: 30, toY: 40, steps: 3 });

  assert.equal(dispatched.length, 6);
  assert.deepEqual(dispatched[0], { type: 'mouseMoved', x: 10, y: 20 });
  assert.deepEqual(dispatched[1], { type: 'mousePressed', x: 10, y: 20, button: 'left', buttons: 1, clickCount: 1 });
  assert.equal(dispatched[2].type, 'mouseMoved');
  assert.equal(dispatched[3].type, 'mouseMoved');
  assert.equal(dispatched[4].type, 'mouseMoved');
  assert.deepEqual(dispatched[5], { type: 'mouseReleased', x: 30, y: 40, button: 'left', buttons: 0, clickCount: 1 });

  assert.equal(evaluations.length, 0, 'native input must not evaluate or inject code into the page');
  assert.deepEqual(result.cursor, { mode: 'cdp-native-input', x: 30, y: 40, pageMutation: false });
  assert.deepEqual(ctx.browser.lastPointer, { x: 30, y: 40 });
});

test('drag releases the left button even if the interpolation fails', async () => {
  // move() emits mouseMoved #1; the first interpolated mouseMoved is #2.
  const { ctx, dispatched } = createDragContext({ throwMoveStep: 2 });

  await assert.rejects(
    () => drag(ctx, { fromX: 0, fromY: 0, toX: 20, toY: 20, steps: 4 }),
    /simulated CDP failure/
  );

  const released = dispatched.filter((event) => event.type === 'mouseReleased');
  assert.equal(released.length, 1);
  assert.deepEqual(released[0], { type: 'mouseReleased', x: 20, y: 20, button: 'left', buttons: 0, clickCount: 1 });
});

test('scroll uses the last drag destination as the wheel origin', async () => {
  const { ctx, dispatched } = createDragContext();
  await drag(ctx, { fromX: 5, fromY: 5, toX: 100, toY: 200, steps: 2 });
  await scroll(ctx, { deltaX: 0, deltaY: 50 });

  const wheel = dispatched.find((event) => event.type === 'mouseWheel');
  assert.ok(wheel);
  assert.equal(wheel.x, 100);
  assert.equal(wheel.y, 200);
});
