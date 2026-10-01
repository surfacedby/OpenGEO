import {readFileSync,writeFileSync,readdirSync,lstatSync,mkdirSync,mkdtempSync,existsSync,rmSync} from 'node:fs';
import {resolve,relative,join,extname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {runScanner} from './scanner-runtime.mjs';
import {targetedFindings} from './audit-matchers.mjs';
import {dispositionFor} from './audit-dispositions.mjs';
import {fileHash} from './audit-file-hash.mjs';
const root=resolve('.');const sourceOnly=process.argv.includes('--source');const args=process.argv.slice(2);const artifacts=[];for(let i=0;i<args.length;i++)if(args[i]==='--artifact')artifacts.push(resolve(args[++i]));
const receiptDir=resolve(process.env.OPENGEO_AUDIT_OUTPUT??join(tmpdir(),'opengeo-audit-'+randomUUID()));
if(relative(root,receiptDir)===''||!relative(root,receiptDir).startsWith('..'))throw new Error('Audit receipts must be outside the public repository.');
mkdirSync(receiptDir,{recursive:true});const privateDir=mkdtempSync(join(tmpdir(),'opengeo-scanners-'));
const findings=[];const coverage=[];const hashes=[];
const roots=new Map([['working-tree',root],['git-history',root]]);
let values=[];
if(process.env.OPENGEO_CONFIDENTIAL_VALUES_FILE){const file=resolve(process.env.OPENGEO_CONFIDENTIAL_VALUES_FILE);if(!relative(root,file).startsWith('..'))throw new Error('Confidential matching values must stay outside the public repository.');values=JSON.parse(readFileSync(file,'utf8'));if(!Array.isArray(values)||values.some(v=>typeof v!=='string'))throw new Error('Confidential matcher must be an array of strings.');}
function inventory(directory,source=false){const scope=source?'working-tree':'artifact:'+basename(directory);if(roots.has(scope)&&roots.get(scope)!==directory)throw new Error('Artifact scopes must have distinct directory names.');roots.set(scope,directory);let files=0;function walk(path){for(const entry of readdirSync(path)){const file=join(path,entry),r=relative(directory,file).replaceAll('\\','/'),stat=lstatSync(file);if(stat.isSymbolicLink()){findings.push({scope,path:r,rule:'symlink-needs-review'});continue;}if(stat.isDirectory()){if(source&&['node_modules','.git'].includes(r)){coverage.push({scope:r,method:r==='.git'?'all-ref-history-scan':'distribution-dependency-scan-required'});continue;}walk(file);continue;}files++;if(source&&(/(^|\/)(?:\.env(?!\.example$)[^/]*|credentials\.sealed|runtime\.lock|local-session|encryption-secret)$/.test(r)||/\.(?:sqlite(?:-wal|-shm)?|dump|pem|key)$/.test(r)))findings.push({scope,path:r,rule:'private-file'});
 if(!source)hashes.push({scope,path:r,sha256:fileHash(file)});if(stat.size>100_000_000){findings.push({scope,path:r,rule:'large-file-needs-review'});continue;}const bytes=readFileSync(file);const text=bytes.toString('utf8');for(const rule of targetedFindings(bytes,values))findings.push({scope,path:r,rule});if(extname(file)==='.svg'&&/<(?:script|foreignObject)\b|(?:href|src)\s*=\s*["'](?:https?:|data:)|<!ENTITY/i.test(text))findings.push({scope,path:r,rule:'active-svg'});
 if(!source&&/\.(?:asar|zip|exe|dmg|tar|gz|tgz)$/i.test(r))findings.push({scope,path:r,rule:'archive-must-be-unpacked-and-inventoried'});
 }}walk(directory);coverage.push({scope:source?'working-tree':directory,files,method:'hidden-file-inventory-and-targeted-matching'});}
function scan(directory,history=false){const label=history?'git-history':directory;const scope=history?'git-history':directory===root?'working-tree':'artifact:'+basename(directory);const report=join(privateDir,'gitleaks-'+randomUUID()+'.json');try{
 for(const scanner of ['gitleaks','trufflehog']){const result=runScanner(scanner,directory,report,history);for(const row of result.findings)findings.push({scope,...row});coverage.push({scope:label,scanner,findings:result.findings.length,...result.provenance});}
 }catch(error){findings.push({scope,path:label,rule:'scanner-incomplete',code:error.code??error.name,status:error.status});}}
let commit=null,clean=false;try{commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();clean=!execFileSync('git',['status','--porcelain','--untracked-files=all'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()}catch{}
inventory(root,true);scan(root);if(commit)scan(root,true);else findings.push({path:'.git',rule:'reviewed-commit-required'});
if(existsSync(join(root,'.git/lfs/objects'))){inventory(join(root,'.git/lfs/objects'));scan(join(root,'.git/lfs/objects'));}
if(!sourceOnly&&!artifacts.length)findings.push({path:'distribution',rule:'unpacked-artifacts-required'});
for(const artifact of artifacts){inventory(artifact);scan(artifact)}
let dispositions=[];
if(process.env.OPENGEO_DISPOSITIONS_FILE){const file=resolve(process.env.OPENGEO_DISPOSITIONS_FILE);if(!relative(root,file).startsWith('..'))throw new Error('Private review dispositions must stay outside the public repository.');dispositions=JSON.parse(readFileSync(file,'utf8'));if(!Array.isArray(dispositions))throw new Error('Review dispositions must be an array.');}
const disposed=[];const unresolved=findings.filter(f=>{const review=dispositionFor(f,roots,dispositions);if(review){disposed.push(review);return false}return true;});
if(!sourceOnly&&!clean)unresolved.push({path:'.git',rule:'clean-reviewed-tree-required'});
const receipt={version:1,time:new Date().toISOString(),commit,clean,sourceOnly,publicationApproved:false,status:unresolved.length?'blocked':'automated-checks-passed',coverage,artifactHashes:hashes,findings:unresolved,dispositions:disposed};
const receiptFile=join(receiptDir,'release-receipt.json');writeFileSync(receiptFile,JSON.stringify(receipt,null,2));rmSync(privateDir,{recursive:true,force:true});
console.log(JSON.stringify({status:receipt.status,findings:unresolved.length,dispositions:disposed.length,receipt:receiptFile,publicationApproved:false}));process.exitCode=unresolved.length?1:0;
