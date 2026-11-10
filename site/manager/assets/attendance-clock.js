'use strict';
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.BasmaClock=factory();})(typeof window==='object'?window:globalThis,()=>{
  function parts(now,zone){
    const p=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(now).map(x=>[x.type,x.value]));
    return {date:`${p.year}-${p.month}-${p.day}`,seconds:Number(p.hour)*3600+Number(p.minute)*60+Number(p.second)};
  }
  function seconds(value){if(!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value||''))throw Error('جدول الدوام غير صالح');return Number(value.slice(0,2))*3600+Number(value.slice(3))*60;}
  function windowState(now,zone,range){
    const at=parts(now,zone).seconds,from=seconds(range?.from),to=seconds(range?.to);
    if(from===to)throw Error('بداية النافذة ونهايتها متطابقتان');
    const open=from<to?at>=from&&at<to:at>=from||at<to;
    const remaining=((open?to:from)-at+86400)%86400||86400;
    return {open,remaining,nextMs:remaining*1000-(now%1000),label:open?`مفتوح؛ يغلق بعد ${duration(remaining)}`:`يبدأ بعد ${duration(remaining)}`};
  }
  function duration(seconds){return `${Math.floor(seconds/3600).toString().padStart(2,'0')}:${Math.floor(seconds%3600/60).toString().padStart(2,'0')}:${Math.floor(seconds%60).toString().padStart(2,'0')}`;}
  function controller({now,load,render,onError=()=>{},timers=globalThis}){
    let state=null,pending=null,boundary=null,tick=null,refreshTimer=null,started=false,generation=0;
    function evaluate(){
      if(!started)return;
      if(boundary!==null)timers.clearTimeout(boundary);
      let next=60000;
      try{next=render(state,now())||next;}catch(error){onError(error);}
      boundary=timers.setTimeout(evaluate,Math.max(1,next));
    }
    function refresh(){
      if(pending)return pending;
      const current=generation;
      pending=(async()=>{try{const value=await load();if(started&&current===generation)state=value;}catch(error){if(current===generation){state=null;onError(error);}}finally{pending=null;evaluate();}})();
      return pending;
    }
    function start(){if(started)return refresh();started=true;generation++;evaluate();tick=timers.setInterval(evaluate,1000);refreshTimer=timers.setInterval(refresh,300000);return refresh();}
    function foreground(){evaluate();return refresh();}
    function stop(){started=false;generation++;timers.clearInterval(tick);timers.clearInterval(refreshTimer);timers.clearTimeout(boundary);state=null;}
    return {start,stop,refresh,evaluate,foreground};
  }
  return {parts,seconds,windowState,controller};
});
