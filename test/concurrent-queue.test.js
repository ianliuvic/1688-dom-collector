import assert from 'node:assert/strict';
import test from 'node:test';
import { createConcurrentQueue } from '../src/concurrent-queue.js';

test('runs no more than the configured number of tasks concurrently', async () => {
  let active = 0;
  let maximumActive = 0;
  let completed = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const queue = createConcurrentQueue({ concurrency: 5 });

  for (let index = 0; index < 12; index += 1) {
    queue.enqueue(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await gate;
      active -= 1;
      completed += 1;
    });
  }

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(queue.stats(), { concurrency: 5, active: 5, pending: 7, paused: false });
  release();

  while (completed < 12) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maximumActive, 5);
  assert.deepEqual(queue.stats(), { concurrency: 5, active: 0, pending: 0, paused: false });
});

test('pause preserves pending tasks until resume', async () => {
  let completed = 0;
  const queue = createConcurrentQueue({ concurrency: 1 });
  queue.pause();
  queue.enqueue(async () => { completed += 1; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(queue.stats(), { concurrency: 1, active: 0, pending: 1, paused: true });
  queue.resume();
  while (completed < 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(queue.stats(), { concurrency: 1, active: 0, pending: 0, paused: false });
});

test('continues after a task rejects', async () => {
  const errors = [];
  let completed = false;
  const queue = createConcurrentQueue({
    concurrency: 1,
    onTaskError: (error) => errors.push(error.message),
  });

  queue.enqueue(async () => { throw new Error('expected failure'); });
  queue.enqueue(async () => { completed = true; });

  while (!completed) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, ['expected failure']);
});
