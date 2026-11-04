import test from 'node:test';
import assert from 'node:assert/strict';
import type { Job, DiscoveredWebsite } from '../server/contracts.js';
import { checkWebsiteClassifications, classifiedWebsite } from '../src/website-category.js';

test('website types use only completed review from the selected check, with exact host boundaries', () => {
  const original = { domain: 'example.com', category: 'organization' } as DiscoveredWebsite;
  const reviewed = { ...original, category: 'publisher' } as DiscoveredWebsite;
  const jobs = [
    { id: 'unrelated', kind: 'competitors', measurementJobId: 'other', status: 'completed', result: { references: [original] } },
    { id: 'pending', kind: 'competitors', measurementJobId: 'check', status: 'running', result: { references: [original] } },
    { id: 'review', kind: 'competitors', measurementJobId: 'check', status: 'completed', result: { references: [reviewed] } },
    { id: 'check', kind: 'measure', status: 'completed', result: { competitors: [original] } },
  ] as Job[];
  assert.deepEqual(checkWebsiteClassifications(jobs, 'check'), [reviewed]);
  assert.deepEqual(checkWebsiteClassifications(jobs.filter(job => job.id !== 'review'), 'check'), [original]);
  assert.deepEqual(checkWebsiteClassifications(jobs, 'missing'), []);
  assert.deepEqual(checkWebsiteClassifications(jobs), []);
  assert.equal(classifiedWebsite([reviewed], 'https://www.example.com/article'), reviewed);
  assert.equal(classifiedWebsite([reviewed], 'https://other.example.com/article'), undefined);
  assert.equal(classifiedWebsite([reviewed], 'https://example.com.attacker.test/'), undefined);
});
