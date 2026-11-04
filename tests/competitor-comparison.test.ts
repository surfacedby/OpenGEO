import test from 'node:test';
import assert from 'node:assert/strict';
import type { Observation } from '../server/contracts';
import { competitorComparison } from '../src/competitor-comparison';

test('comparison denominators retain uncited answers and deduplicate citations and observation identities', () => {
  const answer = (id: string, prompt: string, urls: string[]): Observation => ({ id, prompt, projectId: 'test', jobId: 'check', provider: 'chatgpt', platform: 'chat_gpt', model: 'fixture', locale: 'en-US', observedAt: '2026-11-04T00:00:00Z', answer: 'Synthetic answer', citations: urls.map(url => ({ url })), mentioned: false, cited: false, surface: 'api', costUsd: 0 });
  const one = answer('one', 'Which workspace?', ['https://www.example.com/', 'https://docs.rival.example/start', 'https://rival.example/']);
  const two = answer('two', 'Which workspace?', ['https://rival.example/']);
  const three = answer('three', 'Which service?', ['https://notrival.example/', 'javascript:alert(1)', 'invalid']);
  const four = answer('four', 'Which service?', ['https://example.com/']);
  const result = competitorComparison([one, two, three, four, one], 'example.com', 'rival.example');
  assert.equal(result.total, 4);
  assert.equal(result.own, 2);
  assert.equal(result.other, 2);
  assert.equal(result.both, 1);
  assert.equal(result.otherOnly, 1);
  assert.equal(result.ownOnly, 1);
  assert.equal(result.neither, 1);
  assert.equal(result.prompts[0].total, 2);
  assert.equal(result.prompts[0].otherOnly, 1);
  assert.equal(result.platforms[0].total, 4);
});
