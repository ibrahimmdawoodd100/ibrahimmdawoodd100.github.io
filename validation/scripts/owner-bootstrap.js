'use strict';
const fs=require('node:fs');
const {password}=require('../functions/policy');
async function bootstrapOwner({auth,db,email,output}){
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email||''))throw Error('Valid owner email required.');
  // Reserve a private checkpoint BEFORE any remote mutation. Never overwrite credentials.
  fs.writeFileSync(output,JSON.stringify({status:'pending',username:email}),{flag:'wx',mode:0o600});
  let user,credentials;
  const save=value=>fs.writeFileSync(output,JSON.stringify(value,null,2),{mode:0o600});
  try{
    const secret=password();
    user=await auth.createUser({email,password:secret,disabled:true});
    credentials={status:'pending',uid:user.uid,username:email,password:secret,role:'seller'};
    save(credentials);
    await auth.setCustomUserClaims(user.uid,{version:1});
    await db.ref(`access/${user.uid}`).set({role:'seller',enabled:false,version:1,createdAt:Date.now()});
    await auth.updateUser(user.uid,{disabled:false});
    await db.ref(`access/${user.uid}/enabled`).set(true);
    save({...credentials,status:'ready'});
    return user.uid;
  }catch(error){
    let recoveryRequired=false;
    if(user){
      try{await db.ref(`access/${user.uid}`).remove();}catch{recoveryRequired=true;}
      try{await auth.deleteUser(user.uid);}catch{recoveryRequired=true;try{await auth.updateUser(user.uid,{disabled:true});}catch{}}
    }
    if(recoveryRequired)save({...credentials,status:'recovery-required'});
    else fs.unlinkSync(output);
    throw Error(recoveryRequired?'Bootstrap interrupted. Private checkpoint retained; inspect Auth and access before retrying.':`Bootstrap failed; newly created account rolled back: ${error.code||'operation-failed'}`);
  }
}
module.exports={bootstrapOwner};
