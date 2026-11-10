'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {bootstrapOwner}=require('../scripts/owner-bootstrap');
function fixture(t,fail){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'basma-owner-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const output=path.join(dir,'owner.json'),users=new Map(),members=new Map(),events=[];
  const auth={
    async createUser(value){events.push('create');assert.equal(JSON.parse(fs.readFileSync(output)).status,'pending');if(fail==='create')throw Error('create failed');users.set('u1',{...value});assert.equal(value.disabled,true);return{uid:'u1'};},
    async setCustomUserClaims(uid,claims){if(['claims','cleanup'].includes(fail))throw Error('claims failed');users.get(uid).claims=claims;},
    async updateUser(uid,value){if(fail==='enable-auth'&&value.disabled===false)throw Error('enable failed');Object.assign(users.get(uid),value);},
    async deleteUser(uid){if(fail==='cleanup')throw Error('delete failed');users.delete(uid);}
  };
  const db={ref:key=>({async set(value){if(fail==='member'&&key==='access/u1'||fail==='enable-access'&&key.endsWith('/enabled'))throw Error('write failed');if(key.endsWith('/enabled'))members.get('access/u1').enabled=value;else members.set(key,value);},async remove(){members.delete(key);}})};
  return {auth,db,output,users,members,events};
}
test('seller credentials stay private and the account is enabled only after provisioning',async t=>{
  const h=fixture(t);await bootstrapOwner({...h,email:'owner@example.com'});
  const value=JSON.parse(fs.readFileSync(h.output));assert.equal(value.status,'ready');assert.equal(value.uid,'u1');assert.equal(value.role,'seller');assert.equal(value.password.length,32);
  assert.equal(fs.statSync(h.output).mode&0o777,0o600);assert.equal(h.users.get('u1').disabled,false);assert.equal(h.members.get('access/u1').enabled,true);assert.deepEqual(h.users.get('u1').claims,{version:1});
});
for(const fail of ['claims','member','enable-auth','enable-access'])test(`bootstrap rolls back Auth and access on ${fail} failure`,async t=>{
  const h=fixture(t,fail);await assert.rejects(()=>bootstrapOwner({...h,email:'owner@example.com'}),/rolled back/);assert.equal(h.users.size,0);assert.equal(h.members.size,0);assert.equal(fs.existsSync(h.output),false);
});
test('Auth creation failure removes only the reserved checkpoint',async t=>{
  const h=fixture(t,'create');await assert.rejects(()=>bootstrapOwner({...h,email:'owner@example.com'}));assert.equal(fs.existsSync(h.output),false);assert.equal(h.users.size,0);
});
test('an existing credentials file is never overwritten and creates no account',async t=>{
  const h=fixture(t);fs.writeFileSync(h.output,'existing');await assert.rejects(()=>bootstrapOwner({...h,email:'owner@example.com'}));assert.equal(fs.readFileSync(h.output,'utf8'),'existing');assert.equal(h.events.length,0);
});
test('a cleanup failure retains the private recovery checkpoint and a disabled account',async t=>{
  const h=fixture(t,'cleanup');await assert.rejects(()=>bootstrapOwner({...h,email:'owner@example.com'}),/checkpoint retained/);assert.equal(JSON.parse(fs.readFileSync(h.output)).status,'recovery-required');assert.equal(h.users.get('u1').disabled,true);assert.equal(h.members.size,0);
});
