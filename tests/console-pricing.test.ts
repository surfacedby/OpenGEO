import test from 'node:test';
import assert from 'node:assert/strict';
import { creditsUsd, creditsWithinBudget, quotedCreditUsd } from '../server/console-pricing.js';

test('approval and settlement use the quoted valuation rather than a fixed credit conversion', () => {
  const unit = quotedCreditUsd({ estimated_credits: 3, estimated_usd: '0.75' });
  assert.equal(creditsWithinBudget(0.99, unit), 3);
  assert.equal(creditsWithinBudget(1, unit), 4);
  assert.equal(creditsUsd(2, unit), 0.5);
  assert.equal(creditsWithinBudget(0.29, 0.01), 29);
  assert.equal(creditsWithinBudget(0.299999, 0.1), 2);
  assert.equal(creditsWithinBudget(0.3, 0.1), 3);
});

test('malformed, zero and inconsistent quotes cannot establish a spending rate', () => {
  for (const estimated_usd of ['NaN', '-1', '1e2', '0', '0.1000001', '0.100001']) {
    assert.throws(() => quotedCreditUsd({ estimated_credits: 3, estimated_usd }));
  }
  assert.throws(() => quotedCreditUsd({ estimated_credits: 0, estimated_usd: '1' }));
  assert.throws(() => creditsWithinBudget(1, 0));
  assert.throws(() => creditsUsd(Number.MAX_SAFE_INTEGER, 1));
});
