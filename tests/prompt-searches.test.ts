import test from 'node:test';
import assert from 'node:assert/strict';
import type { Observation } from '../server/contracts.js';
import { reportedSearches } from '../server/prompt-searches.js';

test('reported searches link distinct answers without inferring queries from answer content', () => {
  const rows = reportedSearches([
    { id: 'a', prompt: 'Which tool?', searchQueries: [' Example  pricing ', 'example pricing'], answer: 'Unreported query' },
    { id: 'b', prompt: 'What does it cost?', searchQueries: ['EXAMPLE PRICING', 'Example plans'] },
    { id: 'c', prompt: 'Which service?', answer: 'I searched for something', citations: [{ url: 'https://example.com' }] },
  ] as Observation[]);
  assert.deepEqual(rows, [
    { query: 'Example pricing', prompts: ['Which tool?', 'What does it cost?'], observationIds: ['a', 'b'] },
    { query: 'Example plans', prompts: ['What does it cost?'], observationIds: ['b'] },
  ]);
});
