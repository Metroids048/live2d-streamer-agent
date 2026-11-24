import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {digest,json,regular,reject} from './files.mjs';
import {Fault} from '../rpc.mjs';

const execute=promisify(execFile);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const mismatch=()=>reject('ENGINE_BUILD_MISMATCH','包内工程重开的冻结运行参数、组件或候选身份不符。');
async function pinnedFile(file,sha256) {
  if(typeof file!=='string'||!path.isAbsolute(file)||!(/^[a-f0-9]{64}$/).test(sha256??''))mismatch();
  if(!(await fs.lstat(file)).isFile()||await fs.realpath(file)!==file)mismatch();
  const record=await digest(file);if(record.sha256!==sha256)mismatch();return record;
}

// Accept prepareRigRuntime's result or a frozen on-disk runtime descriptor.
// Do not fall back to the global runtime when an explicit pin is invalid.
async function pinnedRuntime(pin,manifest) {
  try {
    for(const key of ['taskId','candidateId','revision','parentRevision','inputSha256','descriptionSha256'])
      if(Object.hasOwn(pin,key)&&pin[key]!==manifest[key])mismatch();
    const argsFile=pin.argsFile,argsSha256=pin.argsSha256;
    const args=await pinnedFile(argsFile,argsSha256),bytes=await fs.readFile(argsFile);
    if(hash(bytes)!==argsSha256)mismatch();
    let patch=pin.engineRuntimePatch,record;
    const runtimeManifest=pin.runtimeManifest,runtimeManifestSha256=pin.runtimeManifestSha256;
    if(runtimeManifest!==undefined||runtimeManifestSha256!==undefined) {
      record=await pinnedFile(runtimeManifest,runtimeManifestSha256);
      const data=await fs.readFile(runtimeManifest);if(hash(data)!==runtimeManifestSha256)mismatch();
      const stored=JSON.parse(data);if(patch&&JSON.stringify(patch)!==JSON.stringify(stored))mismatch();patch=stored;
    }
    if(!Array.isArray(patch?.runtimeComponents)||!patch.runtimeComponents.length)mismatch();
    const components=patch.runtimeComponents.map(c=>({path:c.path,sha256:c.sha256}));
    if(new Set(components.map(c=>c.path)).size!==components.length)mismatch();
    if(pin.runtimeComponents&&JSON.stringify(pin.runtimeComponents.map(c=>({path:c.path,sha256:c.sha256})))!==JSON.stringify(components))mismatch();
    // The generated JVM argument files use one quoted argument per line. Keep
    // their exact bytes; reject indirect argfiles or an unrecorded classpath.
    const tokens=bytes.toString('utf8').trim().split(/\r?\n/).map(line=>{
      const match=/^"([^"\\]*)"$|^([^\s"'\\]+)$/.exec(line.trim());if(!match)mismatch();return match[1]??match[2];
    });
    const cp=tokens.indexOf('-cp');
    if(cp!==tokens.length-3||tokens.at(-1)!=='io.github.psd2live.MainKt'||
      tokens.some(t=>t.startsWith('@'))||tokens.slice(0,cp).some(t=>!t.startsWith('-'))||
      JSON.stringify(tokens[cp+1].split(path.delimiter))!==JSON.stringify(components.map(c=>c.path)))mismatch();
    const checked=[];for(const c of components)checked.push({file:path.basename(c.path),...await pinnedFile(c.path,c.sha256)});
    return {bytes,evidence:{mode:'pinned',args,components:checked,...(record?{manifest:record}:{})},
      verify:async()=>{
        await pinnedFile(argsFile,argsSha256);
        if(record)await pinnedFile(runtimeManifest,runtimeManifestSha256);
        for(const c of components)await pinnedFile(c.path,c.sha256);
      }};
  } catch(e) {if(e.code==='ENGINE_BUILD_MISMATCH')throw e;mismatch();}
}
// Reopen only the project extracted from the exact ZIP; no assets from the job
// are present in this fresh editor working directory.
export async function reopenEditable(root,clean,manifest,{signal,pinnedRuntime:pin}={}) {
  signal?.throwIfAborted();
  const runtime=pin===undefined?null:await pinnedRuntime(pin,manifest);
  const run=path.join(root,'.local/tools/psd2live/build/run');
  const java=(await fs.readFile(path.join(run,'java'),'utf8')).trim();
  const scratch=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'hachi-reopen-')));
  try {
    const original=await regular(clean,manifest.projectPath), project=path.join(scratch,'character.psd2live');
    await fs.copyFile(original,project);
    const name=path.basename(manifest.modelPath,'.model3.json'), output=path.join(scratch,'export');
    const argsFile=runtime?path.join(scratch,'runtime-pinned.args'):path.join(run,'jvm.args');
    if(runtime)await fs.writeFile(argsFile,runtime.bytes,{flag:'wx',mode:0o600});
    const started=Date.now();
    try {
      await execute(java,['@'+argsFile,'export',project,'--target','moc3','--output',output,'--name',name],
        {cwd:scratch,timeout:120000,signal,maxBuffer:8*1024*1024});
    } catch(e) {
      if(signal?.aborted)throw e;
      const stderr=String(e.stderr??'').slice(-4096).replace(/((?:token|password|secret|authorization)\s*[=:]\s*)[^\s]+/gi,'$1[redacted]');
      const error=new Fault('CLEAN_REOPEN_FAILED','PSD2Live 未能在空目录从包内工程重新导出。',{
        operation:'clean_project_reopen_and_export',elapsedMs:Date.now()-started,timeoutMs:120000,
        exitCode:e.code??null,signal:e.signal??null,killed:e.killed===true,stderr,
      });
      Object.assign(error,{stage:'packaging',retryable:false});
      throw error;
    }
    const sources=[[clean,manifest.modelPath],[output,name+'.model3.json']];
    const hashes=await Promise.all(sources.map(async ([base,index])=>{
      const refs=(await json(base,index)).FileReferences;
      if(!refs?.Moc||!refs.Textures?.length)reject('CLEAN_REOPEN_FAILED','重开前后缺少运行几何或贴图。');
      return Promise.all([refs.Moc,...refs.Textures].map(async rel=>digest(await regular(path.join(base,path.dirname(index)),rel))));
    }));
    if(hashes[0].length!==hashes[1].length||hashes[0].some((a,i)=>a.sha256!==hashes[1][i].sha256||a.bytes!==hashes[1][i].bytes))
      reject('CLEAN_REOPEN_MISMATCH','从包内工程重新导出的模型几何或贴图与运行包不一致。');
    if(runtime)await runtime.verify();
    return {status:'passed',engine:'PSD2Live 3.6.7',operation:'clean_project_reopen_and_export',project:await digest(original),
      moc:hashes[0][0],textures:hashes[0].slice(1),...(runtime?{runtime:runtime.evidence}:{})};
  } finally {await fs.rm(scratch,{recursive:true,force:true});}
}
