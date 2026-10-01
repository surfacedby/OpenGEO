import {runScanner} from './scanner-runtime.mjs';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
const directory=mkdtempSync(join(tmpdir(),'opengeo-canary-'));
const token=['gh','p_'].join('')+randomBytes(18).toString('hex');
const raw=JSON.stringify({token}),encoded=Buffer.from(raw).toString('base64');
const files=['source.js','encoded.txt','bundle.js','export.json'];
for(const [index,file]of files.entries())writeFileSync(join(directory,file),index===1?encoded:index===2?'export const settings="'+encoded+'";':raw);
const results={};
try{
 for(const scanner of ['gitleaks','trufflehog']){
   const result=runScanner(scanner,directory,join(directory,'report.json'));
   const coverage=files.filter(file=>result.findings.some(finding=>finding.path===file));
   if(coverage.length!==files.length)throw new Error(scanner+' missed canary files: '+files.filter(file=>!coverage.includes(file)).join(', '));
   results[scanner]={source:true,encoded:true,bundle:true,export:true,...result.provenance};
 }
 console.log(JSON.stringify(results));
}finally{rmSync(directory,{recursive:true,force:true});}
