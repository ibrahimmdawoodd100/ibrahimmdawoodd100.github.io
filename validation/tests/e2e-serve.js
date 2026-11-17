'use strict';
// Local static server for the BUILT site (site/ in the Pages bundle) used by the browser E2E tests.
// emulator mode: config.js is replaced by a test config that points at local Firebase emulators, and the page CSP
// gets the emulator ports in connect-src (and loses upgrade-insecure-requests, which would turn http://127.0.0.1
// calls into https). Everything else in the CSP is served unchanged, so image/script/style violations are still caught.
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' };
const EMULATORS = { host: '127.0.0.1', auth: 9099, database: 9000, functions: 5001 };
const TEST_CONFIG = `window.BASMA_CONFIG = ${JSON.stringify({ firebase: { projectId: 'demo-basma', apiKey: 'demo-api-key', appId: '1:0:web:e2e', databaseURL: 'https://demo-basma-default-rtdb.firebaseio.com', authDomain: 'demo-basma.firebaseapp.com' }, appCheckSiteKey: 'e2e-site-key', region: 'us-central1', emulators: EMULATORS })};\n`;
function emulatorCsp(html) {
  const extra = `http://${EMULATORS.host}:${EMULATORS.auth} http://${EMULATORS.host}:${EMULATORS.database} ws://${EMULATORS.host}:${EMULATORS.database} http://${EMULATORS.host}:${EMULATORS.functions}`;
  return html.replace(/(<meta http-equiv="Content-Security-Policy" content="[^"]*?connect-src [^;"]*)/, `$1 ${extra}`).replace(/; upgrade-insecure-requests/, '');
}
function start({ root, port = 4173, mode = 'static' }) {
  root = path.resolve(root);
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.join(root, rel);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    if (mode === 'emulator' && rel === '/manager/assets/config.js') { res.writeHead(200, { 'content-type': TYPES['.js'], 'cache-control': 'no-store' }).end(TEST_CONFIG); return; }
    fs.readFile(file, (error, bytes) => {
      if (error) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); return; }
      const type = TYPES[path.extname(file)] || 'application/octet-stream';
      const body = mode === 'emulator' && type.startsWith('text/html') ? emulatorCsp(bytes.toString('utf8')) : bytes;
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }).end(body);
    });
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)));
}
module.exports = { start, EMULATORS, emulatorCsp };
if (require.main === module) start({ root: process.argv[2] || '../site', mode: process.argv[3] || 'static' }).then(() => console.log('serving on http://localhost:4173'));
