'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
let scripts = 0;
for (const dir of ['public/assets', 'functions', 'scripts', 'tests']) {
  for (const file of fs.readdirSync(path.join(root, dir)).filter(x => x.endsWith('.js'))) { new vm.Script(fs.readFileSync(path.join(root, dir, file), 'utf8'), { filename: file }); scripts++; }
}
const config = JSON.parse(fs.readFileSync(path.join(root, 'security-policy.json')));
const csp = config.contentSecurityPolicy;
for (const relative of ['public/manager/index.html','public/employee/index.html','public/seller.html']) {
  const source = fs.readFileSync(path.join(root, relative), 'utf8');
  for(const match of source.matchAll(/<script[^>]+src="(\/(?:manager\/)?assets\/[^\"]+)"/g))if(!fs.existsSync(path.join(root,'public',match[1].replace(/^\/manager\/assets\//,'assets/').slice(match[1].startsWith('/manager/assets/')?0:1))))throw new Error(`Missing script ${match[1]}`);
  if(/data-basma-click="(?:approveLocation|rejectLocation|answerBypass|requestDeviceBypass)\(/.test(source))throw new Error(`Legacy action remains in ${relative}`);
  const meta=source.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/);
  const expected=csp.split('; ').filter(x=>!x.startsWith('frame-ancestors ')).join('; ');
  if (!meta || meta[1].replace(/&quot;/g,'"').replace(/&amp;/g,'&') !== expected) throw new Error(`Missing or stale GitHub Pages CSP: ${relative}`);
  if (source.indexOf(meta[0]) > source.indexOf('<script')) throw new Error(`CSP must precede scripts: ${relative}`);
  for (const match of source.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc=/.test(match[1])) continue;
    new vm.Script(match[2], { filename: relative }); scripts++;
    const hash = createHash('sha256').update(match[2]).digest('base64');
    if (!csp.includes(`'sha256-${hash}'`)) throw new Error(`Missing CSP hash: ${relative}`);
  }
  if (/\s(?:onclick|onchange|onkeydown|oninput)=/.test(source)) throw new Error(`Inline handler: ${relative}`);
  if (/createUserWithEmailAndPassword|managerPassword|document\.write\(/.test(source)) throw new Error(`Legacy sensitive path: ${relative}`);
  if ((source.match(/src="\/manager\/assets\/(?:manager|employee|seller)\.js"/g) || []).length !== 1) throw new Error(`Invalid entrypoint count: ${relative}`);
}
// Diagnostics page: same CSP, no inline scripts, every script present.
{
  const relative = 'public/manager/diagnostics.html';
  const referenced = ['public/seller.html', 'public/manager/index.html', 'public/employee/index.html', ...fs.readdirSync(path.join(root, 'public/assets')).map(f => 'public/assets/' + f)]
    .some(file => fs.readFileSync(path.join(root, file), 'utf8').includes('/manager/diagnostics.html'));
  if (referenced && !fs.existsSync(path.join(root, relative))) throw new Error('A page links to /manager/diagnostics.html but the file is missing');
  if (fs.existsSync(path.join(root, relative))) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    const meta = source.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/);
    const expected = csp.split('; ').filter(x => !x.startsWith('frame-ancestors ')).join('; ');
    if (!meta || meta[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&') !== expected) throw new Error(`Missing or stale GitHub Pages CSP: ${relative}`);
    if (source.indexOf(meta[0]) > source.indexOf('<script')) throw new Error(`CSP must precede scripts: ${relative}`);
    for (const match of source.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)) if (!/\bsrc=/.test(match[1]) || match[2].trim()) throw new Error(`Inline script not allowed: ${relative}`);
    for (const match of source.matchAll(/<(?:script|link)[^>]+(?:src|href)="(\/manager\/assets\/[^"]+)"/g)) if (!fs.existsSync(path.join(root, 'public/assets', match[1].slice('/manager/assets/'.length)))) throw new Error(`Missing asset ${match[1]}`);
    if (/\s(?:onclick|onchange|onkeydown|oninput|onload)=/.test(source)) throw new Error(`Inline handler: ${relative}`);
  }
}
JSON.parse(fs.readFileSync(path.join(root, 'database.rules.json')));
console.log(`Syntax, CSP hashes, and legacy-path checks passed (${scripts} scripts).`);
