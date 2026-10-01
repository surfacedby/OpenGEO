const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
let server;

// A foreground entrypoint gives remote Docker hosts a durable exit status and
// receipt, without depending on an interactive exec stream.
(async () => {
  server = spawn(process.execPath, ['/app/dist-server/main.js'], { cwd: '/app', stdio: 'inherit' });
  for (let attempt = 0; attempt < 30; attempt++) {
    try { const response = await fetch('http://127.0.0.1:4318/api/session'); if (response.ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const session = await fetch('http://127.0.0.1:4318/api/session').then(response => response.json());
  assert.equal(session.product, 'OpenGEO');
  const headers = { Authorization: 'Bearer ' + fs.readFileSync('/data/local-session', 'utf8') };
  const api = async (path) => { const response = await fetch('http://127.0.0.1:4318/api' + path, { headers }); assert.ok(response.ok, path); return response.json(); };
  if (fs.existsSync('/tmp/outcome.json')) {
    const previous = JSON.parse(fs.readFileSync('/tmp/outcome.json', 'utf8'));
    const projects = await api('/projects');
    assert.equal(projects.length, 1); assert.equal(projects[0].id, previous.projectId);
    assert.equal((await api('/projects/' + previous.projectId + '/workspace')).jobs[0].status, 'completed');
    assert.equal((await api('/onboarding')).completed, true);
    fs.writeFileSync('/tmp/restart.json', JSON.stringify({ persisted: true }));
    return;
  }
  const { chromium } = require('/app/node_modules/playwright');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:4318');
    await page.getByRole('heading', { name: 'Power your AI visibility workspace', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Continue', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: 'Use local audits only', exact: true }).click();
    await page.getByRole('textbox', { name: 'Website', exact: true }).fill('example.com');
    await page.getByRole('textbox', { name: 'Brand name', exact: true }).fill('Example Domain');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Open workspace & audit', exact: true }).click();
    await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
    const projects = await api('/projects'); assert.equal(projects.length, 1);
    let jobs;
    for (let attempt = 0; attempt < 60; attempt++) {
      jobs = (await api('/projects/' + projects[0].id + '/workspace')).jobs;
      if (['completed', 'failed'].includes(jobs[0]?.status)) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.equal(jobs.length, 1); assert.equal(jobs[0].kind, 'audit');
    assert.equal(jobs[0].status, 'completed', jobs[0].error ?? jobs[0].progress);
    assert.equal(jobs[0].spentUsd, 0);
    const workspace = await api('/projects/' + projects[0].id + '/workspace');
    assert.ok(workspace.pages.length > 0, 'Actual page evidence is required');
    const backup = await api('/backup'); assert.equal(backup.format, 'opengeo-backup'); assert.equal(backup.projects.length, 1);
    assert.equal(JSON.stringify(backup).includes(fs.readFileSync('/data/local-session', 'utf8')), false);
    await page.reload(); await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
    const rebound = await new Promise((resolve, reject) => {
      const req = require('node:http').request('http://127.0.0.1:4318/api/session', { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(rebound, 403);
    fs.writeFileSync('/tmp/outcome.json', JSON.stringify({ startup: true, browserSetup: true, localAudit: true, sqlite: true, backup: true, hostProtection: true, projectId: projects[0].id }));
  } finally { await browser.close(); }
})().catch(error => {
  fs.writeFileSync('/tmp/failure.json', JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}).finally(async () => {
  if (server && server.exitCode === null) {
    await new Promise(resolve => { server.once('exit', resolve); server.kill('SIGTERM'); });
  }
});
