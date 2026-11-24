import * as fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Fault} from '../rpc.mjs';

export async function taskFile(root,relative) {
  if(typeof relative!=='string'||!relative||relative.includes('\\')||relative.includes('\0')||path.isAbsolute(relative)||
    relative.split('/').some(p=>!p||p==='.'||p==='..'||p==='.local'||p==='.env')||/^[A-Za-z]+:/.test(relative))
    throw new Fault('REFERENCE_INVALID','文件引用必须位于taskRoot内');
  const file=path.resolve(root,relative),real=await fs.realpath(file);
  if(real!==root&&!real.startsWith(root+path.sep))throw new Fault('REFERENCE_INVALID','拒绝越界软链接');
  if(!(await fs.stat(real)).isFile())throw new Fault('REFERENCE_INVALID','引用不是普通文件');
  return real;
}

export async function digest(file) {
  const h=createHash('sha256');for await(const b of createReadStream(file))h.update(b);
  return h.digest('hex');
}

export async function artifact(root,relative,role) {
  const file=await taskFile(root,relative),bytes=(await fs.stat(file)).size;
  if(bytes===0)throw new Fault('REFERENCE_INVALID','拒绝空产物');
  return {role,path:relative,sha256:await digest(file),bytes};
}

export async function verifyArtifacts(root,artifacts) {
  if(!Array.isArray(artifacts))throw new Fault('REFERENCE_INVALID','缺少父版artifact清单');
  const paths=new Set();
  for(const a of artifacts) {
    if(paths.has(a.path))throw new Fault('REFERENCE_INVALID','父版产物路径重复');paths.add(a.path);
    const actual=await artifact(root,a.path,a.role);
    if(actual.sha256!==a.sha256||actual.bytes!==a.bytes)throw new Fault('REFERENCE_INVALID','父版产物已变更');
  }
}

export async function writeJson(file,value,{exclusive=false}={}) {
  // The parent has already been created and checked by buildDynamics.
  const bytes=JSON.stringify(value,null,2)+'\n';
  const temporary=file+'.'+randomUUID()+'.tmp';
  try {
    await fs.writeFile(temporary,bytes,{flag:'wx'});
    if(exclusive)await fs.link(temporary,file);
    else await fs.rename(temporary,file);
  }
  finally {await fs.rm(temporary,{force:true});}
}

export async function listFiles(directory) {
  const result=[];
  for(const entry of await fs.readdir(directory,{withFileTypes:true})) {
    const file=path.join(directory,entry.name);
    if(entry.isSymbolicLink())throw new Fault('REFERENCE_INVALID','导出结果不得包含软链接');
    if(entry.isDirectory())result.push(...await listFiles(file));
    else if(entry.isFile())result.push(file);
    else throw new Fault('REFERENCE_INVALID','不支持的导出文件类型');
  }
  return result.sort();
}

export function relativePath(root,file) {return path.relative(root,file).split(path.sep).join('/');}

export async function sameJson(file,value) {
  try {await writeJson(file,value,{exclusive:true});}
  catch(e) {if(e.code!=='EEXIST')throw e;
    if(await fs.realpath(file)!==file||JSON.stringify(JSON.parse(await fs.readFile(file,'utf8')))!==JSON.stringify(value))
      throw new Fault('DYNAMICS_CHECKPOINT_CHANGED','同一候选的恢复文件与本次输入不符');}
}
