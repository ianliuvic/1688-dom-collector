import test from 'node:test';
import assert from 'node:assert/strict';
import { isSplitSelectionId, splitSelectionId, SPLIT_SELECTION_ID_BASE } from '../src/db.js';

test('split selection ids occupy a separate numeric namespace', () => {
  assert.equal(isSplitSelectionId(42), false);
  assert.equal(isSplitSelectionId(null), false);
  assert.equal(isSplitSelectionId(SPLIT_SELECTION_ID_BASE), true);
  assert.equal(splitSelectionId(1), SPLIT_SELECTION_ID_BASE + 1);
  assert.equal(splitSelectionId(42), SPLIT_SELECTION_ID_BASE + 42);
  assert.equal(splitSelectionId(null), null);
});
