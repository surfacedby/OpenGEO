import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePage } from '../server/audit.js';
import { contentSources } from '../server/evidence-context.js';

const page = (path: string, title: string, text: string) => parsePage('https://example.com/' + path, 200,
  '<title>' + title + '</title><h1>' + title + '</h1><p>' + text + '</p>');

test('content retrieval favors distinguishing subject words over shared headings and navigation', () => {
  const common = 'How can I find the right equipment for my workshop and make it work? ';
  const unrelated = Array.from({ length: 25 }, (_, index) => page('accessory-' + index,
    'Equipment for my workshop and how it can work', common + 'Accessories and storage. '.repeat(100)));
  const relevant = page('vibration', 'Diagnose lathe vibration', common + 'Measure lathe vibration and tool alignment. '.repeat(100));
  const selected = contentSources([...unrelated, relevant], 'How can I find what is causing my lathe vibration?', 7000);
  assert.equal(selected.sources[0].id, relevant.id);
  assert.ok(Buffer.byteLength(JSON.stringify(selected.sources)) <= 7000);
});

test('content retrieval uses whole words and applies corpus weighting outside English', () => {
  const common = 'Comment choisir et utiliser un outil pour une équipe ? ';
  const unrelated = Array.from({ length: 12 }, (_, index) => page('outil-' + index,
    'Comment choisir un outil pour une équipe', common + 'Gestion des équipes et organisation. '.repeat(100)));
  const relevant = page('sauvegarde', 'Restaurer une sauvegarde chiffrée', common + 'Une sauvegarde chiffrée protège les données. '.repeat(100));
  const selected = contentSources([...unrelated, relevant], 'Comment restaurer ma sauvegarde chiffrée ?', 6000);
  assert.equal(selected.sources[0].id, relevant.id);
  const substring = page('tracking', 'Improve tracking', 'Tracking configuration. '.repeat(100));
  const exact = page('rack', 'Rack maintenance', 'Check the rack. '.repeat(100));
  assert.equal(contentSources([substring, exact], 'rack', 3000).sources[0].id, exact.id);
});

test('several questions each bring their best page before a broad page that mentions every subject', () => {
  const broad = page('partners', 'Partner program', 'Deposits, analytics, product builders and checkout security for partners. '.repeat(60));
  const deposits = page('deposits', 'Deposits and payment plans', 'Take a deposit and charge the remaining balance to the saved card later. '.repeat(60));
  const analytics = page('analytics', 'Purchase analytics', 'Send paid orders to analytics from the server when the thank-you page is skipped. '.repeat(60));
  const questions = ['How do I take a deposit and charge the balance later?', 'How can analytics count paid orders when the thank-you page is skipped?'];
  const selected = contentSources([broad, deposits, analytics], questions, 2600, [], 1000);
  assert.deepEqual(selected.sources.map(source => source.id), [deposits.id, analytics.id], 'each question keeps its own page; excerpts are sized at what is sent');
  assert.ok(selected.sources.every(source => source.text.length <= 1000));
});
