'use strict';
// Run from the v5.2 source, with a separately extracted, unchanged v5.1 source.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const source=path.resolve(__dirname,'..'),baseline=path.resolve(process.argv[2]||''),output=path.join(source,'measurements/v5.2');
if(!process.argv[2]||baseline===source||!fs.existsSync(path.join(baseline,'functions/index.js'))||fs.existsSync(path.join(baseline,'public/assets/manager-data.js')))throw Error('Provide the separately extracted v5.1 source directory.');
fs.mkdirSync(output,{recursive:true});
const hash=value=>crypto.createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
const baselineHashes={};for(const dir of ['public/assets','public/manager','functions','tests'])for(const name of fs.readdirSync(path.join(baseline,dir))){const p=path.join(baseline,dir,name);if(fs.statSync(p).isFile())baselineHashes[dir+'/'+name]=hash(fs.readFileSync(p));}
fs.writeFileSync(path.join(output,'baseline-source-sha256.json'),JSON.stringify(baselineHashes,null,2)+'\n');
const afterHashes={};for(const name of Object.keys(baselineHashes)){const file=path.join(source,name);if(fs.existsSync(file))afterHashes[name]=hash(fs.readFileSync(file));}afterHashes['public/assets/manager-data.js']=hash(fs.readFileSync(path.join(source,'public/assets/manager-data.js')));fs.writeFileSync(path.join(output,'after-source-sha256.json'),JSON.stringify(afterHashes,null,2)+'\n');
function run(script,args,file,env){const fd=fs.openSync(file,'w');let r;try{r=spawnSync(process.execPath,[path.join(source,'scripts',script),...args],{env,stdio:['ignore',fd,'inherit']});}finally{fs.closeSync(fd);}if(r.error)throw r.error;if(r.status!==0)throw Error(`measurement exit ${r.status}`);return JSON.parse(fs.readFileSync(file,'utf8'));}
const rows=[],proof=[];
for(const count of [10,120,200]){
 const env={...process.env,BASMA_LEAVES_PER_EMPLOYEE:String(count),BASMA_MEASUREMENT_MODE:'month-stability',BASMA_MANAGER_ACTION:'month'},row={requestsPerEmployee:count};
 process.env.BASMA_LEAVES_PER_EMPLOYEE=String(count);process.env.BASMA_MEASUREMENT_MODE='month-stability';
 const fixture=require('./measure-flows').fixture(),leaves=fixture.data.companies.c1.leaves;
 proof.push({requestsPerEmployee:count,totalLeaves:Object.keys(leaves).length,currentMonthHash:hash(Object.fromEntries(Object.entries(leaves).filter(([,r])=>r.date>='2026-10-01'&&r.date<='2026-10-31'))),pendingHash:hash(Object.fromEntries(Object.entries(leaves).filter(([,r])=>r.status==='pending')))});
 for(const [version,folder]of [['before',baseline],['after',source]]){
  const clientFile=path.join(output,`${count}-${version}-client.json`),client=run('measure-flows.js',[folder],clientFile,env),server=run('measure-server.js',[folder,clientFile],path.join(output,`${count}-${version}-server.json`),env);
  for(const role of ['employee','manager'])for(const step of ['opening','action'])if(client[role][step].errors.length)throw Error(JSON.stringify(client[role][step].errors));
  row[version]={open:client.manager.opening.jsonPayloadBytes+server.flows['manager-opening'].jsonPayloadBytes,month:client.manager.action.jsonPayloadBytes+server.flows['manager-action'].jsonPayloadBytes};
 }
 rows.push(row);
}
if(new Set(proof.map(p=>p.currentMonthHash)).size!==1||new Set(proof.map(p=>p.pendingHash)).size!==1)throw Error('Fixture changed the current month or pending backlog.');
if(new Set(rows.map(r=>r.after.month)).size!==1||new Set(rows.map(r=>r.after.open)).size!==1)throw Error('Archive growth increased the bounded view payload.');
fs.writeFileSync(path.join(output,'stability-proof.json'),JSON.stringify({node:process.version,fixture:'100 employees; fixed October 2026 and pending backlog; only resolved history outside October grows',proof,rows},null,2)+'\n');
console.log(`Node ${process.version}; v5.1 -> v5.2; synthetic fixture; JSON UTF-8 read payload bytes, NOT billed wire bytes.`);
console.log('leaves/employee | open before | open after | month before | month after');
for(const r of rows)console.log(`${r.requestsPerEmployee} | ${r.before.open} | ${r.after.open} | ${r.before.month} | ${r.after.month}`);
console.log('Current-month data hashes: IDENTICAL across 10/120/200.');
console.log('Pending backlog hashes: IDENTICAL across 10/120/200.');
console.log('v5.2 opening and monthly-view payloads: EXACTLY EQUAL across 10/120/200.');
