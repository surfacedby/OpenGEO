import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {Store} from '../server/storage.js';
import {Vault} from '../server/vault.js';
import {createApp} from '../server/app.js';
import {Runner} from '../server/workflows.js';
import {Scheduler} from '../server/scheduler.js';
import {jobInput,projectInput,ProviderError} from '../server/contracts.js';
import {presence,summarize} from '../server/analysis.js';
import {isPublicIp,publicUrl,isPublicEvidenceUrl} from '../server/network.js';
import {parseDfs} from '../server/providers.js';

test('public links retain HTTP meaning and reject local host aliases and tunneled private addresses', () => {
  for (const link of ['javascript:443', 'example.com/guide', 'http://localhost./', 'http://name.localhost/',
    'http://host.local./', 'https://[2002:7f00:1::]/', 'https://[2002:0a00:0001::]/',
    'http://[::ffff:7f00:1]/', 'https://192.0.2.1/', 'https://203.0.113.10/', 'https://[2001:db8::1]/']) {
    assert.equal(isPublicEvidenceUrl(link), false, link);
  }
  assert.equal(publicUrl('example.com/guide').href, 'https://example.com/guide');
  for (const link of ['https://example.com/guide#part', 'https://[2606:4700:4700::1111]/', 'https://[2002:0808:0808::1]/']) {
    assert.equal(isPublicEvidenceUrl(link), true, link);
  }
  for (const address of ['2002:7f00:1::1', '2002:a00::1', '::ffff:127.0.0.1', '::ffff:7f00:0001', '2001:0::1']) {
    assert.equal(isPublicIp(address), false, address);
  }
});

test('Perplexity citation numbers refer to the original pool before URL filtering or deduplication', () => {
  const annotations = [
    { url: 'javascript:bad' }, { url: 'https://brand.example/background', title: 'Background' },
    { url: 'https://reference.example', title: 'Reference', private: 'internal' },
    { url: 'https://reference.example/' }, { url: 'https://brand.example/background' },
  ];
  const response = (text: string) => ({ status_code: 20000, tasks: [{ status_code: 20000, result: [{
    model_name: 'fixture', web_search: true, fan_out_queries: [' one ', 'one', null],
    items: [null, { sections: [null, { type: 'text', text: { private: true } }, { type: 'text', text, annotations }] }],
  }] }] });
  const answer = parseDfs(response('A useful reference [3][3][90].'), 'perplexity');
  assert.equal(answer.text, 'A useful reference [3][3][90].');
  assert.deepEqual(answer.citations, [{ url: 'https://reference.example', title: 'Reference' }]);
  assert.deepEqual(answer.retrievedSources, [{ url: 'https://brand.example/background', title: 'Background' }]);
  assert.deepEqual(answer.searchQueries, ['one', 'one']);
  assert.equal(answer.webSearchConfirmed, true);
  assert.equal(presence({ brand: 'Brand Ltd', aliases: [], domain: 'brand.example' } as any,
    answer.text, answer.citations.map(source => source.url)).cited, false);
  for (const [platform, text] of [['perplexity', 'No indexed citation [90].'], ['claude', 'Reference [3].']]) {
    const unknown = parseDfs(response(text), platform);
    assert.equal(unknown.citations.length, 2);
    assert.equal(unknown.retrievedSources, undefined);
  }
});
import {exportProject} from '../server/export.js';
import {lockRuntime} from '../server/runtime-lock.js';
function fixture(){const dir=mkdtempSync(join(tmpdir(),'opengeo-test-'));const store=new Store(dir);return {dir,store,close(){store.close();rmSync(dir,{recursive:true,force:true})}}}
const input=projectInput.parse({domain:'example.com',brand:'Example',prompts:['What does Example publish?','Which examples are useful?']});
test('paid work survives restart without replay; idempotency rejects changed requests',()=>{const f=fixture();try{const p=f.store.createProject(input),job=jobInput.parse({projectId:p.id,kind:'measure',provider:'dataforseo',maxCostUsd:1});const j=f.store.enqueue(job,'test-request-1');assert.equal(f.store.enqueue(job,'test-request-1').id,j.id);assert.throws(()=>f.store.enqueue({...job,maxCostUsd:2},'test-request-1'));f.store.updateJob(j.id,{status:'running'});f.store.setStep(j.id,'measure:0','started');f.store.close();const reopened=new Store(f.dir);assert.equal(reopened.job(j.id).status,'paused');assert.equal(reopened.step(j.id,'measure:0')?.state,'started');reopened.close();}finally{rmSync(f.dir,{recursive:true,force:true})}});
test('quota pauses; resuming preserves billed observations and does not replay successful calls',async()=>{const f=fixture();try{const p=f.store.createProject(input);f.store.set('measurementRequestEstimateUsd',.1);let requests=0;const provider={models:async()=>[{id:'test-model',name:'Test',contextLength:10000,inputUsd:0,outputUsd:0}],measure:async()=>{requests++;if(requests===2)throw new ProviderError('quota','Limit reached');return {text:'Example provides examples.',citations:[],model:'test-model',costUsd:.1}}};const runner=new Runner(f.store,provider as any);const j=f.store.enqueue(jobInput.parse({projectId:p.id,kind:'measure',provider:'dataforseo',maxCostUsd:.2}),'test-quota-1');await runner.tick();assert.equal(f.store.job(j.id).status,'paused');assert.equal(f.store.observations(p.id,j.id).length,1);runner.resume(j.id,true);await runner.tick();assert.equal(requests,3);assert.equal(f.store.job(j.id).spentUsd,.2);assert.equal(f.store.job(j.id).status,'completed');assert.equal(f.store.observations(p.id,j.id).length,2);}finally{f.close()}});
test('backend refuses cross-origin and rebound-host requests; credentials never appear in status or exports',async()=>{const f=fixture();const key=join(f.dir,'secret');writeFileSync(key,Buffer.alloc(32,7));const previous=process.env.OPENGEO_SECRET_FILE;process.env.OPENGEO_SECRET_FILE=key;try{const vault=new Vault(f.dir);const sensitive=['synthetic','provider','credential'].join('-');vault.set('openrouter',{key:sensitive});assert.ok(!readFileSync(join(f.dir,'credentials.sealed')).includes(Buffer.from(sensitive)));const {app}=await createApp(f.store,vault,'local-test-session');const headers={host:'127.0.0.1:4318',authorization:'Bearer local-test-session'};assert.equal((await app.inject({url:'/api/projects',headers:{...headers,origin:'https://evil.example'}})).statusCode,403);assert.equal((await app.inject({url:'/api/session',headers:{host:'evil.example'}})).statusCode,403);const crossSite={host:headers.host,'sec-fetch-site':'cross-site'};assert.notEqual((await app.inject({url:'/',headers:{...crossSite,'sec-fetch-mode':'navigate','sec-fetch-dest':'document'}})).statusCode,403,'opening the app from a link loads the page');assert.equal((await app.inject({url:'/',headers:{...crossSite,'sec-fetch-mode':'navigate','sec-fetch-dest':'iframe'}})).statusCode,403,'framing stays refused');assert.equal((await app.inject({url:'/api/session',headers:{...crossSite,'sec-fetch-mode':'navigate','sec-fetch-dest':'document'}})).statusCode,403,'API navigation stays refused');assert.equal((await app.inject({method:'POST',url:'/',headers:{...crossSite,'sec-fetch-mode':'navigate','sec-fetch-dest':'document'}})).statusCode,403,'cross-site form posts stay refused');assert.equal((await app.inject({url:'/api/projects',headers:{host:headers.host}})).statusCode,401);const p=f.store.createProject(input);assert.ok(!JSON.stringify(exportProject(f.store,p.id)).includes(sensitive));assert.ok(!(await app.inject({url:'/api/providers',headers})).body.includes(sensitive));await app.close();}finally{process.env.OPENGEO_SECRET_FILE=previous;f.close()}});
test('draft edits are durable, scoped, and retain prior revisions',()=>{const f=fixture();try{const p=f.store.createProject(input),other=f.store.createProject({...input,domain:'other.example'}),j=f.store.enqueue(jobInput.parse({projectId:p.id,kind:'content'}),'content-test');f.store.put('content',p.id,j.id,{id:'draft-1',markdown:'Original'});assert.throws(()=>f.store.editContent(other.id,'draft-1','Wrong'));f.store.editContent(p.id,'draft-1','Revised');assert.equal((f.store.artifacts<any>(p.id,'content')[0]).markdown,'Revised');assert.equal((f.store.artifacts<any>(p.id,'revision')[0]).markdown,'Original');}finally{f.close()}});
test('missed schedules coalesce and outstanding work reserves the monthly ceiling',()=>{const f=fixture();try{const p=f.store.createProject(input),s=new Scheduler(f.store);const config=s.add({job:{projectId:p.id,kind:'measure',provider:'dataforseo',maxCostUsd:1},frequency:'daily',hour:9,timezone:'UTC',monthlyBudgetUsd:1});f.store.set('schedules',[{...config,nextAt:'2020-01-01T09:00:00.000Z'}]);const now=new Date('2026-09-15T10:00:00Z');s.tick(now);s.tick(now);assert.equal(f.store.jobs().length,1);s.tick(new Date('2026-09-16T10:00:00Z'));assert.equal(f.store.jobs().length,1);assert.match(s.list()[0].lastError??'',/budget/);}finally{f.close()}});
test('crawling blocks private networks and embedded credentials, including redirects',()=>{for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','172.16.4.1','192.168.1.1','100.64.0.1','::1','fc00::1','fe80::1'])assert.equal(isPublicIp(ip),false,ip);assert.equal(isPublicIp('1.1.1.1'),true);assert.throws(()=>publicUrl('http://127.0.0.1'));assert.throws(()=>publicUrl('https://user:pass@example.com'));assert.throws(()=>publicUrl('file:///tmp/test'));});
test('a paused scheduled run blocks new work across month boundaries until resolved',()=>{const f=fixture();try{const p=f.store.createProject(input),s=new Scheduler(f.store);const config=s.add({job:{projectId:p.id,kind:'measure',provider:'chatgpt',maxCostUsd:0},frequency:'daily',hour:9,timezone:'UTC',monthlyBudgetUsd:0});f.store.set('schedules',[{...config,nextAt:'2026-09-30T09:00:00.000Z'}]);s.tick(new Date('2026-09-30T10:00:00Z'));const first=f.store.jobs()[0];f.store.updateJob(first.id,{status:'paused'});s.tick(new Date('2026-10-01T10:00:00Z'));assert.equal(f.store.jobs().length,1);assert.match(s.list()[0].lastError??'',/previous scheduled run/);f.store.updateJob(first.id,{status:'cancelled'});s.tick(new Date('2026-10-02T10:00:00Z'));assert.equal(f.store.jobs().length,2);}finally{f.close()}});
test('provider annotations are citations; missing checks never depress measured rates',()=>{const result=parseDfs({status_code:20000,tasks:[{status_code:20000,cost:.05,result:[{model_name:'test-model',items:[{sections:[{type:'text',text:'Useful examples.',annotations:[{url:'https://example.com',title:'Example',tracking_id:'private'}]}]}]}]}]});assert.deepEqual(result.citations,[{url:'https://example.com',title:'Example'}]);assert.equal(result.costUsd,.05);const project={...input,id:'p',createdAt:''};assert.equal(presence(project,'Not Examplesque.',[]).mentioned,false);const metric=summarize([{...presence(project,'Example',['https://example.com']),citations:result.citations}as any],2);assert.equal(metric.mentionRate,100);assert.equal(metric.missing,1);});
test('a second runtime cannot interrupt the owner of a database',()=>{const dir=mkdtempSync(join(tmpdir(),'opengeo-lock-'));try{const release=lockRuntime(dir);assert.throws(()=>lockRuntime(dir),/already running/);release();lockRuntime(dir)();}finally{rmSync(dir,{recursive:true,force:true})}});

test('a crashed runtime releases ownership without relying on a saved process number',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'opengeo-lock-crash-'));
  const module=pathToFileURL(join(process.cwd(),'server/runtime-lock.ts')).href;
  const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',
    `import {lockRuntime} from ${JSON.stringify(module)}; const release=lockRuntime(process.env.OPENGEO_LOCK_TEST_DIR); process.on('SIGTERM',()=>{release();process.exit();}); process.stdout.write('ready'); setInterval(()=>{},1000);`],
    {env:{...process.env,OPENGEO_LOCK_TEST_DIR:dir},stdio:['ignore','pipe','pipe']});
  let release:(()=>void)|undefined, timer:ReturnType<typeof setTimeout>|undefined;
  try {
    const ready=once(child.stdout,'data'), exited=once(child,'close');
    const signal=await Promise.race([ready.then(([data])=>String(data)),exited.then(()=>{throw new Error('Lock owner exited before readiness');}),
      new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Lock owner did not become ready')),10000);})]);
    clearTimeout(timer); assert.equal(signal,'ready');
    assert.throws(()=>{const unexpected=lockRuntime(dir);unexpected();},/already running/);
    child.kill('SIGKILL'); await exited;
    writeFileSync(join(dir,'runtime.lock'),String(process.pid));
    release=lockRuntime(dir);
    assert.throws(()=>lockRuntime(dir),/already running/);
    release(); release=lockRuntime(dir);
  } finally {
    clearTimeout(timer);
    if(child.exitCode===null && child.signalCode===null){const exited=once(child,'close');child.kill('SIGKILL');await exited;}
    release?.(); rmSync(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});
  }
});

test('resuming a scheduled job respects its monthly allowance and preserves other settled charges',()=>{
  const f=fixture();
  try {
    const project=f.store.createProject(input), scheduler=new Scheduler(f.store);
    const config=scheduler.add({job:{projectId:project.id,kind:'measure',provider:'openrouter',maxCostUsd:1},frequency:'daily',hour:9,timezone:'UTC',monthlyBudgetUsd:3});
    f.store.set('schedules',[{...config,nextAt:'2026-09-15T09:00:00.000Z'}]);
    scheduler.tick(new Date('2026-09-15T10:00:00Z'));
    const first=f.store.jobs()[0]; f.store.updateJob(first.id,{status:'completed',spentUsd:.5});
    scheduler.tick(new Date('2026-09-16T10:00:00Z'));
    const paused=f.store.jobs()[0]; f.store.updateJob(paused.id,{status:'paused',error:'budget',spentUsd:.8});
    const runner=new Runner(f.store,{} as any);
    assert.equal(runner.resumePreview(paused.id).scheduledBudgetCeilingUsd,2.5);
    assert.throws(()=>runner.resume(paused.id,false,2.6),(error:any)=>error.code==='budget');
    assert.equal(f.store.job(paused.id).status,'paused'); assert.equal(f.store.job(paused.id).maxCostUsd,1);
    scheduler.remove(config.id);
    assert.equal(scheduler.list().length,0);
    assert.equal(runner.resumePreview(paused.id).scheduledBudgetCeilingUsd,2.5);
    assert.throws(()=>runner.resume(paused.id,false,2.6),(error:any)=>error.code==='budget');
    runner.resume(paused.id,false,2.5);
    assert.equal(f.store.job(paused.id).maxCostUsd,2.5); assert.equal(f.store.job(first.id).spentUsd,.5);
    scheduler.tick(new Date('2026-09-17T10:00:00Z'));
    assert.equal(f.store.jobs().length,2);
  } finally {f.close();}
});
