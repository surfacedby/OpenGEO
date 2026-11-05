import test from 'node:test';
import assert from 'node:assert/strict';
import { usd } from '../src/format.js';

test('money displays preserve billable precision without making small charges look free', () => {
  assert.equal(usd(0), '$0.00');
  assert.equal(usd(0.1 + 0.2), '$0.30');
  assert.equal(usd(0.001), '$0.001');
  assert.equal(usd(0.000001), '$0.000001');
  assert.equal(usd(0.299999), '$0.299999');
  assert.equal(usd(1e-7), '<$0.000001');
  assert.equal(usd(-1e-7), '>-$0.000001');
  assert.equal(usd(1200), '$1200.00');
  assert.equal(usd(0.1234, 3), '$0.123');
});
