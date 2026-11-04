import test from 'node:test';
import assert from 'node:assert/strict';
import { currentFindings } from '../server/presentation.js';
import type { Finding, Job } from '../server/contracts.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/storage.js';
import { jobInput, projectInput } from '../server/contracts.js';
import { exportProject, reportMarkdown } from '../server/export.js';

test('rechecks replace unstarted advice while preserving accepted actions and historical evidence', () => {
  const job = (id: string, kind: Job['kind'], status: Job['status'] = 'completed'): Job => ({id, kind, status, projectId:'project', createdAt:'2026-10-01T00:00:00Z',updatedAt:'2026-10-01T00:00:00Z',step:0,progress:'',error:null,result:null,maxCostUsd:0,spentUsd:0,render:false,maxPages:100,platform:'chat_gpt',webSearch:true});
  const jobs=[job('pending','diagnose','paused'),job('new-analysis','diagnose'),job('new-check','recheck'),job('new-audit','audit'),job('old-analysis','diagnose'),job('old-check','measure'),job('old-audit','audit')];
  const finding = (id:string,jobId:string,status:Finding['status']='open'): Finding => ({id,jobId,status,projectId:'project',title:'Improve the page',description:'Review its supporting evidence.',priority:'medium',kind:'analysis',targetUrl:'https://example.com/',steps:['Review the page.'],evidenceIds:['source'],confidence:'inferred'});
  const findings=[finding('old','old-analysis'),finding('active','old-analysis','doing'),finding('done','old-check','done'),finding('new','new-analysis'),finding('check','new-check'),finding('audit','new-audit'),finding('old-audit','old-audit'),finding('old-check','old-check')];
  assert.deepEqual(currentFindings(findings,jobs).map(item=>item.id),['active','done','new','check','audit']);
  assert.equal(findings.length,8);
  assert.equal(findings[0].evidenceIds[0],'source');
});

test('an analysis from another measurement is not presented as fresh advice and absence signals are not recommendations', () => {
  const jobs = [
    { id: 'check-new', kind: 'measure', status: 'completed', createdAt: '2026-10-02T00:00:00Z' },
    { id: 'analysis-old', kind: 'diagnose', status: 'completed', createdAt: '2026-10-01T00:00:00Z', result: { measurementJobId: 'check-old' } },
  ] as Job[];
  const advice = { id: 'advice', kind: 'analysis', jobId: 'analysis-old', status: 'open' } as Finding;
  const signal = { id: 'signal', kind: 'visibility', jobId: 'check-new', status: 'open' } as Finding;
  assert.deepEqual(currentFindings([advice, signal], jobs), []);
  assert.deepEqual(currentFindings([{ ...advice, status: 'doing' }, signal], jobs).map(item => item.id), ['advice']);
  assert.equal(advice.status, 'open');
});

test('reports use the current plan while project exports preserve its history', () => {
  const directory = mkdtempSync(join(tmpdir(), 'opengeo-plan-report-')), store = new Store(directory);
  try {
    const project = store.createProject(projectInput.parse({domain:'example.com',brand:'Example'}));
    for (const title of ['Earlier suggestion', 'Current suggestion']) {
      const job = store.enqueue(jobInput.parse({projectId:project.id,kind:'diagnose',provider:'chatgpt'}), title);
      store.put('finding', project.id, job.id, {id:randomUUID(),projectId:project.id,jobId:job.id,title,description:'Review the page.',priority:'medium',kind:'analysis',targetUrl:'https://example.com/',steps:['Check its evidence.'],evidenceIds:[],confidence:'inferred',status:'open'});
      store.updateJob(job.id, {status:'completed'});
    }
    assert.match(reportMarkdown(store, project.id), /Current suggestion/);
    assert.doesNotMatch(reportMarkdown(store, project.id), /Earlier suggestion/);
    assert.equal(exportProject(store, project.id).findings.length, 2);
  } finally { store.close(); rmSync(directory, {recursive:true,force:true}); }
});

test('scan recommendations and separate analysis replace each other without discarding accepted work', () => {
  const measurementId = randomUUID(), separateId = randomUUID();
  const receipt = { findings: 1, measurementJobId: measurementId, pagesReviewed: 1 };
  const scan = { id: measurementId, kind: 'measure', status: 'completed', prepareRecommendations: true, result: { analysis: receipt } } as Job;
  const separate = { id: separateId, kind: 'diagnose', status: 'completed', result: receipt } as Job;
  const findings = [
    { id: 'scan-advice', jobId: scan.id, kind: 'analysis', status: 'open' },
    { id: 'accepted', jobId: scan.id, kind: 'analysis', status: 'doing' },
    { id: 'separate-advice', jobId: separate.id, kind: 'analysis', status: 'open' },
  ] as Finding[];
  assert.deepEqual(currentFindings(findings, [separate, scan]).map(item => item.id), ['accepted', 'separate-advice']);
  assert.deepEqual(currentFindings(findings, [scan, separate]).map(item => item.id), ['scan-advice', 'accepted']);
});

test('Topic checks and their pinned analyses replace advice only within the same measurement scope', () => {
  const scan = (id: string, topicId?: string) => ({ id, topicId, kind: 'measure', status: 'completed', createdAt: '2026-11-04T00:00:00Z' }) as Job;
  const analysis = (id: string, measurementJobId: string) => ({ id, kind: 'diagnose', status: 'completed', measurementJobId, result: { measurementJobId }, createdAt: '2026-11-04T00:01:00Z' }) as Job;
  const brand = scan('brand'), firstTopic = scan('topic-a', 'a'), secondTopic = scan('topic-b', 'b');
  const brandAdvice = analysis('brand-advice', brand.id), firstAdvice = analysis('a-advice', firstTopic.id), secondAdvice = analysis('b-advice', secondTopic.id);
  const advice = (job: Job, status = 'open') => ({ id: job.id, jobId: job.id, kind: 'analysis', status }) as Finding;
  const findings = [advice(brandAdvice), advice(firstAdvice), advice(secondAdvice), { ...advice(firstAdvice, 'doing'), id: 'accepted' }];
  const original = [secondAdvice, secondTopic, firstAdvice, firstTopic, brandAdvice, brand];
  assert.deepEqual(currentFindings(findings, original).map(row => row.id), ['brand-advice', 'a-advice', 'b-advice', 'accepted']);
  const next = scan('a-next', 'a');
  assert.deepEqual(currentFindings(findings, [next, ...original]).map(row => row.id), ['brand-advice', 'b-advice', 'accepted']);
  const replacement = analysis('a-replacement', next.id);
  assert.deepEqual(currentFindings([...findings, advice(replacement)], [replacement, next, ...original]).map(row => row.id), ['brand-advice', 'b-advice', 'accepted', 'a-replacement']);
  assert.deepEqual(currentFindings(findings, [scan('brand-next'), ...original]).map(row => row.id), ['a-advice', 'b-advice', 'accepted']);
});
