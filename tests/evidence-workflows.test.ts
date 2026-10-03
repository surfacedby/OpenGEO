import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/storage.js';
import { Vault } from '../server/vault.js';
import { Connections } from '../server/oauth.js';
import { Providers } from '../server/providers.js';
import { Runner } from '../server/workflows.js';
import { parsePage } from '../server/audit.js';
import { jobInput, projectInput } from '../server/contracts.js';
import { prompts } from '../server/prompts.js';
import { contentSources } from '../server/evidence-context.js';
import { exportProject } from '../server/export.js';
import { importProject, previewImport } from '../server/import.js';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'opengeo-evidence-')), store = new Store(directory);
  const vault = new Vault(directory, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
  vault.set('chatgpt', { active: 'fixture', profiles: [{ id: 'fixture', access_token: 'synthetic-access', expiresAt: Date.now() + 3600000, scopes: ['chatgpt.tokens.use.direct'] }] });
  const connections = new Connections(store, vault), runner = new Runner(store, new Providers(vault, connections));
  const project = store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example', prompts: ['How can our team organize customer questions?'] }));
  const audit = store.enqueue(jobInput.parse({ projectId: project.id, kind: 'audit' }), 'audit');
  const pages = Array.from({length:100}, (_, index) => parsePage('https://example.com/page/' + index, 200,
    '<title>Support workspace</title><h1>Organize customer questions</h1><p>' + 'A shared support workspace keeps customer questions organized. '.repeat(170) + '</p>'));
  for (const page of pages) store.put('page', project.id, audit.id, page);
  store.updateJob(audit.id, {status:'completed'});
  const measurement = store.enqueue(jobInput.parse({projectId:project.id,kind:'measure',provider:'chatgpt'}), 'measurement');
  store.put('observation', project.id, measurement.id, {id:randomUUID(),projectId:project.id,jobId:measurement.id,prompt:project.prompts[0],provider:'chatgpt',platform:'chat_gpt',model:'fixture',locale:'en-US',observedAt:new Date().toISOString(),answer:'A shared support workspace can help.',citations:[],surface:'api',mentioned:false,cited:false,costUsd:0});
  store.updateJob(measurement.id, {status:'completed'});
  return {store,project,pages,audit,measurement,runner,async close(){connections.close();await runner.stop();store.close();rmSync(directory,{recursive:true,force:true});}};
}
const json = (value:unknown) => new Response(JSON.stringify(value), {headers:{'Content-Type':'application/json'}});
const stream = (text:string) => new Response('data: ' + JSON.stringify({type:'response.completed',response:{status:'completed',output:[{content:[{type:'output_text',text}]}]}}) + '\n\n');

test('large audits are fully analyzed in durable batches across quota and later site changes', async () => {
  const f=fixture(), original=globalThis.fetch, reviewed=new Set<string>();
  let calls=0, quota=true;
  globalThis.fetch=(async (url,init) => {
    if(String(url).endsWith('/models')) return json({models:[{slug:'fixture',display_name:'Fixture',visibility:'list',context_window:32768}]});
    calls++;
    if(calls===2 && quota) return new Response('{}',{status:429});
    const request=JSON.parse(init!.body as string), input=JSON.parse(request.input[0].content);
    assert.ok(Buffer.byteLength(request.instructions + request.input[0].content,'utf8')+5096<=32768);
    if(request.instructions===prompts.consolidate) {
      assert.equal(input.candidates.length,100);
      return stream(JSON.stringify({groups:[{primaryIndex:0,indices:input.candidates.map((item:any)=>item.index)}]}));
    }
    for(const page of input.pages) {assert.ok(!reviewed.has(page.id),'Completed batches cannot replay');reviewed.add(page.id);}
    return stream(JSON.stringify({recommendations:input.pages.map((page:any)=>({title:'Clarify the supported workflow',description:'Confirm whether this page explains how teams organize their questions.',priority:'medium',targetPageId:page.id,evidenceIds:[page.id],steps:['Review the published page and add a supported explanation where needed.']})),uncertainties:[]}));
  }) as typeof fetch;
  try {
    const job=f.store.enqueue(jobInput.parse({projectId:f.project.id,kind:'diagnose',provider:'chatgpt'}),'analysis');
    assert.equal(f.store.enqueue(jobInput.parse({projectId:f.project.id,kind:'diagnose',provider:'chatgpt'}),'analysis').id,job.id);
    assert.throws(()=>f.store.enqueue(jobInput.parse({projectId:f.project.id,kind:'diagnose',provider:'chatgpt'}),'duplicate'));
    await f.runner.tick();assert.equal(f.store.job(job.id).error,'quota');
    f.store.updateJob(f.audit.id,{status:'failed'});f.store.updateJob(f.measurement.id,{status:'failed'});
    quota=false;f.runner.resume(job.id,false);await f.runner.tick();
    assert.equal(f.store.job(job.id).status,'completed');assert.equal(reviewed.size,100);
    assert.equal((f.store.job(job.id).result as any).measurementJobId,f.measurement.id);
    const findings=f.store.findings(f.project.id);
    assert.equal(findings.length,100);
    assert.equal(new Set(findings.map(item=>item.title)).size,1);
    assert.equal(new Set(findings.flatMap(item=>item.evidenceIds)).size,100);
    assert.equal(findings.reduce((total,item)=>total+item.steps.length,0),100);
    const count=f.store.findings(f.project.id).length;
    await f.runner.execute(f.store.job(job.id),f.project,new AbortController().signal);
    assert.equal(f.store.findings(f.project.id).length,count);
  } finally {globalThis.fetch=original;await f.close();}
});

test('content uses bounded relevant evidence and revisions preserve every original source', async () => {
  const f=fixture(), original=globalThis.fetch;
  let sourceIds:string[]=[], draft='';
  globalThis.fetch=(async (url,init) => {
    if(String(url).endsWith('/models')) return json({models:[{slug:'fixture',display_name:'Fixture',visibility:'list',context_window:200000}]});
    const request=JSON.parse(init!.body as string), input=JSON.parse(request.input[0].content);
    assert.ok(Buffer.byteLength(request.instructions+request.input[0].content,'utf8')+5096<=200000);
    if(request.instructions===prompts.research) {
      if(!sourceIds.length)sourceIds=input.sources.map((page:any)=>page.id);
      else assert.deepEqual(new Set(input.sources.map((page:any)=>page.id)),new Set(sourceIds));
      assert.ok(input.sources.length<100);
      draft='# Organize customer questions\n\nA shared workspace keeps questions organized. [Source: Support workspace]('+input.sources[0].url+')';
      return stream(JSON.stringify({facts:[{claim:'A shared workspace keeps questions organized.',evidenceIds:[input.sources[0].id]}],unknowns:[]}));
    }
    if(request.instructions===prompts.verify || request.instructions===prompts.verifyFinal)return stream(JSON.stringify({issues:[],requiresHumanReview:true}));
    return stream(request.instructions===prompts.brief ? '# Brief\n\nExplain the supported workflow.' : draft);
  }) as typeof fetch;
  try {
    const job=f.store.enqueue(jobInput.parse({projectId:f.project.id,kind:'content',provider:'chatgpt',topic:'Organize customer questions'}),'content');
    await f.runner.tick();assert.equal(f.store.job(job.id).status,'completed');
    const doc=f.store.artifacts<any>(f.project.id,'content')[0];
    assert.equal(doc.sourceCoverage.pagesAvailable,100);assert.equal(doc.sourceCoverage.pagesUsed,sourceIds.length);
    const revision=f.store.enqueue(jobInput.parse({projectId:f.project.id,kind:'revise',provider:'chatgpt',contentId:doc.id,revisionInstructions:'Make the opening clearer.'}),'revision');
    await f.runner.tick();assert.equal(f.store.job(revision.id).status,'completed');
    assert.deepEqual(new Set(f.store.artifacts<any>(f.project.id,'content')[0].sourceEvidence.map((source:any)=>source.id)),new Set(sourceIds));
    const tiny=contentSources(f.pages,'customer questions',10000);
    assert.ok(Buffer.byteLength(JSON.stringify(tiny.sources),'utf8')<=10000);
  } finally {globalThis.fetch=original;await f.close();}
});

test('opportunity drafts freeze their purpose, retain the target page across interruption, and preserve import and revision lineage', async () => {
  const f = fixture(), original = globalThis.fetch;
  const target = f.pages.at(-1)!;
  const finding = { id: randomUUID(), projectId: f.project.id, jobId: f.measurement.id,
    title: 'Explain the supported workflow', description: 'Review the page and clarify how teams can organize their questions.',
    priority: 'medium' as const, targetUrl: target.url, evidenceIds: [target.id],
    steps: ['Add supported steps to the existing page.'], confidence: 'inferred' as const, status: 'open' as const, kind: 'analysis' };
  f.store.put('finding', f.project.id, f.measurement.id, finding);
  let quota = true, researchCalls = 0;
  const inputs: any[] = [];
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith('/models')) return json({ models: [{ slug: 'fixture', display_name: 'Fixture', visibility: 'list', context_window: 200000 }] });
    const request = JSON.parse(init!.body as string), input = JSON.parse(request.input[0].content);
    inputs.push(input);
    assert.equal(input.task.mode, 'page_update');
    assert.equal(input.task.findingId, finding.id);
    assert.equal(input.task.recommendation.title, finding.title);
    if (request.instructions === prompts.research) {
      researchCalls++;
      assert.equal(input.sources[0].id, target.id);
      return stream(JSON.stringify({ facts: [{ claim: 'A shared workspace keeps questions organized.', evidenceIds: [target.id] }], unknowns: [] }));
    }
    if (request.instructions === prompts.brief && quota) return new Response('{}', { status: 429 });
    if (request.instructions === prompts.verify || request.instructions === prompts.verifyFinal)
      return stream(JSON.stringify({ issues: [], requiresHumanReview: true }));
    return stream(request.instructions === prompts.brief ? '# Page brief\n\nClarify the existing workflow.' : '# Organize customer questions\n\nA shared workspace keeps questions organized. [Source: Support workspace](' + target.url + ')');
  }) as typeof fetch;
  try {
    const input = jobInput.parse({ projectId: f.project.id, kind: 'content', provider: 'chatgpt', findingId: finding.id });
    const job = f.store.enqueue(input, 'page-copy');
    assert.equal(f.store.enqueue(input, 'page-copy').id, job.id);
    assert.throws(() => f.store.enqueue(input, 'duplicate-page-copy'), /already saved/);
    await f.runner.tick();
    assert.equal(f.store.job(job.id).error, 'quota');
    f.store.db.prepare('UPDATE artifacts SET body=? WHERE id=?').run(JSON.stringify({ ...finding, title: 'A later recommendation', steps: ['A different task.'] }), finding.id);
    f.store.updateJob(f.audit.id, { status: 'failed' });
    quota = false; f.runner.resume(job.id, false); await f.runner.tick();
    assert.equal(f.store.job(job.id).status, 'completed');
    assert.equal(researchCalls, 1);
    const doc = f.store.artifacts<any>(f.project.id, 'content')[0];
    assert.equal(doc.task.mode, 'page_update');
    assert.equal(doc.task.targetUrl, target.url);
    assert.equal(doc.task.recommendation.title, finding.title);
    assert.equal(f.store.findings(f.project.id)[0].status, 'open');
    const revision = f.store.enqueue(jobInput.parse({ projectId: f.project.id, kind: 'revise', provider: 'chatgpt', contentId: doc.id, revisionInstructions: 'Make the steps clearer.' }), 'page-copy-revision');
    await f.runner.tick();
    assert.equal(f.store.job(revision.id).status, 'completed');
    assert.deepEqual(f.store.artifacts<any>(f.project.id, 'content')[0].task, doc.task);
    const exported = exportProject(f.store, f.project.id);
    const changedPage = structuredClone(exported);
    changedPage.content[0].task!.targetUrl = 'https://example.com/unrelated';
    assert.throws(() => previewImport(f.store, changedPage), /different target page/);
    const changedOwner = structuredClone(exported);
    changedOwner.content[0].task!.findingId = randomUUID();
    assert.throws(() => previewImport(f.store, changedOwner), /unknown opportunity/);
    const unsafePage = structuredClone(exported);
    unsafePage.content[0].task!.targetUrl = 'http://127.0.0.1/private';
    assert.throws(() => previewImport(f.store, unsafePage));
    const incompleteTask = structuredClone(exported);
    delete incompleteTask.content[0].task!.recommendation;
    assert.throws(() => previewImport(f.store, incompleteTask));
    const restored = importProject(f.store, exported);
    const imported = f.store.artifacts<any>(restored.project.id, 'content');
    assert.equal(imported.length, 2);
    assert.ok(imported.every(item => item.task.findingId === f.store.findings(restored.project.id)[0].id));
    assert.notEqual(imported[0].task.findingId, finding.id);
    assert.equal(imported[0].task.targetUrl, target.url);
    assert.equal(inputs.filter(input => input.previousDraft).length, 1);
  } finally { globalThis.fetch = original; await f.close(); }
});

test('a draft cannot use another project opportunity or silently discard its required page', async () => {
  const f = fixture();
  try {
    const finding = { id: randomUUID(), projectId: f.project.id, jobId: f.measurement.id, title: 'Improve this page', description: 'Clarify its workflow.', priority: 'medium' as const, targetUrl: f.pages[0].url, evidenceIds: [f.pages[0].id], steps: ['Clarify the workflow.'], confidence: 'inferred' as const, status: 'open' as const, kind: 'analysis' };
    f.store.put('finding', f.project.id, f.measurement.id, finding);
    const other = f.store.createProject(projectInput.parse({ domain: 'other.example', brand: 'Other' }));
    assert.throws(() => f.store.enqueue(jobInput.parse({ projectId: other.id, kind: 'content', provider: 'chatgpt', findingId: finding.id }), 'foreign-opportunity'), /this website/);
    assert.throws(() => f.store.enqueue(jobInput.parse({ projectId: f.project.id, kind: 'content', provider: 'console', findingId: finding.id }), 'unsupported-page-copy'), /Choose ChatGPT or OpenRouter/);
    assert.throws(() => jobInput.parse({ projectId: f.project.id, kind: 'content', contentMode: 'page_update' }));
    assert.throws(() => contentSources(f.pages, 'customer questions', 100, [finding.targetUrl]), /more room/);
    assert.throws(() => contentSources(f.pages, 'customer questions', 65000, ['https://example.com/missing']), /not available/);
    f.store.db.prepare('UPDATE artifacts SET body=? WHERE id=?').run(JSON.stringify({ ...finding, targetUrl: '' }), finding.id);
    const count = f.store.jobs(f.project.id).length;
    assert.throws(() => f.store.enqueue(jobInput.parse({ projectId: f.project.id, kind: 'content', provider: 'chatgpt', findingId: finding.id }), 'invalid-target'));
    assert.equal(f.store.jobs(f.project.id).length, count);
    assert.equal(f.store.jobs(other.id).length, 0);
  } finally { await f.close(); }
});
