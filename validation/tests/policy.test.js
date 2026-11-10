'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../functions/policy');
test('anonymous, disabled, stale, and wrong-role identities cannot authorize', () => {
  const info = { status:'active', expiresAt:2000 }, member = { enabled:true, role:'employee', version:2 };
  for (const candidate of [null,{...member,enabled:false},{...member,role:'seller'},{...member,version:1}]) assert.throws(() => p.authorize(candidate,{version:2},info,['employee'],1000));
  assert.equal(p.authorize(member,{version:2},info,['employee'],1000),member);
});
test('suspension and expiry block tenant identities immediately', () => {
  const member={enabled:true,role:'manager',version:1};
  for(const info of [null,{status:'suspended',expiresAt:3000},{status:'active',expiresAt:1000},{status:'active',expiresAt:NaN}]) assert.throws(()=>p.authorize(member,{version:1},info,['manager'],1000));
});
test('server geofence accepts zero coordinates and rejects forged malformed/outside values', () => {
  const zone={lat:0,lng:0,radius:100,enabled:true};
  assert.equal(p.location({lat:0,lng:0},zone).lat,0);
  for (const point of [{lat:2,lng:2},{lat:'0',lng:0},{lat:NaN,lng:0},{lat:91,lng:0},{lat:0,lng:181},null]) assert.throws(()=>p.location(point,zone));
});
test('attendance transitions prohibit duplicates and invalid order',()=>{
  assert.throws(()=>p.transition(null,'out'));
  assert.throws(()=>p.transition({events:{in:{}}},'in'));
  assert.throws(()=>p.transition({events:{in:{},out:{}}},'departure'));
  assert.throws(()=>p.transition(null,'return'));
  assert.doesNotThrow(()=>p.transition({events:{in:{}}},'out'));
});
test('server time conversion and windows support midnight-crossing schedules',()=>{
  assert.deepEqual(p.dateParts(new Date('2026-10-10T22:30:00Z'),'Asia/Baghdad'),{date:'2026-10-11',minutes:90});
  assert.equal(p.insideWindow(30,{from:'23:00',to:'01:00'}),true);
  assert.equal(p.insideWindow(120,{from:'23:00',to:'01:00'}),false);
  assert.throws(()=>p.minutes('99:00'));
  assert.throws(()=>p.dateParts(new Date(),'invalid/zone'));
});
test('passwords are cryptographically generated, never reused, and long',()=>{
  const values=new Set(Array.from({length:1000},()=>p.password()));
  assert.equal(values.size,1000); for(const value of values) assert.equal(value.length,32);
});
test('path and text validation rejects traversal and executable markup',()=>{
  for(const key of ['../other','abc/def','x.y','',null]) assert.throws(()=>p.key(key));
  for(const value of ['<script>','<img onerror=x>','name\u0000']) assert.throws(()=>p.text(value,'name'));
});
test('planted memberships without a signed positive version cannot authorize',()=>{
  const info={status:'active',expiresAt:Date.now()+60000};
  for(const version of [undefined,null,0,-1,'1',NaN,Infinity,1.5])assert.throws(()=>p.authorize({enabled:true,role:'seller',version},{version},info,['seller']));
  assert.throws(()=>p.authorize({enabled:true,role:'seller',version:1},{},info,['seller']));
});
test('GPS accuracy is capped at 150 metres and distance errors show the excess',()=>{
  const zone={lat:0,lng:0,radius:100};
  assert.doesNotThrow(()=>p.location({lat:0,lng:0.0018,accuracy:120},zone));
  assert.throws(()=>p.location({lat:0,lng:0.003,accuracy:1000000},zone),/150.*\d+ متر/);
  assert.throws(()=>p.location({lat:0,lng:0.0018,accuracy:20},zone),/المسافة الزائدة/);
  for(const accuracy of [-1,NaN,Infinity,'150'])assert.throws(()=>p.location({lat:0,lng:0,accuracy},zone));
  assert.equal(p.location({lat:0,lng:0,accuracy:900},zone).gpsTolerance,150);
});
test('a server-approved excused check-in permits checkout, a checkout-only excuse does not',()=>{
  for(const excuseType of ['no_checkin','no_both'])assert.doesNotThrow(()=>p.transition({events:{excused:{excuseType}}},'out'));
  assert.throws(()=>p.transition({events:{excused:{excuseType:'no_checkout'}}},'out'));
  assert.throws(()=>p.transition({events:{excused:{excuseType:'no_both'},out:{}}},'out'));
});
test('excused status does not fabricate actual timestamps or work duration',()=>{
  const summary=p.attendanceSummary({events:{excused:{excuseType:'no_both',requestId:'r1'}}});
  assert.equal(summary.statusLabel,'انصرف (بعذر)');assert.equal(summary.checkIn,null);assert.equal(summary.checkOut,null);assert.equal(summary.actualWorkMinutes,null);
  const actual=p.attendanceSummary({events:{excused:{excuseType:'no_checkin'},out:{timestamp:'2026-10-15T16:00:00Z'}}});
  assert.equal(actual.attendanceStatus,'excused_out');assert.equal(actual.checkIn,null);assert.equal(actual.actualWorkMinutes,null);
});
