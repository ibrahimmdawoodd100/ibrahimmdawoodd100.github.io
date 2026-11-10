'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {prepare,verify,preflight,mergeAssetlinks}=require('../scripts/prepare-pages');
const basma=JSON.parse(fs.readFileSync(path.join(__dirname,'../public/.well-known/assetlinks.json')));
const row=name=>({relation:['delegate_permission/common.handle_all_urls'],target:{namespace:'android_app',package_name:name,sha256_cert_fingerprints:[Array(32).fill('AA').join(':')]}});
const others=[row('com.arabataldahab.customer'),row('com.arabataldahab.admin')];
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'basma-shared-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const source=path.join(dir,'source'),baseSite=path.join(dir,'baseline'),target=path.join(dir,'release');
 const write=(root,name,data)=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,data);};
 for(const name of ['functions','scripts','tests'])fs.mkdirSync(path.join(source,name),{recursive:true});
 write(source,'public/assets/config.js','window.BASMA_CONFIG={firebase:{projectId:"test",apiKey:"public",appId:"public",authDomain:"test.firebaseapp.com",databaseURL:"https://test.firebaseio.com"},appCheckSiteKey:"public-key"};');
 for(const file of ['public/manager/index.html','public/employee/index.html','public/seller.html'])write(source,file,'new Basma '+file);
 write(source,'public/.well-known/assetlinks.json',JSON.stringify(basma));write(source,'public/.nojekyll','');
 for(const name of ['package.json','package-lock.json','functions/package.json','functions/package-lock.json','firebase.json','database.rules.json','security-policy.json'])write(source,name,'{}');
 write(source,'functions/index.js','exports.ok=true;');write(source,'functions/.env.secret','PRIVATE');write(source,'.cloud-shell.env','PRIVATE');write(source,'.github/workflows/pages.yml','name: Example');
 for(const name of ['index.html','customer/index.html','admin/index.html','assets/shared.js','__proto__','.nojekyll','manager/obsolete.txt','manager/index.html','employee/index.html','seller.html'])write(baseSite,name,'OLD '+name);
 write(baseSite,'.well-known/assetlinks.json',JSON.stringify(others));
 const options={baseSite,readLive:()=>structuredClone(others),revision:()=> 'fixture-revision'};
 return {source,baseSite,target,dir,options,write};
}
test('live Android associations merge append-only into exactly 5 entries for the 2+3 case',()=>{
 const merged=mergeAssetlinks(others,basma);assert.equal(merged.length,5);assert.deepEqual(merged.slice(0,2),others);assert.deepEqual(mergeAssetlinks(merged,basma),merged);assert.equal(others.length,2);
 const extra=[...others,row('another.application')];assert.equal(mergeAssetlinks(extra,basma).length,6);
});
test('merge refuses missing protected apps and malformed certificates',()=>{
 assert.throws(()=>mergeAssetlinks([others[0]],basma),/Missing protected/);assert.throws(()=>mergeAssetlinks([{...others[0],target:{...others[0].target,sha256_cert_fingerprints:['bad']}},others[1]],basma),/Malformed/);
});
test('shared-site preparation preserves every unrelated file and scopes all new assets',t=>{
 const f=fixture(t);prepare(f.source,f.target,f.options);verify(f.target);
 for(const name of ['index.html','customer/index.html','admin/index.html','assets/shared.js','__proto__','.nojekyll'])assert.equal(fs.readFileSync(path.join(f.target,'site',name),'utf8'),'OLD '+name);
 assert.equal(fs.existsSync(path.join(f.target,'site/manager/assets/config.js')),true);assert.equal(fs.existsSync(path.join(f.target,'site/manager/obsolete.txt')),false);
 assert.equal(fs.existsSync(path.join(f.target,'validation/functions/.env.secret')),false);assert.equal(JSON.parse(fs.readFileSync(path.join(f.target,'site/.well-known/assetlinks.json'))).length,5);
});
test('preflight displays changes and refuses deletion or modification outside Basma',t=>{
 const f=fixture(t);prepare(f.source,f.target,f.options);fs.unlinkSync(path.join(f.target,'site/customer/index.html'));assert.throws(()=>verify(f.target),/Protected path/);
 f.write(path.join(f.target,'site'),'customer/index.html','OLD customer/index.html');f.write(path.join(f.target,'site'),'assets/shared.js','damaged');assert.throws(()=>verify(f.target),/Protected path/);
});
test('preflight checks live revision, live associations and protected file content',t=>{
 const f=fixture(t);prepare(f.source,f.target,f.options);
 const network={...f.options,readUrl:url=>fs.readFileSync(path.join(f.baseSite,decodeURIComponent(new URL(url).pathname.slice(1))))};
 preflight(f.target,network);
 assert.throws(()=>preflight(f.target,{...network,revision:()=> 'changed'}),/revision changed/);
 assert.throws(()=>preflight(f.target,{...network,readLive:()=> [...others,row('new.app')]}),/assetlinks changed/);
 assert.throws(()=>preflight(f.target,{...network,readUrl:()=>Buffer.from('changed')}),/Live protected file/);
});
test('stale baseline, absent live associations and missing locks block preparation',t=>{
 const f=fixture(t);assert.throws(()=>prepare(f.source,f.target,{...f.options,readLive:()=> [...others,row('new.app')]}),/does not match/);
 assert.throws(()=>prepare(f.source,f.target,{...f.options,readLive:()=>{throw Error('network unavailable');}}),/network/);
 fs.unlinkSync(path.join(f.source,'package-lock.json'));assert.throws(()=>prepare(f.source,f.target,f.options),/missing/);
});
test('rollback restores only Basma paths and keeps all current Android associations',t=>{
 const f=fixture(t);prepare(f.source,f.target,f.options);const live=JSON.parse(fs.readFileSync(path.join(f.target,'site/.well-known/assetlinks.json')));
 const rollback=path.join(f.dir,'rollback');prepare(f.source,rollback,{baseSite:path.join(f.target,'site'),restoreFrom:f.baseSite,readLive:()=>live,revision:()=> 'release'});
 verify(rollback);assert.equal(fs.readFileSync(path.join(rollback,'site/manager/index.html'),'utf8'),'OLD manager/index.html');assert.equal(fs.readFileSync(path.join(rollback,'site/customer/index.html'),'utf8'),'OLD customer/index.html');assert.deepEqual(JSON.parse(fs.readFileSync(path.join(rollback,'site/.well-known/assetlinks.json'))),live);
});
test('candidate tampering, baseline tampering and unmanaged outputs are refused',t=>{
 const f=fixture(t);prepare(f.source,f.target,f.options);f.write(path.join(f.target,'site'),'manager/index.html','tampered');assert.throws(()=>verify(f.target),/Basma output/);
 assert.throws(()=>prepare(f.source,f.target,f.options),/empty output/);f.write(path.join(f.target,'baseline-site'),'index.html','tampered');assert.throws(()=>verify(f.target),/Baseline snapshot/);
});
