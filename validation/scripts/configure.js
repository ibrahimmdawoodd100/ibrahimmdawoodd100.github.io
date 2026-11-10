'use strict';
// Public deployment values only; never asks for passwords, tokens or private keys.
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline/promises'),vm=require('node:vm');
async function main(){
  const rl=readline.createInterface({input:process.stdin,output:process.stdout});
  try{
    const current={window:{}};vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../public/assets/config.js'),'utf8'),current,{timeout:1000});
    const defaults=current.window.BASMA_CONFIG||{};
    const ask=async (label,value='')=>{if(value==='REPLACE_ME')value='';return (await rl.question(label+(value?' ['+value+']':'')+': ')).trim()||value;};
    const projectId=await ask('projectId',defaults.firebase?.projectId),apiKey=await ask('apiKey',defaults.firebase?.apiKey),appId=await ask('appId',defaults.firebase?.appId),databaseURL=await ask('databaseURL',defaults.firebase?.databaseURL),authDomain=await ask('authDomain',defaults.firebase?.authDomain),siteKey=await ask('Fraud Defense (reCAPTCHA Enterprise) PUBLIC site key',defaults.appCheckSiteKey),bucket=await ask('Private backup bucket name (without gs://)');
    if(!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId))throw Error('Invalid projectId');
    if(!/^AIza[\w-]+$/.test(apiKey)||!/^1:\d+:web:[a-z\d]+$/i.test(appId))throw Error('Invalid Firebase web configuration');
    if(authDomain!==`${projectId}.firebaseapp.com`||databaseURL!==`https://${projectId}-default-rtdb.firebaseio.com`)throw Error('Use the selected project default RTDB in us-central1; copy its exact URL.');
    if(!/^[\w-]{20,}$/.test(siteKey)||! /^[a-z0-9][a-z0-9.-]{2,220}$/.test(bucket))throw Error('Invalid site key / bucket name');
    const root=path.resolve(__dirname,'..');
    fs.writeFileSync(path.join(root,'public/assets/config.js'),'window.BASMA_CONFIG = '+JSON.stringify({firebase:{projectId,apiKey,appId,databaseURL,authDomain},appCheckSiteKey:siteKey,region:'us-central1'},null,2)+';\n');
    fs.writeFileSync(path.join(root,`functions/.env.${projectId}`),`WEBAUTHN_RP_ID=ibrahimmdawoodd100.github.io\nWEBAUTHN_ORIGINS=https://ibrahimmdawoodd100.github.io\nBACKUP_BUCKET=${bucket}\n`,{mode:0o600});
    fs.writeFileSync(path.join(root,'.cloud-shell.env'),`export BASMA_PROJECT_ID='${projectId}'\nexport BASMA_DATABASE_URL='${databaseURL}'\nexport BASMA_BACKUP_BUCKET='${bucket}'\n`,{mode:0o600});
    console.log('Configured public/assets/config.js, functions/.env.'+projectId+' and .cloud-shell.env');
  }finally{rl.close();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
