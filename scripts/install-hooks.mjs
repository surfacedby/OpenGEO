import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
// Source archives and Docker contexts have no Git checkout to configure.
if (existsSync('.git')) execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'inherit' });
