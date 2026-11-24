import * as fs from 'node:fs/promises';
import path from 'node:path';
import {Fault} from '../rpc.mjs';
import {artifact,taskFile,verifyArtifacts,writeJson,sameJson} from './files.mjs';

export const identityKeys=['taskId','candidateId','revision','parentRevision','inputSha256','descriptionSha256'];
export async function dynamicsState(bundle,ctx,{allowPrevious=false}={}) {
  if(bundle?.stage!=='dynamics'||bundle.schemaVersion!==1||
    ['taskId','candidateId','revision','parentRevision'].some(k=>bundle[k]!==ctx[k])||
    ['inputSha256','descriptionSha256'].some(k=>ctx[k]!==undefined&&bundle[k]!==ctx[k]))
    throw new Fault('DYNAMICS_IDENTITY_MISMATCH','动态候选及来源必须与上下文一致');
  const root=await fs.realpath(ctx.taskRoot);
  const directory=path.join(root,'dynamics');
  if(await fs.realpath(directory)!==directory)throw new Fault('REFERENCE_INVALID','动态写入目录不得为软链接');
  const current=JSON.parse(await fs.readFile(await taskFile(root,'dynamics/stage.json'),'utf8'));
  if(identityKeys.some(k=>current[k]!==bundle[k]))throw new Fault('DYNAMICS_IDENTITY_MISMATCH','阶段不属于当前候选');
  await verifyArtifacts(root,current.artifacts);await verifyArtifacts(root,bundle.artifacts);
  if(!allowPrevious&&JSON.stringify(current)!==JSON.stringify(bundle))
    throw new Fault('DYNAMICS_STALE_BUNDLE','请重新读取当前阶段；旧版审查不能覆盖后续状态');
  for(const key of ['modelPath','projectPath','dynamicsManifestPath'])if(!current.artifacts.some(a=>a.path===current[key]))
    throw new Fault('REFERENCE_INVALID','关键产物没有可信哈希：'+key);
  const manifest=JSON.parse(await fs.readFile(await taskFile(root,current.dynamicsManifestPath),'utf8'));
  if(identityKeys.some(k=>manifest[k]!==current[k]))throw new Fault('DYNAMICS_IDENTITY_MISMATCH','动态manifest来源不符');
  return {root,current,manifest};
}

// Append immutable manifests/evidence; changing the stage pointer never invalidates old artifact hashes.
export async function commitDynamics(root,bundle,manifest,directory,extraFiles,ctx) {
  const result=structuredClone(bundle),relative=directory+'/dynamics-manifest.json';
  manifest={...manifest,status:result.status,checks:result.checks.filter(c=>c.name.startsWith('dynamics.')),
    warnings:result.warnings,unresolved:result.unresolved};
  await sameJson(path.join(root,relative),manifest);
  result.dynamicsManifestPath=relative;
  for(const file of [...extraFiles,relative])if(!result.artifacts.some(a=>a.path===file))
    result.artifacts.push(await artifact(root,file,file===relative?'dynamics-manifest':'dynamics-evidence'));
  await writeJson(path.join(root,'dynamics/stage.json'),result);
  await ctx.checkpoint?.({stage:'dynamics',status:result.status,bundle:result});return result;
}
