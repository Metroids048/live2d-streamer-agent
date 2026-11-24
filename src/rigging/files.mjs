import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {RigError} from './engine.mjs';

export const digest=b=>createHash('sha256').update(b).digest('hex');
export const identityKeys=['taskId','candidateId','revision','parentRevision','inputSha256','descriptionSha256'];
export async function safePath(root,relative) {
  if(typeof relative!=='string'||!relative||path.isAbsolute(relative)||relative.includes('\\')||relative.split('/').some(s=>s==='.'||s==='..'||!s))throw new RigError('ARTIFACT_PATH_INVALID',String(relative));
  const base=await fs.realpath(root),file=await fs.realpath(path.join(base,relative));
  if(!file.startsWith(base+path.sep))throw new RigError('ARTIFACT_OUTSIDE_TASK',relative);
  return file;
}
export async function artifact(root,role,relative) {
  const file=await safePath(root,relative),b=await fs.readFile(file);if(!b.length)throw new RigError('ARTIFACT_EMPTY',relative);
  return {role,path:relative,sha256:digest(b),bytes:b.length};
}
export async function verifyArtifacts(root,artifacts) {
  if(!Array.isArray(artifacts)||!artifacts.length)throw new RigError('RIG_REVIEW_NOT_READY','缺少真实产物清单');
  const paths=new Set();
  for(const a of artifacts) {
    if(paths.has(a.path))throw new RigError('ARTIFACT_PATH_DUPLICATE',a.path);paths.add(a.path);
    const actual=await artifact(root,a.role,a.path);
    if(actual.sha256!==a.sha256||actual.bytes!==a.bytes)throw new RigError('ARTIFACT_HASH_MISMATCH',a.path);
  }
}
