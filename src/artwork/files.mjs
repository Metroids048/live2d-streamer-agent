import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, readFile, rename, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export function relativePath(value) {
  if(typeof value!=='string'||!value||path.isAbsolute(value)||value.includes('\\')||value.includes(':')||value.split('/').some(s=>!s||s==='.'||s==='..'))throw new Error('ARTWORK_PATH_INVALID');return value;
}
export async function safePath(root,relative,{mkdirParents=false}={}) {
  relativePath(relative);const base=await realpath(root),parts=relative.split('/');let current=base;
  for(let i=0;i<parts.length;i++) {current=path.join(current,parts[i]);let stat;try{stat=await lstat(current);}catch(e){if(e.code!=='ENOENT')throw e;}
    if(stat?.isSymbolicLink())throw new Error('ARTWORK_SYMLINK_REJECTED');
    if(i<parts.length-1){if(!stat&&mkdirParents)await mkdir(current);else if(!stat||!stat.isDirectory())throw new Error('ARTWORK_PARENT_INVALID');}
  }
  return current;
}
export async function writeBound(root,relative,bytes) {
  const target=await safePath(root,relative,{mkdirParents:true}),temp=`${target}.${randomUUID()}.tmp`;
  try{await writeFile(temp,bytes,{flag:'wx',mode:0o600});await rename(temp,target);}finally{await rm(temp,{force:true});}return target;
}
export const writeJson = (root,relative,value) => writeBound(root,relative,JSON.stringify(value,null,2)+'\n');
export async function readJson(root,relative) { try{return JSON.parse(await readFile(await safePath(root,relative),'utf8'));}catch(e){if(e.code==='ENOENT'||e.message==='ARTWORK_PARENT_INVALID')return null;throw e;} }
export async function artifact(root,relative,role) {const b=await readFile(await safePath(root,relative));return {role,path:relative,sha256:sha256(b),bytes:b.length};}
