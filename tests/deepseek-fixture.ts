import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/storage.js';
import { Vault } from '../server/vault.js';
import { createApp } from '../server/app.js';
import { projectInput } from '../server/contracts.js';
import { deepseekPrices, isPeak } from '../server/deepseek.js';

// Synthetic fixtures only: example.com identities and an invented key. Response shapes follow DeepSeek's
// documented schemas: https://api-docs.deepseek.com/api/create-chat-completion (chat, tool calls, usage),
// https://api-docs.deepseek.com/guides/search (search), https://api-docs.deepseek.com/api/get-user-balance and
// https://api-docs.deepseek.com/api/list-models.
export const session = 'synthetic-deepseek-session';
export const headers = { host: '127.0.0.1:4318', authorization: 'Bearer ' + session };
export const key = 'synthetic-deepseek-fixture-key';
export const question = 'Which example tools publish free reports?';
export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
export const usage = { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, prompt_cache_hit_tokens: 200, prompt_cache_miss_tokens: 800 };
export const toolReply = (queries: string[]) => ({ id: 'chat-' + randomUUID(), object: 'chat.completion', model: 'deepseek-flash', usage,
  choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: '',
    tool_calls: queries.map((query, i) => ({ id: 'call_' + i, type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query }) } })) } }] });
export const answerReply = (content: string, finish = 'stop') => ({ id: 'chat-' + randomUUID(), object: 'chat.completion', model: 'deepseek-flash', usage,
  choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content } }] });
export const answer = 'Example Brand publishes free reports. See [Example reports](https://example.com/reports) and https://example.org/compare.';

export type Request = { host: string; path: string; method: string; auth?: string; body: any };
export type Script = { replies: any[]; requests: Request[]; balanceStatus?: number; chatStatus?: number; dropChat?: boolean };
export function fakeDeepSeek(script: Script) {
  return (async (url: string | URL, init?: RequestInit) => {
    const address = new URL(String(url)), method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) : null;
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    script.requests.push({ host: address.hostname, path: address.pathname, method, auth, body });
    assert.equal(address.hostname, 'api.deepseek.com', 'only DeepSeek may be called in these tests');
    if (address.pathname === '/user/balance') return script.balanceStatus === 401 ? json({ error: { message: 'Authentication Fails', type: 'authentication_error' } }, 401)
      : json({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '9.87', granted_balance: '0.00', topped_up_balance: '9.87' }] });
    if (address.pathname === '/models') return json({ object: 'list', data: ['deepseek-v4-pro', 'deepseek-future', 'deepseek-flash'].map(id => ({ id, object: 'model', owned_by: 'deepseek' })) });
    if (address.pathname === '/v1/tools/search') return json({ results: body.query.includes('nothing') ? [] : [
      { rerank_score: 2.5, title: 'Free example reports', url: 'https://example.com/reports', snippet: 'Example Brand shares free reports.', summary: 'Longer summary.', content: '', site_name: 'Example', site_icon: null, date: '2026-10-01T00:00:00Z', authority: 3 },
      { rerank_score: 1.9, title: 'Comparing example tools', url: 'https://example.org/compare', snippet: 'A comparison.', summary: '', content: '', site_name: null, site_icon: null, date: null, authority: -1 }] });
    if (address.pathname === '/chat/completions') {
      if (script.dropChat) throw new TypeError('fetch failed');
      if (script.chatStatus) return json({ error: { message: 'Insufficient Balance', type: 'unknown_error' } }, script.chatStatus);
      const reply = script.replies.shift();
      if (!reply) throw new Error('No scripted DeepSeek reply left');
      return json(reply);
    }
    throw new Error('Unexpected DeepSeek request ' + method + ' ' + address.pathname);
  }) as typeof fetch;
}

export async function fixture(script: Script, connected = true, prompts = ['Which example dashboards are free?']) {
  const dir = mkdtempSync(join(tmpdir(), 'opengeo-deepseek-'));
  const store = new Store(dir);
  const vault = new Vault(dir, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
  if (connected) vault.set('deepseek', { provider: 'deepseek', key });
  const original = globalThis.fetch;
  globalThis.fetch = fakeDeepSeek(script);
  const { app, runner } = await createApp(store, vault, session);
  const project = store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example Brand', prompts }));
  const ask = (payload: object) => app.inject({ method: 'POST', url: `/api/projects/${project.id}/asks`, headers: { ...headers, 'idempotency-key': 'ask-' + randomUUID() }, payload });
  const read = async (askId: string) => (await app.inject({ url: `/api/projects/${project.id}/asks/${askId}`, headers })).json();
  const chats = () => script.requests.filter(r => r.path === '/chat/completions');
  return { store, vault, app, runner, project, ask, read, chats,
    async close() { globalThis.fetch = original; await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
export const costOf = (calls: number, searches: number, at: Date) => {
  const r = isPeak(at) ? deepseekPrices.models['deepseek-flash'].peak : deepseekPrices.models['deepseek-flash'].offPeak;
  return calls * (200 * r.hit + 800 * r.miss + 50 * r.output) / 1e6 + searches * deepseekPrices.searchUsd;
};
