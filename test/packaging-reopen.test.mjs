import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {reopenEditable} from '../src/packaging/reopen-editor.mjs';

const hash=data=>createHash('sha256').update(data).digest('hex');
// An actual child process implements only the CLI file protocol. These are
// synthetic bytes, not an editor, valid MOC, or native compatibility evidence.
async function fixture(t,{legacyCorrect=false,changeTexture=false,mutateComponent=false,failExport=false}={}) {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'package-reopen-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const run=path.join(root,'.local/tools/psd2live/build/run'),clean=path.join(root,'clean');
  await fs.mkdir(run,{recursive:true});await fs.mkdir(clean);
  const component=path.join(root,'patched-runtime.jar');await fs.writeFile(component,'pinned-component');
  const argsFile=path.join(root,'candidate.args');
  const args='"-Dfile.encoding=UTF-8"\n"-cp"\n"'+component+'"\n"io.github.psd2live.MainKt"\n';
  await fs.writeFile(argsFile,args);
  await fs.writeFile(path.join(run,'jvm.args'),'"legacy-runtime.jar"\n');
  const patch={version:'synthetic-test-runtime',runtimeComponents:[{path:component,sha256:hash('pinned-component')}]};
  const runtimeManifest=path.join(root,'runtime.json');await fs.writeFile(runtimeManifest,JSON.stringify(patch));
  const pinnedRuntime={argsFile,argsSha256:hash(args),engineRuntimePatch:patch};
  const descriptor={argsFile,argsSha256:hash(args),runtimeManifest,runtimeManifestSha256:hash(JSON.stringify(patch))};
  const manifest={taskId:'fixture-task',candidateId:'fixture-candidate',revision:14,parentRevision:13,
    projectPath:'editable/character.psd2live',modelPath:'model/character.model3.json'};
  await fs.mkdir(path.join(clean,'editable'));await fs.mkdir(path.join(clean,'model'));
  await fs.writeFile(path.join(clean,manifest.projectPath),'synthetic-project');
  await fs.writeFile(path.join(clean,manifest.modelPath),JSON.stringify({FileReferences:{Moc:'character.moc3',Textures:['texture.png']}}));
  await fs.writeFile(path.join(clean,'model/character.moc3'),'same-moc');
  await fs.writeFile(path.join(clean,'model/texture.png'),'same-texture');
  const calls=path.join(root,'calls.json'),java=path.join(root,'fake-java.mjs');
  await fs.writeFile(java,'#!'+process.execPath+'\n'+
    'import fs from "node:fs/promises";import path from "node:path";\n'+
    'const config='+JSON.stringify({calls,component,legacyCorrect,changeTexture,mutateComponent,failExport})+';\n'+
    'const argv=process.argv.slice(2),argsFile=argv[0].slice(1),args=await fs.readFile(argsFile,"utf8");\n'+
    'await fs.writeFile(config.calls,JSON.stringify({argv,argsFile,args,cwd:process.cwd(),project:await fs.readFile(argv[2],"utf8")}));\n'+
    'if(config.failExport){process.stderr.write("native export failed: No space left on device token=private-test-value\\n");process.exit(28);}'+'\n'+
    'const output=argv[argv.indexOf("--output")+1],name=argv[argv.indexOf("--name")+1];await fs.mkdir(output,{recursive:true});\n'+
    'await fs.writeFile(path.join(output,name+".model3.json"),JSON.stringify({FileReferences:{Moc:name+".moc3",Textures:["texture.png"]}}));\n'+
    'await fs.writeFile(path.join(output,name+".moc3"),args.includes(config.component)||config.legacyCorrect?"same-moc":"wrong-runtime-moc");\n'+
    'await fs.writeFile(path.join(output,"texture.png"),config.changeTexture?"changed-texture":"same-texture");\n'+
    'if(config.mutateComponent)await fs.writeFile(config.component,"changed-during-export");\n', {mode:0o700});
  await fs.writeFile(path.join(run,'java'),java);
  return {root,clean,run,args,argsFile,component,manifest,patch,pinnedRuntime,descriptor,calls};
}

test('clean reopen uses the frozen candidate runtime instead of the global legacy args',async t=>{
  const f=await fixture(t);
  const result=await reopenEditable(f.root,f.clean,f.manifest,{pinnedRuntime:f.pinnedRuntime});
  assert.equal(result.status,'passed');assert.equal(result.runtime.mode,'pinned');
  assert.equal(result.runtime.args.sha256,f.pinnedRuntime.argsSha256);
  assert.equal(result.runtime.components[0].sha256,f.patch.runtimeComponents[0].sha256);
  const call=JSON.parse(await fs.readFile(f.calls));
  assert.equal(call.args,f.args);assert.notEqual(call.argsFile,f.argsFile);
  assert.equal(path.dirname(call.argsFile),call.cwd);assert.equal(call.project,'synthetic-project');
  assert.notEqual(call.cwd,f.clean);await assert.rejects(fs.access(call.cwd),{code:'ENOENT'});
  assert.equal(await fs.readFile(path.join(f.run,'jvm.args'),'utf8'),'"legacy-runtime.jar"\n');
});

test('clean reopen accepts a frozen manifest descriptor and binds its optional candidate identity',async t=>{
  const f=await fixture(t);
  const result=await reopenEditable(f.root,f.clean,f.manifest,{pinnedRuntime:{...f.descriptor,...f.manifest}});
  assert.equal(result.status,'passed');assert.equal(result.runtime.manifest.sha256,f.descriptor.runtimeManifestSha256);
  assert.equal(result.runtime.components.length,1);
});

for(const defect of ['args','component','manifest','classpath','identity','symlink','missing-components'])
  test('clean reopen rejects pinned '+defect+' drift before starting a process',async t=>{
    const f=await fixture(t,{legacyCorrect:true}),pin=structuredClone(f.descriptor);
    if(defect==='args')await fs.appendFile(f.argsFile,'changed');
    if(defect==='component')await fs.writeFile(f.component,'changed');
    if(defect==='manifest')await fs.appendFile(pin.runtimeManifest,' ');
    if(defect==='identity')pin.candidateId='foreign';
    if(defect==='classpath') {
      const args=f.args.replace(f.component,path.join(f.root,'other.jar'));
      await fs.writeFile(f.argsFile,args);pin.argsSha256=hash(args);
    }
    if(defect==='symlink') {
      const linked=path.join(f.root,'linked.args');await fs.symlink(f.argsFile,linked);pin.argsFile=linked;
    }
    if(defect==='missing-components') {
      delete pin.runtimeManifest;delete pin.runtimeManifestSha256;pin.engineRuntimePatch={runtimeComponents:[]};
    }
    await assert.rejects(reopenEditable(f.root,f.clean,f.manifest,{pinnedRuntime:pin}),{code:'ENGINE_BUILD_MISMATCH'});
    await assert.rejects(fs.access(f.calls),{code:'ENOENT'});
  });

test('clean reopen retains historical runtime behavior when no pin was recorded',async t=>{
  const f=await fixture(t,{legacyCorrect:true});
  assert.equal((await reopenEditable(f.root,f.clean,f.manifest)).status,'passed');
  const call=JSON.parse(await fs.readFile(f.calls));assert.equal(call.argsFile,path.join(f.run,'jvm.args'));
});

test('pinned runtime does not bypass the texture equality check and removes scratch after failure',async t=>{
  const f=await fixture(t,{legacyCorrect:true,changeTexture:true});
  await assert.rejects(reopenEditable(f.root,f.clean,f.manifest,{pinnedRuntime:f.pinnedRuntime}),{code:'CLEAN_REOPEN_MISMATCH'});
  await assert.rejects(fs.access(JSON.parse(await fs.readFile(f.calls)).cwd),{code:'ENOENT'});
});

test('runtime components changing during export cannot produce passed evidence',async t=>{
  const f=await fixture(t,{legacyCorrect:true,mutateComponent:true});
  await assert.rejects(reopenEditable(f.root,f.clean,f.manifest,{pinnedRuntime:f.pinnedRuntime}),{code:'ENGINE_BUILD_MISMATCH'});
  await assert.rejects(fs.access(JSON.parse(await fs.readFile(f.calls)).cwd),{code:'ENOENT'});
});


test('failed clean export retains bounded native diagnostics and cleans its scratch directory',async t=>{
  const f=await fixture(t,{failExport:true});
  await assert.rejects(reopenEditable(f.root,f.clean,f.manifest,{pinnedRuntime:f.pinnedRuntime}),error=>{
    assert.equal(error.code,'CLEAN_REOPEN_FAILED');
    assert.equal(error.stage,'packaging');
    assert.equal(error.details.exitCode,28);
    assert.match(error.details.stderr,/No space left on device/);
    assert.match(error.details.stderr,/token=\[redacted\]/);
    assert(!error.details.stderr.includes('private-test-value'));
    assert(error.details.elapsedMs>=0);
    return true;
  });
  await assert.rejects(fs.access(JSON.parse(await fs.readFile(f.calls)).cwd),{code:'ENOENT'});
});
