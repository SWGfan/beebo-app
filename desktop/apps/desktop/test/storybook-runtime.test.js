const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const runtime=require('../electron/storybookRuntime');
const pkg=require('../package.json');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'beebo-voice-test-'));t.after(()=>{assert.equal(path.dirname(dir),os.tmpdir());assert(path.basename(dir).startsWith('beebo-voice-test-'));fs.rmSync(dir,{recursive:true,force:true});});return dir;}
test('Clean installed library is writable and upgrades preserve custom stories and names',t=>{
 const base=fixture(t),res=path.join(base,'resources'),user=path.join(base,'user');
 fs.mkdirSync(path.join(res,'storybooks','dragon'),{recursive:true});
 fs.writeFileSync(path.join(res,'storybooks','index.json'),JSON.stringify({books:[{slug:'dragon',title:'Original'}]}));
 fs.writeFileSync(path.join(res,'storybooks','dragon','template.json'),'original');
 const data={},store={get:k=>data[k],set:(k,v)=>data[k]=v};
 const root=runtime.ensureLibrary({store,userData:user,resourcesPath:res,appDir:base});
 assert.equal(root,path.join(user,'storybooks'));assert.equal(data.storybooksPath,root);
 fs.writeFileSync(path.join(root,'dragon','template.json'),'user-edited');
 fs.writeFileSync(path.join(root,'index.json'),JSON.stringify({books:[{slug:'custom'},{slug:'dragon'}]}));
 fs.mkdirSync(path.join(root,'dragon','audio','names'),{recursive:true});fs.writeFileSync(path.join(root,'dragon','audio','names','voice.mp3'),'keep');
 runtime.ensureLibrary({store,userData:user,resourcesPath:res,appDir:base});
 assert.equal(fs.readFileSync(path.join(root,'dragon','template.json'),'utf8'),'user-edited');
 assert.equal(JSON.parse(fs.readFileSync(path.join(root,'index.json'))).books[0].slug,'custom');
 assert(fs.existsSync(path.join(root,'dragon','audio','names','voice.mp3')));
});
test('Workers must be real external files, Python arguments remain separate, and bundled ffmpeg is preferred',t=>{
 const base=fixture(t),res=path.join(base,'resources'),electron=path.join(base,'app.asar','electron');
 fs.mkdirSync(path.join(electron,'beebobook'),{recursive:true});fs.writeFileSync(path.join(electron,'beebobook','say.py'),'pass');
 assert.throws(()=>runtime.workerPath('say.py',res,electron),/missing/);
 fs.mkdirSync(path.join(res,'beebobook'),{recursive:true});fs.writeFileSync(path.join(res,'beebobook','say.py'),'pass');
 assert.equal(runtime.workerPath('say.py',res,electron),path.join(res,'beebobook','say.py'));
 fs.writeFileSync(path.join(base,'python-cmd.json'),JSON.stringify({cmd:'C:/A Folder/python.exe',args:['-u']}));
 assert.deepEqual(runtime.pythonCommand(base),{cmd:'C:/A Folder/python.exe',args:['-u']});
 fs.mkdirSync(path.join(res,'ffmpeg'));fs.writeFileSync(path.join(res,'ffmpeg','ffmpeg.exe'),'exe');
 const env=runtime.workerEnvironment(res,base),key=Object.keys(env).find(k=>k.toLowerCase()==='path');
 assert(env[key].startsWith(path.join(res,'ffmpeg')));assert.equal(env.PYTHONUTF8,'1');
});
test('Installer includes only original book templates and external workers; voice choices have a strict allowlist',()=>{
 // fairytale/scenes/*.png: the one book whose illustrations ship (commit 1c2209a, 2026-09-14) - only that book's art, never every scenes/ or anim/ folder.
 assert.deepEqual(pkg.build.extraResources.find(x=>x.to==='storybooks').filter,['index.json','*/template.json','fairytale/scenes/*.png']);
 assert(pkg.build.extraResources.some(x=>x.to==='beebobook'&&x.filter.includes('*.py')));
 assert.equal(runtime.ENGLISH_VOICES.size,28);
 for(const value of ['..','../secret','a/b','a\\b','.','']) assert.equal(runtime.safeSegment(value),null);
 assert.equal(runtime.safeSegment('magicschool'),'magicschool');
});
