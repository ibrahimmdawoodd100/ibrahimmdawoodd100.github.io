'use strict';
// Runs INSIDE "firebase emulators:exec --only auth,database,functions": seeds test data, serves the built site with
// the emulator config, then runs the Playwright suite (emulator mode = full logged-in flow).
const { spawnSync } = require('node:child_process'), path = require('node:path');
(async () => {
  const fixture = await require('./e2e-seed').seed();
  const server = await require('./e2e-serve').start({ root: process.env.E2E_SITE || path.join(__dirname, '../../site'), mode: 'emulator' });
  const result = spawnSync('npx', ['playwright', 'test', '-c', path.join(__dirname, 'e2e.config.js'), ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, E2E_MODE: 'emulator', E2E_BASE: 'http://localhost:4173', E2E_FIXTURE: JSON.stringify(fixture) } });
  server.close(); process.exit(result.status ?? 1);
})().catch(error => { console.error('E2E setup failed:', error.message); process.exit(1); });
