'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const root=path.resolve(__dirname,'..'),config=JSON.parse(fs.readFileSync(path.join(root,'security-policy.json')));
const hashes=[];
for(const relative of ['public/manager/index.html','public/employee/index.html','public/seller.html'])for(const match of fs.readFileSync(path.join(root,relative),'utf8').matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi))if(!/\bsrc=/.test(match[1]))hashes.push(`'sha256-${createHash('sha256').update(match[2]).digest('base64')}'`);
config.contentSecurityPolicy=config.contentSecurityPolicy.replace(/script-src [^;]+/,`script-src 'self' https://www.gstatic.com https://www.google.com https://cdnjs.cloudflare.com https://unpkg.com ${hashes.join(' ')}`);
fs.writeFileSync(path.join(root,'security-policy.json'),JSON.stringify(config,null,2)+'\n');
const csp=config.contentSecurityPolicy;
// GitHub Pages cannot emit application-defined HTTP headers. frame-ancestors is
// ignored in meta policies and must be provided by a header-capable host/proxy.
const metaPolicy=csp.split('; ').filter(x=>!x.startsWith('frame-ancestors ')).join('; ');
for(const relative of ['public/manager/index.html','public/employee/index.html','public/seller.html']) {
  const file=path.join(root,relative);
  let html=fs.readFileSync(file,'utf8').replace(/\s*<meta\s+http-equiv="Content-Security-Policy"[^>]*>/gi,'');
  const charset=html.match(/<meta\s+charset=[^>]+>/i)?.[0] || '<meta charset="UTF-8">';
  html=html.replace(/<meta\s+charset=[^>]+>/gi,'');
  const escaped=metaPolicy.replace(/&/g,'&amp;').replace(/"/g,'&quot;');
  html=html.replace(/<head>/i,`<head>\n${charset}\n<meta http-equiv="Content-Security-Policy" content="${escaped}">\n<meta name="referrer" content="strict-origin-when-cross-origin">`);
  // Avoid duplicates when regenerating the policy.
  let first=true;html=html.replace(/<meta name="referrer" content="strict-origin-when-cross-origin">/g,match=>{if(first){first=false;return match;}return '';});
  fs.writeFileSync(file,html);
}
