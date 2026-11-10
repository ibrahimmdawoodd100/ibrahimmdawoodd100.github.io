'use strict';
// Administrative commands run only on a trusted machine with Application Default Credentials.
const fs = require('node:fs'), path = require('node:path');
const adminRequire = require('node:module').createRequire(path.join(__dirname, '../functions/package.json'));
const { initializeApp, applicationDefault, deleteApp } = adminRequire('firebase-admin/app');
const { getAuth } = adminRequire('firebase-admin/auth');
const { getDatabase } = adminRequire('firebase-admin/database');
const {bootstrapOwner}=require('./owner-bootstrap');
const [command, input, output] = process.argv.slice(2);
let adminApp;
async function main() {
  if (!['bootstrap','backup'].includes(command)) throw Error('Usage: node scripts/admin.js bootstrap EMAIL OUTPUT.json | backup unused OUTPUT.json');
  if (!output || path.resolve(output).startsWith(path.resolve(__dirname,'../public')+path.sep)) throw Error('Credential/backup output must be outside public/.');
  if (fs.existsSync(output)) throw Error('Output already exists; choose a new private file.');
  if (!process.env.BASMA_PROJECT_ID || !process.env.BASMA_DATABASE_URL) throw Error('Set BASMA_PROJECT_ID and BASMA_DATABASE_URL explicitly.');
  adminApp = initializeApp({ credential:applicationDefault(), projectId:process.env.BASMA_PROJECT_ID, databaseURL:process.env.BASMA_DATABASE_URL });
  const auth=getAuth(),db=getDatabase();
  const save=value=>{fs.writeFileSync(output,JSON.stringify(value,null,2),{mode:0o600,flag:'wx'});};
  if(command==='bootstrap') {
    await bootstrapOwner({auth,db,email:input,output});
    console.log('Owner created. Credentials saved to the private output file; not printed.');return;
  }
  if(command==='backup') {
    save({format:'basma-secure-backup-v1',at:new Date().toISOString(),data:(await db.ref().get()).val()});
    console.log('Private backup written. Store encrypted outside the hosting directory.');return;
  }

}
main().catch(error=>{console.error(error.message);process.exitCode=1;}).finally(async()=>{if(adminApp)await deleteApp(adminApp);});
