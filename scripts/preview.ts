import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {chromium} from 'playwright';
import {start} from '../server/main.js';
import {projectInput,jobInput} from '../server/contracts.js';

// A fresh installation and a public reserved example domain keep capture assets free of customer data.
const directory=mkdtempSync(join(tmpdir(),'opengeo-preview-'));
writeFileSync(join(directory,'secret'),randomBytes(48));
process.env.OPENGEO_SECRET_FILE=join(directory,'secret');
const runtime=await start({directory,port:0});
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 await runtime.runner.stop();runtime.scheduler.stop();
 const project=runtime.store.createProject(projectInput.parse({domain:'example.com',brand:'Example Domain'}));
 const job=runtime.store.enqueue(jobInput.parse({projectId:project.id,kind:'audit'}),'preview-audit');
 await runtime.runner.tick();
 if(runtime.store.job(job.id).status!=='completed')throw new Error('The public example audit did not complete; do not replace it with fabricated results.');
 const context=await browser.newContext({viewport:{width:1440,height:1180},deviceScaleFactor:2});
 const page=await context.newPage();const address=runtime.app.server.address() as any;
 await page.goto('http://127.0.0.1:'+address.port);
 await page.getByRole('heading',{name:'Overview',exact:true}).waitFor();
 await page.getByText('1 page has been examined').waitFor();
 await page.evaluate(()=>document.fonts.ready);
 await page.locator('.shell').screenshot({path:'assets/dashboard-preview.png'});
 await page.getByRole('button',{name:'Site Audit',exact:true}).click();
 await page.getByRole('link',{name:'Example Domain',exact:true}).waitFor();
 await page.getByRole('button',{name:'Settings',exact:true}).click();
 await page.getByRole('heading',{name:'Your connections',exact:true}).waitFor();
 await page.locator('.main-column').screenshot({path:'assets/connections-preview.png'});
 await page.getByRole('tab',{name:'Schedules',exact:true}).click();
 await page.getByRole('button',{name:'Add schedule',exact:true}).click();
 await page.getByRole('button',{name:'Save schedule',exact:true}).waitFor();
 console.log(JSON.stringify({auditPages:runtime.store.pages(project.id,job.id).length,findings:runtime.store.findings(project.id).length,ui:'overview-audit-settings-schedule-verified',screenshot:'assets/dashboard-preview.png'}));
}finally{await browser.close();await runtime.app.close();rmSync(directory,{recursive:true,force:true});}
