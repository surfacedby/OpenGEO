import test from 'node:test';
import assert from 'node:assert/strict';
import {targetedFindings} from '../scripts/audit-matchers.mjs';
import { dispositionFor } from '../scripts/audit-dispositions.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileHash } from '../scripts/audit-file-hash.mjs';
import { execFileSync } from 'node:child_process';
test('synthetic confidential values are detected in raw, encoded, bundle and export content',()=>{
 const secret=['synthetic','confidential','release-test'].join(':');
 for(const text of [secret,Buffer.from(secret).toString('base64'),Buffer.from(secret).toString('hex'),encodeURIComponent(secret),'const bundle='+JSON.stringify(secret),JSON.stringify({export:secret}),Buffer.from(secret,'utf16le'),Buffer.from(secret,'utf16le').swap16()])assert.ok(targetedFindings(text,[secret]).includes('confidential-value'));
 assert.deepEqual(targetedFindings('public configuration',[]),[]);
});

test('binary matching catches UTF-16 key markers and mixed binary data without lossy decoding', () => {
 const marker=['-----BEGIN ', 'PRIVATE KEY-----'].join('');
 for(const bytes of [Buffer.from(marker,'utf16le'),Buffer.from(marker,'utf16le').swap16()])assert.ok(targetedFindings(Buffer.concat([Buffer.from([255,0,17]),bytes]),[]).includes('private-key'));
});

test('historical false-positive review binds to the exact commit blob rather than the current source', () => {
 const root=mkdtempSync(join(tmpdir(),'opengeo-history-disposition-'));
 const git=(args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 try {
  git(['init']);git(['config','user.name','Synthetic fixture']);git(['config','user.email','fixture@example.invalid']);git(['config','core.autocrlf','false']);
  writeFileSync(join(root,'fixture.txt'),'An unreviewed earlier fixture');git(['add','fixture.txt']);git(['commit','-m','Earlier fixture']);const earlier=git(['rev-parse','HEAD']);
  const reviewed='Reviewed synthetic example';writeFileSync(join(root,'fixture.txt'),reviewed);git(['add','fixture.txt']);git(['commit','-m','Reviewed fixture']);const current=git(['rev-parse','HEAD']);
  const roots=new Map([['git-history',root]]),finding={scope:'git-history',path:'fixture.txt',rule:'test-finding',commit:current};
  const review={...finding,sha256:createHash('sha256').update(reviewed).digest('hex'),reason:'Manual review of the exact synthetic fixture in this commit.'};
  assert.ok(dispositionFor(finding,roots,[review]));
  assert.equal(dispositionFor({...finding,commit:earlier},roots,[review]),null);
  assert.equal(dispositionFor({...finding,commit:earlier},roots,[{...review,commit:earlier}]),null);
  assert.equal(dispositionFor({...finding,commit:'HEAD'},roots,[{...review,commit:'HEAD'}]),null);
  writeFileSync(join(root,'fixture.txt'),'Different current working-tree content');
  assert.ok(dispositionFor(finding,roots,[review]));
 } finally {rmSync(root,{recursive:true,force:true});}
});
test('artifact hashes include complete chunks, a partial final chunk and empty files', () => {
 const root=mkdtempSync(join(tmpdir(),'opengeo-artifact-hash-'));
 try {
  const file=join(root,'fixture.bin');
  for(const bytes of [Buffer.alloc(0),Buffer.concat([Buffer.alloc(1024*1024,17),Buffer.alloc(1024*1024,42),Buffer.from('final bytes')])]){
   writeFileSync(file,bytes);
   assert.equal(fileHash(file),createHash('sha256').update(bytes).digest('hex'));
  }
 } finally {rmSync(root,{recursive:true,force:true});}
});
test('release dispositions cannot substitute a source file for different packaged bytes or hide old history', () => {
 const root=mkdtempSync(join(tmpdir(),'opengeo-disposition-test-'));
 try {
  const source=join(root,'source'),artifact=join(root,'artifact');mkdirSync(source);mkdirSync(artifact);
  writeFileSync(join(source,'fixture.txt'),'Reviewed synthetic example');writeFileSync(join(artifact,'fixture.txt'),'Unreviewed packaged content');
  const roots=new Map([['working-tree',source],['artifact:desktop',artifact],['git-history',source]]);
  const disposition={path:'fixture.txt',rule:'test-finding',sha256:createHash('sha256').update('Reviewed synthetic example').digest('hex'),reason:'Manual review of this exact synthetic source fixture.'};
  assert.ok(dispositionFor({scope:'working-tree',path:'/repo/fixture.txt',rule:'test-finding'},roots,[disposition]));
  assert.equal(dispositionFor({scope:'artifact:desktop',path:'/repo/fixture.txt',rule:'test-finding'},roots,[disposition]),null);
  assert.equal(dispositionFor({scope:'git-history',path:'fixture.txt',rule:'test-finding'},roots,[disposition]),null);
  assert.equal(dispositionFor({scope:'working-tree',path:'../artifact/fixture.txt',rule:'test-finding'},roots,[disposition]),null);
  writeFileSync(join(source,'fixture.txt'),'Changed after review');
  assert.equal(dispositionFor({scope:'working-tree',path:'fixture.txt',rule:'test-finding'},roots,[disposition]),null);
 } finally {rmSync(root,{recursive:true,force:true});}
});
