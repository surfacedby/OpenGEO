import test from 'node:test';
import assert from 'node:assert/strict';
import { consoleCapabilities } from '../server/console-capabilities.js';
import { engineCatalog, type AskDeps } from '../server/asks.js';

const capability = () => ({
  platforms: [{ key: 'chatgpt', name: 'ChatGPT', enabled: true }, { key: 'gemini', name: 'Gemini', enabled: false }],
  operations: ['measurement'], selected_question_platforms: ['chatgpt', 'gemini'],
  pricing: { credit_usd: 0.1, supplier: 'private-supplier', measurement: {
    estimates_free: true, estimate_validity_seconds: 900, credit_increment: 1,
    rounding: 'up_to_whole_credit_per_request', settlement: 'actual_usage_up_to_estimate',
    platforms: [{ platform: 'chatgpt', one_answer_credits: 2, one_answer_usd: '0.20', model: 'private-model' },
      { platform: 'gemini', one_answer_credits: 1, one_answer_usd: '0.10' }],
  } },
});

test('discovery strips private fields and hides prices for unavailable engines', () => {
  const result = consoleCapabilities(capability());
  assert.deepEqual(result.selected_question_platforms, ['chatgpt']);
  assert.deepEqual(result.pricing?.measurement?.platforms, [
    { platform: 'chatgpt', one_answer_credits: 2, one_answer_usd: '0.20' },
  ]);
  assert.ok(!JSON.stringify(result).includes('private-'));
  assert.equal(consoleCapabilities({ ...capability(), operations: [] }).pricing?.measurement, null);
});

test('invalid or inconsistent prices cannot be displayed as verified prices', () => {
  for (const amount of ['NaN', '-1', '0', '0.30', '0.100001']) {
    const value = capability();
    value.pricing.measurement.platforms[0].one_answer_usd = amount;
    assert.throws(() => consoleCapabilities(value));
  }
  const duplicate = capability();
  duplicate.pricing.measurement.platforms.push(duplicate.pricing.measurement.platforms[0]);
  assert.throws(() => consoleCapabilities(duplicate));
});

test('a server without a public price menu does not acquire invented prices', () => {
  const { pricing: _pricing, ...legacy } = capability();
  assert.equal(consoleCapabilities(legacy).pricing, undefined);
});

test('engine discovery reads advertised prices without requesting a quote or purchasing', async () => {
  const paths: string[] = [];
  // Only credential storage and the remote HTTP boundary are replaced here.
  // The actual capability parser and engine catalogue determine the public result.
  const deps = {
    vault: { status: () => ({ console: true }) },
    store: { set() {}, setting: (_key: string, fallback: unknown) => fallback },
    providers: { console: async (path: string) => { paths.push(path); return { data: capability() }; } },
  } as unknown as AskDeps;
  const catalog = await engineCatalog(deps);
  assert.deepEqual(paths, ['/capabilities']);
  assert.equal(catalog.engines.find(row => row.id === 'surfacedby-chatgpt')?.estimateUsd, 0.2);
  const unavailable = catalog.engines.find(row => row.id === 'surfacedby-gemini');
  assert.equal(unavailable?.available, false);
  assert.equal(unavailable?.estimateUsd, undefined);
});

for (const [key, name] of [['ai_mode', 'Google AI Mode'], ['future_engine', 'Future Engine']]) {
  test(`newly advertised engine ${key} needs no client availability list`, async () => {
    const value = capability();
    value.platforms = [{ key, name, enabled: true }];
    value.selected_question_platforms = [key];
    value.pricing.measurement.platforms = [{ platform: key, one_answer_credits: 1, one_answer_usd: '0.10' }];
    const paths: string[] = [];
    const deps = {
      vault: { status: () => ({ console: true }) },
      store: { set() {}, setting: (_key: string, fallback: unknown) => fallback },
      providers: { console: async (path: string) => { paths.push(path); return { data: value }; } },
    } as unknown as AskDeps;
    const catalog = await engineCatalog(deps);
    assert.deepEqual(paths, ['/capabilities']);
    const engine = catalog.engines.find(row => row.id === `surfacedby-${key}`);
    assert.equal(engine?.available, true);
    assert.equal(engine?.estimateUsd, 0.1);
    assert.equal(engine?.label, name);
  });
}
