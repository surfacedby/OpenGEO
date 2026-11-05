import test from 'node:test';
import assert from 'node:assert/strict';
import { multiplyUsd, remainingUsd, sumUsd, usdMicros, withinUsdBudget } from '../server/usd.js';

test('receipt totals and token pricing preserve decimal amounts and sub-micro-dollar costs', () => {
  assert.equal(sumUsd([0.1, 0.2]), 0.3);
  assert.equal(sumUsd([0.1, 0.1, 0.1]), 0.3);
  assert.equal(sumUsd(Array(100).fill(0.01)), 1);
  assert.equal(sumUsd([0.00000001, 0.00000009]), 0.0000001);
  assert.equal(sumUsd([]), 0);
  assert.equal(multiplyUsd(0.1, 3), 0.3);
  assert.equal(multiplyUsd(1e-8, 30), 3e-7);
  assert.equal(multiplyUsd(0.1, 0), 0);
});

test('budget comparison refuses any decimal overage without a tolerance', () => {
  assert.equal(withinUsdBudget(0.3, [0.1, 0.2]), true);
  assert.equal(withinUsdBudget(0.29999999999999993, [0.1, 0.2]), false);
  assert.equal(withinUsdBudget(0.3, [0.1, 0.20000000000000004]), false);
  assert.equal(withinUsdBudget(0, [Number.MIN_VALUE]), false);
  assert.equal(withinUsdBudget(0, []), true);
  assert.equal(withinUsdBudget(1, Array(100).fill(0.01)), true);
});

test('remaining approval rounds down once after exact subtraction', () => {
  assert.equal(remainingUsd(0.3, [0.1]), 0.2);
  assert.equal(remainingUsd(1, [0.1, 0.2]), 0.7);
  assert.equal(remainingUsd(0.3, [0.1, 0.2]), 0);
  assert.equal(remainingUsd(0.2, [0.3]), 0);
  assert.equal(remainingUsd(0.000001, [1e-8]), 0);
  assert.equal(remainingUsd(0.000002, [1e-7, 9e-7]), 0.000001);
  assert.equal(remainingUsd(0.29999999999999993, []), 0.299999);
});

test('invalid money and quantities fail instead of making a budget comparison pass', () => {
  for (const value of [NaN, Infinity, -Infinity, -1]) {
    assert.equal(usdMicros(value, 'floor'), null);
    assert.throws(() => sumUsd([value]));
    assert.throws(() => withinUsdBudget(value, []));
    assert.throws(() => withinUsdBudget(1, [value]));
    assert.throws(() => remainingUsd(1, [value]));
    assert.throws(() => multiplyUsd(value, 1));
  }
  for (const quantity of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => multiplyUsd(0.1, quantity));
  assert.throws(() => sumUsd([Number.MAX_VALUE, Number.MAX_VALUE]));
  assert.throws(() => remainingUsd(Number.MAX_VALUE, []));
});
