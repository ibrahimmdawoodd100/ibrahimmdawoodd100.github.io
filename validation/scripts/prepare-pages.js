'use strict';
// v5: complete-site assembly, scoped patch, append-only Android associations and fail-closed preflight.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto'),cp=require('node:child_process');
const ORIGIN='https://ibrahimmdawoodd100.github.io';
const REPO='ibrahimmdawoodd100/ibrahimmdawoodd100.github.io';
const ANDROID=['com.arabataldahab.customer','com.arabataldahab.admin'];
const BASMA=['com.basma.employee','com.basma.manager','io.github.ibrahimmdawoodd100.twa'];
const ASSET='.well-known/assetlinks.json';
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const normalized=value=>Array.isArray(value)?value.map(normalized):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,normalized(value[k])])):value;
const canonical=value=>JSON.stringify(normalized(value));
const owned=name=>name==='seller.html'||name.startsWith('manager/')||name.startsWith('employee/');
function inventory(dir){const out=Object.create(null);function walk(at){for(const e of fs.readdirSync(at,{withFileTypes:true})){
 if(e.name==='.git')continue;const file=path.join(at,e.name);if(e.isSymbolicLink())throw Error('Symlink refused: '+file);
 if(e.isDirectory())walk(file);else out[path.relative(dir,file).split(path.sep).join('/')]=hash(fs.readFileSync(file));
}}walk(dir);return out;}
function changes(before,after){return [...new Set([...Object.keys(before),...Object.keys(after)])].sort().filter(p=>before[p]!==after[p]).map(p=>({path:p,action:before[p]===undefined?'ADD':after[p]===undefined?'DELETE':'MODIFY'}));}
function validAssociations(rows){if(!Array.isArray(rows)||!rows.length)throw Error('assetlinks must be a nonempty JSON array');for(const row of rows){if(!row||!Array.isArray(row.relation)||!row.target)throw Error('Malformed assetlinks entry');if(row.target.namespace==='android_app'&&(!row.target.package_name||!Array.isArray(row.target.sha256_cert_fingerprints)||!row.target.sha256_cert_fingerprints.length||row.target.sha256_cert_fingerprints.some(x=>!/^([A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2}$/.test(x))))throw Error('Malformed Android package/certificate');}}
function requirePackages(rows,names){for(const name of names)if(!rows.some(r=>r.target?.namespace==='android_app'&&r.target.package_name===name&&r.relation.includes('delegate_permission/common.handle_all_urls')))throw Error('Missing protected Android package: '+name);}
function mergeAssetlinks(live,basma){
 validAssociations(live);validAssociations(basma);requirePackages(live,ANDROID);requirePackages(basma,BASMA);
 if(basma.some(r=>!BASMA.includes(r.target.package_name)))throw Error('Basma source contains unrelated Android package');
 const out=structuredClone(live);for(const row of basma)if(!out.some(old=>canonical(old)===canonical(row)))out.push(structuredClone(row));
 requirePackages(out,[...ANDROID,...BASMA]);return out;
}
function preserves(oldRows,newRows){validAssociations(oldRows);validAssociations(newRows);for(const row of oldRows)if(!newRows.some(x=>canonical(x)===canonical(row)))throw Error('Existing assetlinks entry changed or removed');requirePackages(newRows,[...ANDROID,...BASMA]);}
function fetchBytes(url){return cp.execFileSync('curl',['--fail','--silent','--show-error','--location','--max-time','30',url],{maxBuffer:64*1024*1024});}
function fetchLive(){return JSON.parse(fetchBytes(ORIGIN+'/'+ASSET).toString('utf8'));}
function liveRevision(){
 // gh uses its local device-login credential, or Actions' built-in token; no token is written to the bundle.
 const api=route=>JSON.parse(cp.execFileSync('gh',['api',route],{encoding:'utf8',maxBuffer:4*1024*1024}));
 const deployments=api(`repos/${REPO}/deployments?environment=github-pages&per_page=20`);
 for(const deployment of deployments){const statuses=api(`repos/${REPO}/deployments/${deployment.id}/statuses?per_page=1`);if(statuses[0]?.state==='success')return `deployment:${deployment.id}:${deployment.sha}`;}
 const build=api(`repos/${REPO}/pages/builds/latest`);if(build.status==='built'&&build.commit)return 'build:'+build.commit;
 throw Error('Cannot establish current successful Pages revision; stop, do not publish');
}
function checkPublic(root){const ctx={window:{}};vm.runInNewContext(fs.readFileSync(path.join(root,'assets/config.js'),'utf8'),ctx,{timeout:1000});const c=ctx.window.BASMA_CONFIG;if(!c?.firebase||!c.appCheckSiteKey||JSON.stringify(c).includes('REPLACE_ME'))throw Error('Complete scripts/configure.js before preparing Pages');for(const key of ['projectId','apiKey','appId','authDomain','databaseURL'])if(typeof c.firebase[key]!=='string'||!c.firebase[key])throw Error('Missing public Firebase setting: '+key);}
function publicFiles(source){const all=inventory(path.join(source,'public')),out={};for(const name of Object.keys(all)){
 if(name.startsWith('assets/'))out['manager/'+name]=name;else if(owned(name))out[name]=name;else if(name!==ASSET&&name!=='.nojekyll')throw Error('Source attempts to publish outside Basma: '+name);
}return out;}
function copyFile(from,to){fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to);}
function copyTree(from,to){fs.mkdirSync(to,{recursive:true});for(const name of Object.keys(inventory(from)))copyFile(path.join(from,name),path.join(to,name));}
function metadata(target){return JSON.parse(fs.readFileSync(path.join(target,'pages-safety.json'),'utf8'));}
function verify(target){
 const m=metadata(target),base=inventory(path.join(target,'baseline-site')),site=inventory(path.join(target,'site'));
 if(m.version!==5||canonical(base)!==canonical(m.baselineHashes))throw Error('Baseline snapshot changed');
 const diff=changes(base,site);
 console.log('Planned public-file changes (DELETE includes obsolete Basma files only):');for(const d of diff)console.log(`${d.action}\t${d.path}`);
 if(!diff.some(d=>d.action==='DELETE'))console.log('DELETE\t(none)');
 for(const row of diff)if(!owned(row.path)&&row.path!==ASSET)throw Error('Protected path would change: '+row.action+' '+row.path);
 const old=JSON.parse(fs.readFileSync(path.join(target,'baseline-site',ASSET))),merged=JSON.parse(fs.readFileSync(path.join(target,'site',ASSET)));preserves(old,merged);
 if(hash(fs.readFileSync(path.join(target,'site',ASSET)))!==m.assetlinksHash)throw Error('Merged assetlinks was modified after preparation');
 const actualOwned=Object.fromEntries(Object.entries(site).filter(([name])=>owned(name)));
 if(canonical(actualOwned)!==canonical(m.expectedOwnedHashes))throw Error('Basma output modified after preparation');
 if(m.mode==='release'){
  const src=path.join(target,'validation');checkPublic(path.join(src,'public'));
  const expected=Object.fromEntries(Object.entries(publicFiles(src)).map(([out,file])=>[out,hash(fs.readFileSync(path.join(src,'public',file)))]));
  if(canonical(expected)!==canonical(actualOwned))throw Error('Site differs from validated Basma sources');
 }
 console.log('Protected files unchanged; all 5 required Android packages retained.');return diff;
}
function preflight(target,{readLive=fetchLive,revision=liveRevision,readUrl=fetchBytes}={}){
 verify(target);const m=metadata(target);
 if(revision()!==m.liveRevision)throw Error('Live Pages revision changed; reassemble from its latest artifact');
 const live=readLive(),base=JSON.parse(fs.readFileSync(path.join(target,'baseline-site',ASSET)));
 if(canonical(live)!==canonical(base))throw Error('Live assetlinks changed; reassemble and merge again');
 // Check every baseline public file outside Basma, not only the associations file.
 for(const [name,sha] of Object.entries(m.baselineHashes))if(!owned(name)&&name!==ASSET&&name!=='.nojekyll'&&!name.startsWith('.github/')){
  if(hash(readUrl(ORIGIN+'/'+name.split('/').map(encodeURIComponent).join('/')))!==sha)throw Error('Live protected file differs: '+name);
 }
 if(revision()!==m.liveRevision)throw Error('Concurrent Pages deployment detected');
 console.log('LIVE PREFLIGHT PASSED. Keep other deployments frozen until this deployment completes.');
}
function prepare(source,target,{baseSite,restoreFrom,readLive=fetchLive,revision=liveRevision}={}){
 source=fs.realpathSync(source);target=path.resolve(target);if(fs.existsSync(target)&&fs.lstatSync(target).isSymbolicLink())throw Error('Symlink output refused');target=path.join(fs.realpathSync(path.dirname(target)),path.basename(target));if(!baseSite)throw Error('--base-site is mandatory: a complete current deployed site artifact');baseSite=fs.realpathSync(baseSite);if(restoreFrom)restoreFrom=fs.realpathSync(restoreFrom);
 for(const parent of [source,baseSite,...(restoreFrom?[path.resolve(restoreFrom)]:[])])if(target===parent||target.startsWith(parent+path.sep)||parent.startsWith(target+path.sep))throw Error('Output must be separate from source and snapshots');
 const live=readLive();validAssociations(live);requirePackages(live,ANDROID);
 const baselineRows=JSON.parse(fs.readFileSync(path.join(baseSite,ASSET)));
 if(canonical(baselineRows)!==canonical(live))throw Error('Baseline assetlinks does not match live website');
 const liveRef=revision();
 if(fs.existsSync(target)&&fs.readdirSync(target).length)throw Error('Use a new empty output directory; existing snapshots are never overwritten');
 if(!restoreFrom){checkPublic(path.join(source,'public'));for(const lock of ['package-lock.json','functions/package-lock.json'])if(!fs.existsSync(path.join(source,lock)))throw Error('Run npm install first: missing '+lock);}
 fs.mkdirSync(target,{recursive:true});fs.writeFileSync(path.join(target,'.gitignore'),'node_modules/\n.firebase/\n.env*\n.cloud-shell.env\n*credentials*.json\n*-debug.log\n');copyTree(baseSite,path.join(target,'baseline-site'));copyTree(baseSite,path.join(target,'site'));
 for(const name of ['manager','employee','seller.html'])fs.rmSync(path.join(target,'site',name),{recursive:true,force:true});
 if(restoreFrom){for(const name of Object.keys(inventory(restoreFrom)))if(owned(name))copyFile(path.join(restoreFrom,name),path.join(target,'site',name));}
 else{
  for(const [out,file] of Object.entries(publicFiles(source)))copyFile(path.join(source,'public',file),path.join(target,'site',out));
 }
  const v=path.join(target,'validation');
  for(const dir of ['functions','scripts','tests'])for(const item of fs.readdirSync(path.join(source,dir),{withFileTypes:true}))if(item.isFile()&&(/\.(js|py)$/.test(item.name)||['package.json','package-lock.json'].includes(item.name)))copyFile(path.join(source,dir,item.name),path.join(v,dir,item.name));
  for(const file of ['package.json','package-lock.json','firebase.json','database.rules.json','security-policy.json'])copyFile(path.join(source,file),path.join(v,file));
  copyTree(path.join(source,'public'),path.join(v,'public'));
 // Rollback keeps current associations too; never roll the shared Android file back to an older list.
 const merged=restoreFrom?live:mergeAssetlinks(live,JSON.parse(fs.readFileSync(path.join(source,'public',ASSET))));requirePackages(merged,[...ANDROID,...BASMA]);
 fs.writeFileSync(path.join(target,'site',ASSET),JSON.stringify(merged,null,2)+'\n');
 const site=inventory(path.join(target,'site'));
 const m={version:5,mode:restoreFrom?'rollback':'release',liveRevision:liveRef,origin:ORIGIN,baselineHashes:inventory(path.join(target,'baseline-site')),expectedOwnedHashes:Object.fromEntries(Object.entries(site).filter(([n])=>owned(n))),assetlinksHash:hash(fs.readFileSync(path.join(target,'site',ASSET)))};
 fs.writeFileSync(path.join(target,'pages-safety.json'),JSON.stringify(m,null,2)+'\n');
 copyFile(path.join(source,'.github/workflows/pages.yml'),path.join(target,'.github/workflows/basma-v5.yml'));
 verify(target);console.log('Prepared complete shared site at '+target+'. This command does not push or deploy.');
}
if(require.main===module){try{
 const args=process.argv.slice(2);if(args[0]==='--verify')verify(path.resolve(args[1]||'.'));else if(args[0]==='--preflight')preflight(path.resolve(args[1]||'.'));else{
  const pos=args.indexOf('--base-site'),rollback=args.indexOf('--restore-from'),target=args[0];
  if(!target||pos<0)throw Error('Usage: node scripts/prepare-pages.js OUTPUT --base-site CURRENT_SITE [--restore-from ORIGINAL_SITE] | --verify OUTPUT | --preflight OUTPUT');
  prepare(path.resolve(__dirname,'..'),target,{baseSite:args[pos+1],restoreFrom:rollback<0?undefined:path.resolve(args[rollback+1])});
 }
}catch(error){console.error(error.message);process.exitCode=1;}}
module.exports={prepare,verify,preflight,mergeAssetlinks,changes,inventory,owned};
