const test=require('node:test')
const assert=require('node:assert/strict')
const http=require('node:http')
const fs=require('node:fs/promises')
const os=require('node:os')
const path=require('node:path')
const crypto=require('node:crypto')
const {createPrivateVault}=require('../electron/privateVault')
const {defaults,initialize}=require('../electron/storageDefaults')
function fixtureEnvelope(){return{version:1,vaultId:crypto.randomUUID(),iterations:600000,salt:crypto.randomBytes(16).toString('base64'),passwordKey:crypto.randomBytes(128).toString('base64'),recoveryKey:crypto.randomBytes(128).toString('base64'),label:crypto.randomBytes(50).toString('base64')}}
test('fresh folders share a root; existing media paths and backup settings are preserved',()=>{
 const data={};const store={get:k=>data[k],set:(k,v)=>data[k]=v};initialize(store,{platform:'win32',createDirectories:false})
 for(const [key,value]of Object.entries(defaults('win32')))if(key!=='root')assert.deepEqual(data[key],value)
 assert.equal(data.inboxDir,'C:\\Beebo\\Video Inbox')
 const old={authUsers:[{id:'owner'}],moviesDir:'D:\\My films',photosDirs:['E:\\Camera'],newFilesDir:'D:\\Incoming'}
 initialize({get:k=>old[k],set:(k,v)=>old[k]=v},{platform:'win32',createDirectories:false})
 assert.equal(old.moviesDir,'D:\\My films');assert.deepEqual(old.photosDirs,['E:\\Camera']);assert.equal(old.newFilesDir,'D:\\Incoming');assert.equal(old.inboxDir,undefined)
})
test('private vault isolates profiles, verifies chunk uploads, and sends only opted-in recovery mail',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'beebo-vault-test-'));const settings={privateVaultDir:root};const store={get:k=>settings[k],set:(k,v)=>settings[k]=v}
 const messages=[];let failNotice=false;let clock=1000000
 const service=createPrivateVault({store,getOwnerEmail:()=> 'owner@example.test',now:()=>clock,mailer:{isConfigured:()=>true,sendMail:async(_,{to,subject,text})=>{messages.push({to,subject,text});return{ok:!(failNotice&&to==='alice@example.test')}}}})
 const users={alice:{id:'a',username:'Alice',email:'alice@example.test',status:'approved'},bob:{id:'b',email:'bob@example.test',status:'approved'},owner:{id:'o',isAdmin:true,status:'approved'},guest:{id:'g',status:'approved',guest:true},revoked:{id:'r',status:'revoked'}}
 const server=http.createServer((req,res)=>{const send=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body))};service.handle(req,res,new URL(req.url,'http://localhost'),users[req.headers['x-test-user']],send)})
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port
 const call=(user,route='',options={})=>fetch(base+'/api/private-vault'+route,{...options,headers:{'X-Test-User':user,...options.headers}})
 const post=(user,route,body)=>call(user,route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
 try{
  assert.equal((await call('guest')).status,403);assert.equal((await call('revoked')).status,403)
  const envelope=fixtureEnvelope();assert.equal((await post('alice','/setup',{envelope})).status,200);assert.equal((await post('alice','/setup',{envelope})).status,409)
  assert.equal(messages.length,0,'setup alone must not email any key')
  const id=crypto.randomUUID();const data=crypto.randomBytes(700000);const sha=crypto.createHash('sha256').update(data).digest('hex');const metadata=crypto.randomBytes(100).toString('base64')
  async function chunk(offset,bytes){return call('alice',`/file?id=${id}&vaultId=${envelope.vaultId}&total=${data.length}&offset=${offset}`,{method:'POST',headers:{'X-Beebo-Vault-Metadata':metadata,'X-Beebo-Vault-Sha256':sha},body:bytes})}
  assert.equal((await chunk(0,data.subarray(0,512*1024))).status,200)
  assert.equal((await call('alice','/file?id='+id)).status,404,'partial upload is never downloadable')
  const saved=await(await chunk(512*1024,data.subarray(512*1024))).json();assert.equal(saved.complete,true)
  assert.deepEqual(Buffer.from(await(await call('alice','/file?id='+id)).arrayBuffer()),data)
  for(const other of ['bob','owner']){assert.equal((await(await call(other)).json()).files.length,0);assert.equal((await call(other,'/file?id='+id)).status,404)}
  assert.equal((await post('alice','/password',{revision:0,envelope})).status,409)
  const reset={...envelope,salt:crypto.randomBytes(16).toString('base64'),passwordKey:crypto.randomBytes(128).toString('base64')}
  assert.equal((await post('alice','/password',{revision:1,envelope:reset})).status,200)
  const consent={consent:false,ownerEmail:'owner@example.test',userEmail:'alice@example.test',recoveryCode:'A'.repeat(64)}
  assert.equal((await post('alice','/recovery-email',consent)).status,400);assert.equal(messages.length,0)
  failNotice=true;assert.equal((await post('alice','/recovery-email',{...consent,consent:true})).status,502);assert.equal(messages.length,1);assert.equal(messages[0].text.includes('A'.repeat(64)),false)
  clock+=60001;failNotice=false
  assert.equal((await post('alice','/recovery-email',{...consent,consent:true})).status,200)
  assert.deepEqual(messages.slice(1).map(m=>m.to),['alice@example.test','owner@example.test','alice@example.test'])
  const record=(await(await call('alice')).json()).record
  assert.equal(record.ownerRecovery.email,'owner@example.test');assert.equal(JSON.stringify(record).includes('A'.repeat(64)),false,'raw recovery key is not persisted')
  assert.equal((await post('alice','/recovery-email',{...consent,consent:true})).status,429)
 }finally{await new Promise(resolve=>server.close(resolve));await fs.rm(root,{recursive:true,force:true})}
})
