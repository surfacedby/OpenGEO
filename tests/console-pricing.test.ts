import test from 'node:test';
import assert from 'node:assert/strict';
import { creditsUsd, creditsWithinBudget, quotedCreditUsd } from '../server/console-pricing.js';
import { askFit } from '../server/ask-scope.js';

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

test('spending approvals never round up across a decimal credit boundary', () => {
  for (const [limit, credits] of [
    [0.29999999999999993, 299999],
    [0.09999999999999999, 99999],
    [9.999999999999997e-7, 0],
    [1e-7, 0],
    [Number.MIN_VALUE, 0],
    [0.29, 290000],
    [1e-6, 1],
  ]) {
    assert.equal(creditsWithinBudget(limit, 0.000001), credits, String(limit));
  }
  assert.equal(creditsWithinBudget(0.29999999999999993, 0.1), 2);
});

test('Ask reserves rounded-up costs against rounded-down approval without tolerance', () => {
  assert.equal(askFit(0.29999999999999993, [0.3]).overLimit, true);
  assert.equal(askFit(0.3, [0.30000000000000004]).overLimit, true);
  assert.equal(askFit(9.999999999999997e-7, [null]).overLimit, true);
  assert.equal(askFit(Number.MIN_VALUE, [null]).overLimit, true);
  assert.deepEqual(askFit(0.000002, [1e-7, 1e-7]).limitsUsd, [0.000001, 0.000001]);
  assert.deepEqual(askFit(0.29, [0.29]).limitsUsd, [0.29]);
  assert.equal(askFit(Number.MAX_VALUE, [0.1]).overLimit, true);
  assert.equal(askFit(1, [Number.MAX_VALUE]).overLimit, true);
});
