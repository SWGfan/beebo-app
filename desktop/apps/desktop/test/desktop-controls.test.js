const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const auth = require('../electron/auth')
const rm = require('../electron/remoteMembers')
const { clearUploadHistory } = require('../electron/uploadHistory')
const store = () => { const data={}; return { get:k=>data[k], set:(k,v)=>{data[k]=v}, delete:k=>{delete data[k]} } }
test('history clear keeps videos, new history and all other library state',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'beebo-history-')), video=path.join(dir,'sample.mp4')
 try {
  fs.writeFileSync(video,'unchanged sample content');const s=store()
  s.set('uploadHistory',[{id:'old',destPath:video},{id:'new',destPath:video}]);s.set('recentlyAdded',[{path:video}])
  assert.deepEqual(clearUploadHistory(s,['old']),{ok:true,removed:1})
  assert.equal(fs.readFileSync(video,'utf8'),'unchanged sample content')
  assert.deepEqual(s.get('uploadHistory').map(e=>e.id),['new']);assert.equal(s.get('recentlyAdded').length,1)
  assert.throws(()=>clearUploadHistory(s,null));assert.equal(s.get('uploadHistory').length,1)
 } finally {fs.rmSync(dir,{recursive:true,force:true})}
})
test('bulk allows approved users only and preserves existing credentials and parental controls',()=>{
 const s=store();const a=auth.createUser(s,'Alice','').user,b=auth.createUser(s,'Bob','').user,c=auth.createUser(s,'Cora','').user
 auth.revokeUser(s,c.id);auth.setUserPassword(s,b.id,'test password');
 const before=auth.getUsers(s).find(u=>u.id===b.id).passwordHash
 s.set('authUsers',auth.getUsers(s).map(u=>({...u,parental:{blocked:['one']}})))
 const r=auth.enableAllRemoteAccess(s);assert.equal(r.enabled,2);assert.equal(s.get('remoteAccessDefault'),true)
 assert.equal(r.passes.length,0);assert.equal(auth.hasRemoteAccess(auth.getUsers(s).find(u=>u.id===c.id)),false)
 assert.equal(auth.getUsers(s).find(u=>u.id===b.id).passwordHash,before)
 assert.deepEqual(auth.getUsers(s)[0].parental,{blocked:['one']})
 assert.equal(rm.buildMemberList(auth.getUsers(s)).length,2)
 assert.ok(rm.buildMemberList(auth.getUsers(s)).every(m=>m.login_hash))
 const hashes=auth.getUsers(s).map(u=>u.remote?.pw_hash);assert.equal(auth.enableAllRemoteAccess(s).enabled,0)
 assert.deepEqual(auth.getUsers(s).map(u=>u.remote?.pw_hash),hashes)
 const d=auth.createUser(s,'Dave','');assert.ok(auth.hasRemoteAccess(d.user));assert.ok(d.user.remoteLogin)
 auth.clearUserRemoteAccess(s,a.id);auth.reactivateUser(s,a.id);assert.equal(auth.hasRemoteAccess(auth.getUsers(s).find(u=>u.id===a.id)),false)
})
test('new signups get default away access only when approved, with their own password',()=>{
 const s=store();s.set('remoteAccessDefault',true)
 const signup=auth.createSignup(s,{username:'samplekid',email:'sample@example.test',password:'a test password'})
 assert.equal(signup.user.status,'pending_verification');assert.equal(auth.hasRemoteAccess(signup.user),false)
 auth.verifySignupToken(s,signup.token)
 const user=auth.getUsers(s)[0];assert.equal(user.status,'approved');assert.ok(auth.hasRemoteAccess(user));assert.ok(rm.buildMemberList([user])[0].login_hash)
})
