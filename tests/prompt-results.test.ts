import test from 'node:test';
import assert from 'node:assert/strict';
import type { Observation } from '../server/contracts';
import { promptResults } from '../src/prompt-results.js';

test('prompt results preserve exact question identity, deduplicate answers and distinguish missing from zero mentions', () => {
  const answers = [
    { id: 'one', prompt: 'Which tool?', mentioned: false, cited: true },
    { id: 'two', prompt: 'Which tool?', mentioned: true, cited: false },
    { id: 'one', prompt: 'Which tool?', mentioned: false, cited: true },
    { id: 'three', prompt: 'Which tool for teams?', mentioned: false, cited: false },
  ] as Observation[];
  const results = promptResults(answers);
  assert.deepEqual(results.get('Which tool?'), { ids: ['one', 'two'], mentions: 1, citations: 1 });
  assert.deepEqual(results.get('Which tool for teams?'), { ids: ['three'], mentions: 0, citations: 0 });
  assert.equal(results.has('which tool?'), false);
  assert.equal(results.has('New question?'), false);
  assert.equal(promptResults([]).size, 0);
});
