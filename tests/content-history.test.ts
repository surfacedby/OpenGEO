import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contentHistory } from '../src/content-history';

test('revision branches share one library entry without merging separately created drafts', () => {
  const original = { id: 'original', createdAt: '2026-01-01T12:00:00Z', topic: 'The same title' };
  const revised = { ...original, id: 'revised', createdAt: '2026-01-02T12:00:00Z', derivedFrom: 'original' };
  const branch = { ...original, id: 'branch', createdAt: '2026-01-03T12:00:00Z', derivedFrom: 'original' };
  const independent = { ...original, id: 'independent' };
  const drafts = [branch, revised, independent, original];
  assert.deepEqual(contentHistory(drafts).map(group => group.map(draft => draft.id)), [['branch', 'revised', 'original'], ['independent']]);
  assert.deepEqual(drafts.map(draft => draft.id), ['branch', 'revised', 'independent', 'original']);
});

test('missing ancestors and malformed circular links do not lose saved content', () => {
  const drafts = [
    { id: 'a', createdAt: '2026-01-02T12:00:00Z', derivedFrom: 'b' },
    { id: 'b', createdAt: '2026-01-01T12:00:00Z', derivedFrom: 'a' },
    { id: 'c', createdAt: '2026-01-03T12:00:00Z', derivedFrom: 'missing' },
  ];
  assert.deepEqual(contentHistory(drafts).map(group => group.map(draft => draft.id)), [['c'], ['a', 'b']]);
});
