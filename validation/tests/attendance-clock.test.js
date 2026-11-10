'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),C=require('../public/assets/attendance-clock'),P=require('../functions/policy');
const at=time=>Date.parse(`2026-10-15T${time}Z`),range={from:'14:00',to:'14:30'};
function fixture(start=at('13:55:00')){
  let now=start,serial=0,current={...range},loads=0,last;const jobs=new Map();
  const timers={setTimeout:(fn,delay)=>{const id=++serial;jobs.set(id,{fn,at:now+delay});return id;},clearTimeout:id=>jobs.delete(id),setInterval:(fn,delay)=>{const id=++serial;jobs.set(id,{fn,at:now+delay,interval:delay});return id;},clearInterval:id=>jobs.delete(id)};
  const ctl=C.controller({now:()=>now,load:async()=>{loads++;return {...current};},render:(state,time)=>{last=state?C.windowState(time,'UTC',state):null;return last?.nextMs;},timers});
  const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
  return {ctl,get value(){return last;},get loads(){return loads;},setSchedule:value=>current=value,async jump(time){now=time;},async advance(to){while(true){const pair=[...jobs].filter(([,j])=>j.at<=to).sort((a,b)=>a[1].at-b[1].at)[0];if(!pair)break;const [id,job]=pair;now=job.at;if(job.interval)job.at+=job.interval;else jobs.delete(id);job.fn();await flush();}now=to;await flush();},dropIntervals(){for(const [id,j]of jobs)if(j.interval)jobs.delete(id);}};
}
test('five minutes before the window shows the server-based countdown',()=>{
  const s=C.windowState(at('13:55:00'),'UTC',range);assert.equal(s.open,false);assert.equal(s.remaining,300);assert.match(s.label,/يبدأ بعد 00:05:00/);
});
test('crossing the start opens automatically without a page refresh',async()=>{
  const f=fixture();await f.ctl.start();await f.advance(at('13:59:59'));assert.equal(f.value.open,false);await f.advance(at('14:00:00'));assert.equal(f.value.open,true);f.ctl.stop();
});
test('crossing the end closes at exactly 14:30:00',async()=>{
  const f=fixture(at('14:29:58'));await f.ctl.start();await f.advance(at('14:30:00'));assert.equal(f.value.open,false);f.ctl.stop();
});
test('a boundary timeout opens even when interval callbacks do not run',async()=>{
  const f=fixture();await f.ctl.start();f.dropIntervals();await f.advance(at('14:00:00'));assert.equal(f.value.open,true);f.ctl.stop();
});
test('overnight windows and company time zone agree with server at all boundaries',()=>{
  const range={from:'23:00',to:'01:00'};
  for(const [stamp,open]of [['2026-10-15T19:59:59Z',false],['2026-10-15T20:00:00Z',true],['2026-10-15T21:30:00Z',true],['2026-10-15T22:00:00Z',false]]){
    const now=Date.parse(stamp);assert.equal(C.windowState(now,'Asia/Baghdad',range).open,open);assert.equal(P.insideWindow(P.dateParts(now,'Asia/Baghdad').minutes,range),open);
  }
});
test('foreground immediately closes a window passed while background timers were frozen',async()=>{
  const f=fixture(at('14:10:00'));await f.ctl.start();assert.equal(f.value.open,true);await f.jump(at('14:31:00'));const refresh=f.ctl.foreground();assert.equal(f.value.open,false);await refresh;assert.equal(f.value.open,false);f.ctl.stop();
});
test('manager schedule changes appear at the five-minute refresh',async()=>{
  const f=fixture();await f.ctl.start();f.setSchedule({from:'14:10',to:'14:30'});await f.advance(at('14:00:00'));assert.equal(f.loads,2);assert.equal(f.value.open,false);assert.equal(f.value.remaining,600);f.ctl.stop();
});
test('foreground reloads a changed schedule immediately and concurrent refreshes are deduplicated',async()=>{
  const f=fixture(at('14:10:00'));await f.ctl.start();f.setSchedule({from:'15:00',to:'15:30'});await Promise.all([f.ctl.foreground(),f.ctl.foreground()]);assert.equal(f.loads,2);assert.equal(f.value.open,false);f.ctl.stop();
});
