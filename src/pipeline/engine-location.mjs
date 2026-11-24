import * as fs from 'node:fs/promises';
import path from 'node:path';
import {Fault} from '../rpc.mjs';

import {archivedRig,fitProfile,rigRepairProfiles} from './reviewed-rig-repair.mjs';
import {identityKeys} from '../rigging/files.mjs';

const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export function imageEngineDirectory(root,taskId,candidateId,revision,profile) {
  if(profile!==undefined&&!rigRepairProfiles.includes(profile)||!uuid.test(taskId)||!uuid.test(candidateId)||!Number.isSafeInteger(revision)||revision<1)
    throw new Fault('ENGINE_LEASE_IDENTITY','引擎目录缺少有效的任务与版本身份');
  return path.join(root,'.local','image-engines',taskId,candidateId+'.r'+revision+(profile?'.'+profile:''));
}

async function exists(file) {
  try {await fs.lstat(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}
}
export async function engineLocation(root,job) {
  const legacy={dir:path.join(root,'.local'),args:[]};
  if(job.kind!=='single_image')return legacy;
  const identity={taskId:job.id,candidateId:job.candidateId,revision:job.revision,parentRevision:job.parentRevision??null,
    inputSha256:job.source?.inputSha256,descriptionSha256:job.source?.descriptionSha256};
  const profiles=[];
  for(const profile of rigRepairProfiles) {
    const archive=archivedRig(job.output,profile),old=path.join(archive,'stage.json');
    if(!await exists(archive))continue;
    if(!await exists(old))throw new Fault('ENGINE_LEASE_IDENTITY','旧绑定归档缺少检查点');
    if(await fs.realpath(old)!==old)throw new Fault('ENGINE_LEASE_IDENTITY','旧绑定检查点路径不符');
    const stage=JSON.parse(await fs.readFile(old,'utf8'));
    if(stage.stage!=='rigging'||stage.status!=='blocked'||identityKeys.some(k=>stage[k]!==identity[k])||
      stage.rigReviews?.at(-1)?.status!=='failed'||stage.rigReviews?.at(-1)?.reviewer?.kind!=='model')throw new Fault('ENGINE_LEASE_IDENTITY','旧绑定审查身份不符');
    profiles.push(profile);
  }
  if(profiles.length) {
    let profile=fitProfile;
    const file=path.join(job.output,'rigging/state.json');
    if(await exists(file)) {
      if(await fs.realpath(file)!==file)throw new Fault('ENGINE_LEASE_IDENTITY','绑定运行检查点路径不符');
      const journal=JSON.parse(await fs.readFile(file,'utf8'));
      if(identityKeys.some(k=>journal.identity?.[k]!==identity[k]))throw new Fault('ENGINE_LEASE_IDENTITY','绑定运行检查点身份不符');
      profile=journal.repairProfile;
    }
    if(!profiles.includes(profile))throw new Fault('ENGINE_LEASE_IDENTITY','绑定配方缺少对应返修归档');
    return {dir:imageEngineDirectory(root,job.id,job.candidateId,job.revision,profile),args:[job.id,job.candidateId,String(job.revision),profile]};
  }
  const dir=imageEngineDirectory(root,job.id,job.candidateId,job.revision);
  // An in-flight project created before isolated services must continue on its original server.
  if(!await exists(dir)&&await exists(path.join(job.output,'rigging','state.json')))return legacy;
  return {dir,args:[job.id,job.candidateId,String(job.revision)]};
}
