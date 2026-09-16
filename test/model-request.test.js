import test from 'node:test';
import assert from 'node:assert/strict';
import { applyReasoning, resolveReasoningEffort, DEFAULT_REASONING_EFFORT } from '../src/model-request.js';

test('an empty value falls back to the high default', () => {
  assert.equal(resolveReasoningEffort(undefined), 'high');
  assert.equal(resolveReasoningEffort(''), 'high');
  assert.equal(DEFAULT_REASONING_EFFORT, 'high');
});

test('documented effort aliases map onto the API levels', () => {
  assert.equal(resolveReasoningEffort('low'), 'low');
  assert.equal(resolveReasoningEffort('high'), 'high');
  assert.equal(resolveReasoningEffort('max'), 'max');
  // The API maps these itself; we normalise before sending.
  assert.equal(resolveReasoningEffort('minimal'), 'low');
  assert.equal(resolveReasoningEffort('medium'), 'high');
  assert.equal(resolveReasoningEffort('xhigh'), 'high');
  assert.equal(resolveReasoningEffort('ultra'), 'max');
});

test('effort values are case and whitespace insensitive', () => {
  assert.equal(resolveReasoningEffort('  HIGH  '), 'high');
});

test('explicit off values disable thinking', () => {
  for (const value of ['off', 'none', 'disabled', 'false', '0']) {
    assert.equal(resolveReasoningEffort(value), null, value);
  }
  assert.deepEqual(applyReasoning({ model: 'deepseek-flash' }, 'off'),
    { model: 'deepseek-flash', thinking: { type: 'disabled' } });
});

test('an unknown value keeps the fallback instead of silently disabling thinking', () => {
  assert.equal(resolveReasoningEffort('whatever'), 'high');
  assert.equal(resolveReasoningEffort('whatever', 'low'), 'low');
});

test('thinking is enabled with the resolved effort and other fields survive', () => {
  const body = applyReasoning({ model: 'deepseek-flash', max_tokens: 32000 }, 'high');
  assert.deepEqual(body, {
    model: 'deepseek-flash',
    max_tokens: 32000,
    reasoning_effort: 'high',
    thinking: { type: 'enabled' },
  });
});

test('the caller body is not mutated', () => {
  const original = { model: 'deepseek-flash' };
  applyReasoning(original, 'max');
  assert.deepEqual(original, { model: 'deepseek-flash' });
});
