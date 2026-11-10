'use strict';
// Reuses the offline backend test harness to execute real callable/trigger code.
// No Firebase SDK network, signature cryptography, retry traffic or billed wire-byte measurement.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module');
const {fixture}=require('./measure-flows');
async function main(){
 const source=path.resolve(process.argv[2]||path.join(__dirname,'..')),client=JSON.parse(fs.readFileSync(process.argv[3]||path.join(source,'measurements/v5-trace.json')));
 const req=createRequire(path.join(source,'tests/backend.test.js'));
 const instrumentedRequire=name=>name==='node:test'?()=>{}:req(name);instrumentedRequire.resolve=req.resolve;
 const sandbox={require:instrumentedRequire,console,Buffer,structuredClone,URL};
 let harnessSource=fs.readFileSync(path.join(source,'tests/backend.test.js'),'utf8').replace('return { api:context.exports,','return { db, api:context.exports,');
 harnessSource+='\nglobalThis.exposeHarness=harness;';vm.runInNewContext(harnessSource,sandbox,{filename:'backend-harness.js'});
 const result={scope:'Real backend code with mocked Admin SDK and WebAuthn verifier. Reads include transaction callback inputs; no retries/protocol overhead.',flows:{}};
 for(const role of ['employee','manager']){
  const data=fixture(),h=sandbox.exposeHarness({now:data.now});h.set('companies/c1',data.data.companies.c1);h.set('companies/c1/info/expiresAt',Math.max(Date.now()+86400000,data.now+86400000));h.set('access/employee/employeeId','e0');h.set('credentials/employee',{id:'credential1',publicKey:Buffer.from('key').toString('base64'),counter:0,transports:[]});
  const reads=[],original=h.db.ref;
  h.db.ref=location=>new Proxy(original(location),{get(target,name,receiver){const member=Reflect.get(target,name,receiver);if(name==='get')return async()=>{const s=await member.call(receiver);reads.push({path:location,operation:'get',jsonBytes:Buffer.byteLength(JSON.stringify(s.val()))});return s;};if(name==='transaction')return async fn=>member.call(receiver,old=>{reads.push({path:location,operation:'transaction-input',jsonBytes:Buffer.byteLength(JSON.stringify(old))});return fn(old);});return typeof member==='function'?member.bind(receiver):member;}});
  let challenge,proof;
  for(const step of ['opening','action']){
   reads.length=0;
   for(const call of client[role][step].callables){
    const name=call.name;let args={};if(name==='beginWebAuthn')args={mode:'authenticate',intent:'in'};if(name==='finishWebAuthn')args={challengeId:challenge,response:{valid:true}};if(name==='recordAttendance')args={type:'in',proof,location:{lat:0,lng:0,accuracy:5}};
    const out=await h.invoke(name,role,args);if(name==='beginWebAuthn')challenge=out.challengeId;if(name==='finishWebAuthn')proof=out.proof;
    if(name==='recordAttendance')await h.api.projectAttendance({params:{cid:'c1',eid:'e0',date:data.date}});
   }
   result.flows[role+'-'+step]={reads:structuredClone(reads),jsonPayloadBytes:reads.reduce((sum,r)=>sum+r.jsonBytes,0),readOperations:reads.length};
  }
 }
 console.log(JSON.stringify(result,null,2));
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
