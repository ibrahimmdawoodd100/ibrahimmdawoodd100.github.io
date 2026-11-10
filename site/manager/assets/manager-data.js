'use strict';
// Shared by the browser and deterministic tests. No persistent/browser storage.
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.BasmaManagerData=api;})(typeof window==='object'?window:globalThis,()=>{
  const stale=()=>Object.assign(new Error('تغيّرت الجلسة أو الشركة؛ أعد تحميل العرض'),{code:'stale-manager-scope'});
  function date(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)throw Error('تاريخ غير صالح');return value;}
  function monthRange(month){if(!/^\d{4}-\d{2}$/.test(month||''))throw Error('اختر الشهر');const from=date(`${month}-01`),[y,m]=month.split('-').map(Number);return {from,to:new Date(Date.UTC(y,m,0)).toISOString().slice(0,10)};}
  async function pages(database,cid,collection,{from,to,status,pageSize=1000,check=()=>{}}={}){
    if(!['leaves','excuses','missions'].includes(collection)||!cid||/[.#$\[\]/]/.test(cid))throw Error('مسار طلب غير صالح');
    const field=status===undefined?'date':'status';
    if(status===undefined){date(from);date(to);if(from>to)throw Error('نطاق غير صالح');}
    else if(!['pending','assigned','started'].includes(status))throw Error('حالة غير صالحة');
    const lower=status??from,upper=status??to,result=Object.create(null);let lastValue,lastKey;
    for(;;){
      check();let query=database.ref(`companies/${cid}/${collection}`).orderByChild(field);
      query=(lastKey===undefined?query.startAt(lower):query.startAfter(lastValue,lastKey)).endAt(upper).limitToFirst(pageSize);
      const snapshot=await query.once('value');check();let count=0,nextValue,nextKey;
      snapshot.forEach(child=>{const value=child.val();if(!value||typeof value!=='object'||value[field]<lower||value[field]>upper)throw Error('استجابة ترقيم غير صالحة');
        if(Object.hasOwn(result,child.key))throw Error('تكرر مؤشر الصفحة؛ لم يكتمل التحميل');
        result[child.key]=value;nextValue=value[field];nextKey=child.key;count++;
      });
      if(count<pageSize)return result;
      if(nextKey===undefined||(nextValue===lastValue&&nextKey===lastKey))throw Error('تعذر تقدم مؤشر الصفحة');
      lastValue=nextValue;lastKey=nextKey;
      if(Object.keys(result).length>200000)throw Error('الفترة كبيرة جدًا؛ اختر فترة أقصر');
    }
  }
  function create(context,{now=()=>typeof performance==='object'?performance.now():Date.now(),baseTTL=300000,periodTTL=60000}={}){
    let scope,epoch=0,scopeEpoch=0,baseCache,periods=new Map();
    function invalidate(){epoch++;baseCache=null;periods.clear();}
    function capture(checkEpoch=true){const next=context();if(!next?.db||!next.cid||!next.session)throw stale();
      if(!scope||scope.db!==next.db||scope.cid!==next.cid||scope.session!==next.session){scope=next;scopeEpoch++;invalidate();}
      const version=epoch,scopeVersion=scopeEpoch,db=next.db,cid=next.cid,session=next.session;
      return {db,cid,check(){const current=context();if(scopeVersion!==scopeEpoch||(checkEpoch&&version!==epoch)||current?.db!==db||current?.cid!==cid||current?.session!==session)throw stale();}};
    }
    function memo(map,key,load,ttl,guard){let entry=map.get(key);if(!entry||now()-entry.at>=ttl){entry={at:now()};entry.promise=Promise.resolve().then(load).catch(error=>{if(map.get(key)===entry)map.delete(key);throw error;});map.set(key,entry);while(map.size>4)map.delete(map.keys().next().value);}return entry.promise.then(value=>{guard();return value;});}
    async function base(){const token=capture();if(!baseCache||now()-baseCache.at>=baseTTL){const entry={at:now()};baseCache=entry;entry.promise=Promise.all(['employees','settings','warehouses'].map(name=>token.db.ref(`companies/${token.cid}/${name}`).once('value'))).then(values=>{token.check();return {employees:values[0].val()||{},settings:values[1].val()||{},warehouses:values[2].val()||{}};}).catch(error=>{if(baseCache===entry)baseCache=null;throw error;});}const value=await baseCache.promise;token.check();return value;}
    async function period(from,to){date(from);date(to);if(from>to)throw Error('نطاق غير صالح');const token=capture();return memo(periods,`${from}/${to}`,async()=>{
      const [leaves,excuses]=await Promise.all(['leaves','excuses'].map(collection=>pages(token.db,token.cid,collection,{from,to,check:token.check})));return {leaves,excuses};
    },periodTTL,token.check);}
    async function requests(collection,month){const range=monthRange(month),token=capture();
      const [history,pending]=await Promise.all([period(range.from,range.to),pages(token.db,token.cid,collection,{status:'pending',check:token.check})]);token.check();
      // Key union: a pending request in the chosen month appears once, and old pending requests remain visible.
      return {...history[collection],...pending};
    }
    return {base,period,requests,capture,invalidate,clear(){scope=null;scopeEpoch++;invalidate();}};
  }
  return {create,pages,monthRange};
});
