import json
from pathlib import Path
root=Path(__file__).resolve().parents[1]
valid="auth != null && auth.token.version != null && auth.token.version >= 1 && root.child('access').child(auth.uid).child('enabled').val() === true && root.child('access').child(auth.uid).child('version').isNumber() && root.child('access').child(auth.uid).child('version').val() >= 1 && auth.token.version === root.child('access').child(auth.uid).child('version').val()"
seller=f"({valid} && root.child('access').child(auth.uid).child('role').val() === 'seller')"
active="root.child('companies').child($cid).child('info/status').val() === 'active' && root.child('companies').child($cid).child('info/expiresAt').val() > now"
tenant=f"({valid} && {active} && root.child('access').child(auth.uid).child('companyId').val() === $cid)"
manager=f"({tenant} && root.child('access').child(auth.uid).child('role').val() === 'manager')"
employee=f"({tenant} && root.child('access').child(auth.uid).child('role').val() === 'employee' && (root.child('companies').child($cid).child('employees').child(root.child('access').child(auth.uid).child('employeeId').val()).child('status').val() === 'approved' || root.child('companies').child($cid).child('employees').child(root.child('access').child(auth.uid).child('employeeId').val()).child('status').val() === 'pending_activation'))"
own="root.child('access').child(auth.uid).child('employeeId').val()"
read=f"({seller} || {manager})"
qown=f"({employee} && query.orderByChild === 'empId' && query.equalTo === {own} && query.limitToLast != null && query.limitToLast <= 200)"
string="newData.isString() && newData.val().length <= 2000"
safe_text={'.validate':string}
company={
 'info':{'.read':f'{read} || {employee}', '.write':False},
 'settings':{'.read':f'{read} || {employee}', '.write':manager},
 'warehouses':{'.read':f'{read} || {employee}', '$wid':{'.write':manager,'pin':{'.validate':False},'$other':{'.validate':'newData.isString() || newData.isNumber() || newData.isBoolean() || newData.hasChildren()'}}},
 'employees':{'.read':read,'.indexOn':['empId','status'], '$eid':{
  '.read':f"{employee} && $eid === {own}", '.write':f'{manager} && data.exists() && newData.exists()',
  '.validate':"newData.hasChildren(['name','empId','warehouseId','status']) && newData.child('empId').val() === data.child('empId').val() && newData.child('credId').val() === data.child('credId').val() && newData.child('deviceFingerprint').val() === data.child('deviceFingerprint').val() && newData.child('createdAt').val() === data.child('createdAt').val()",
  'empId':{'.validate':"newData.val() === data.val()"},
  'credId':{'.validate':"newData.val() === data.val()"},
  'deviceFingerprint':{'.validate':"newData.val() === data.val()"},
  'createdAt':{'.validate':"newData.val() === data.val()"},
  'name':safe_text,'role':safe_text,'warehouseId':safe_text,'warehouseName':safe_text,
  'salary':{'.validate':False},
  'deductionPercent':{'.validate':False},
  'status':{'.validate':"newData.val() === 'approved' || newData.val() === 'rejected' || newData.val() === 'pending_activation'"},
  'schedule':{'.validate':'newData.hasChildren()'},'$other':{'.validate':False}
 }},
 'private_messages':{'.read':read,'.write':manager},
 'adjustments':{'.read':read,'.write':False},
 'records':{'.read':f"{seller} || ({manager} && query.limitToFirst != null && query.limitToFirst <= 1000) || ({manager} && query.limitToLast != null && query.limitToLast <= 1000) || {qown}",'.indexOn':['empId','timestamp','locStatus','dateKey'],'$rid':{
  '.validate':"newData.hasChildren(['empId','timestamp','type','lat','lng','locStatus']) && newData.child('lat').val() === data.child('lat').val() && newData.child('lng').val() === data.child('lng').val() && newData.child('delayMins').val() === data.child('delayMins').val() && newData.child('warehouseId').val() === data.child('warehouseId').val() && newData.child('actor').val() === data.child('actor').val()",
  '.write':False,
  '$field':{'.validate':"($field === 'locStatus' && (newData.val() === 'approved' || newData.val() === 'rejected' || newData.val() === 'pending')) || ($field === 'locNote' && newData.isString() && newData.val().length <= 1000) || newData.val() === data.val()"}
 }},
 'today':{'.read':read,'$eid':{'.read':f'{employee} && $eid === {own}', '.write':False}},
 'missions':{'.read':f'{read} || {qown}', '.indexOn':['empId','status','date'], '$id':{'.write':manager,'.validate':"newData.hasChildren(['empId','date','status'])"}},
 'todayPartialLeave':{'.read':read,'$eid':{'.read':f'{employee} && $eid === {own}', '.write':manager}},
 'partialLeaveRecords':{'.read':read,'$eid':{'.read':f'{employee} && $eid === {own}', '.write':False}},
 'notifications':{
  'admin':{'.read':read, '.write':manager, '.indexOn':['read']},
  '$eid':{'.read':f"{read} || ({employee} && $eid === {own})",'.write':manager,'$nid':{
   '.write':f"{employee} && $eid === {own} && data.exists() && (!newData.exists() || newData.child('read').val() === true)",
   '$field':{'.validate':"$field === 'read' ? newData.isBoolean() : newData.val() === data.val()"}
  }}
 }
}
company['excuses']={'.read':f'{read} || {qown}', '.indexOn':['empId','status','date'], '.write':False}
for name in ['leaves']:
 company[name]={'.read':f'{read} || {qown}', '.indexOn':['empId','status','date'],'$id':{'.write':f'{manager} && data.exists() && newData.exists()', '$field':{'.validate':"$field === 'status' ? (newData.val() === 'approved' || newData.val() === 'rejected' || newData.val() === 'pending') : (($field === 'adminNote' || $field === 'approvedAt' || $field === 'rejectedAt') ? (newData.isString() || newData.isNumber()) : newData.val() === data.val())"}}}
rules={'.read':False,'.write':False,
 'companies':{'.read':seller,'$cid':company},
 'privatePayroll':{'$cid':{'.read':read,'.write':False}},
 'seller':{'.read':seller, 'transactions':{'.write':seller},'notifications':{'.write':seller},'$other':{'.write':False}},
 'audit':{'.read':seller,'.write':False},
 'access':{'.read':False,'.write':False},
 'credentials':{'.read':False,'.write':False},
 'attendanceLedger':{'.read':False,'.write':False},
 '$other':{'.read':False,'.write':False}}
(root/'database.rules.json').write_text(json.dumps({'rules':rules},ensure_ascii=False,indent=2)+'\n')
