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
