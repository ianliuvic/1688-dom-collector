import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyLinkFoxListingStatus } from '../src/source-status.js';

test('classifyLinkFoxListingStatus treats published offers as active', () => {
  const result = classifyLinkFoxListingStatus({ status: 'published', soldOut: null });
  assert.equal(result.state, 'active');
  assert.equal(result.status, 'published');
  assert.equal(result.soldOut, null);
});

test('classifyLinkFoxListingStatus treats member expired offers as delisted', () => {
  const result = classifyLinkFoxListingStatus({ status: 'Member Expired', soldOut: '1' });
  assert.equal(result.state, 'delisted');
  assert.equal(result.soldOut, '1');
});

test('classifyLinkFoxListingStatus never guesses from an unknown status', () => {
  const result = classifyLinkFoxListingStatus({ status: 'pending review' });
  assert.equal(result.state, 'unknown');
  assert.equal(result.status, 'pending review');
});
