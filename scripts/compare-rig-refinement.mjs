// Same-artwork A/B. Owns a disposable editor, never the OpenClaw task or gateway.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {randomBytes} from 'node:crypto';
import {PinnedPsd2Live} from '../src/pipeline/production-engine.mjs';
import {RigSession,writeJson} from '../src/rigging/engine.mjs';
import {applySampledHeadKeys} from '../src/rigging/shared-face.mjs';
import {applyContinuousWave} from '../src/rigging/wave.mjs';
import {digest} from '../src/packaging/files.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const [fromArg,outArg,argsArg]=process.argv.slice(2);
if(!fromArg||!outArg||!argsArg)throw Error('Expected source task directory, new output directory, pinned JVM args');
const from=await fs.realpath(fromArg),out=path.resolve(outArg),args=await fs.realpath(argsArg);
if(out===from||out.startsWith(from+path.sep))throw Error('Output must not modify the original task');
const read=async rel=>JSON.parse(await fs.readFile(path.join(from,rel),'utf8'));
const [stage,geometry,artwork,wave,preview]=await Promise.all([
  read('artwork/stage.json'),read('rigging/geometry.json'),read('artwork/artwork-manifest.json'),
  read('rigging/anchored-wave.json'),read('dynamics/preview/engine-journal.json')]);
const source=path.join(from,'dynamics/preview/verification.psd2live');
const deliverable=path.join(from,'dynamics/character.psd2live');
const renderStep=preview.steps.find(s=>s.operation==='project_export_target');
if(stage.taskId!==geometry.taskId||stage.inputSha256!==artwork.inputSha256||!renderStep)throw Error('Source mismatch');
const sourceTree=path.join(root,'.local/tools/psd2live');
const java=(await fs.readFile(path.join(sourceTree,'build/run/java'),'utf8')).trim();
await fs.mkdir(out);
for(const d of ['schemas','operation-images','model','render'])await fs.mkdir(path.join(out,d));
const runtime=await fs.mkdtemp(path.join(os.tmpdir(),'rig-ab-'));
const token=randomBytes(32).toString('base64url');
await fs.writeFile(path.join(runtime,'psd2live-token'),token,{mode:0o600});
const child=spawn(java,['@'+args,'mcp','--port','0','--token',token,'--store',path.join(runtime,'editor'),'--profile','core'],
  {cwd:sourceTree,stdio:['ignore','pipe','ignore']});
const lines=createInterface({input:child.stdout});
try {
  const endpoint=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('Isolated editor not ready')),25000);
    child.once('exit',()=>{clearTimeout(timer);reject(Error('Isolated editor exited'));});
    lines.on('line',line=>{
      const m=/^endpoint (http:\/\/127\.0\.0\.1:\d+\/mcp)$/.exec(line.trim());
      if(m){clearTimeout(timer);resolve(m[1]);}
    });
  });
  const client=new PinnedPsd2Live(root,{connectionDir:runtime});client.endpoint=endpoint;
  const session=new RigSession({engine:client},out,{identity:{taskId:stage.taskId,candidateId:stage.candidateId,revision:stage.revision},done:{}});
  const step=async (...params)=>{
    console.log(params[0]);
    return (await session.step(...params)).data;
  };
  const modelProject=path.join(out,'refined.psd2live');
  await fs.copyFile(deliverable,modelProject);
  await step('open-isolated','project_open',{path:modelProject},{lifecycle:true});
  console.log('refine-face');
  const head=await applySampledHeadKeys(session,geometry.parts,stage.brief,{prefix:'ab-v2',portrait:true});
  const headDiagnostics=Object.values(session.journal.done).filter(e=>e.operation==='author_axis').map(e=>e.data.geometry_diagnostics).filter(Boolean);
  if(headDiagnostics.some(d=>!d.safe||(d.warnings?.length??0)))throw Error('Face geometry refused');
  const {layerId,target}=wave.records[0];
  const part={...artwork.parts.find(p=>p.id===layerId),...geometry.parts.find(p=>p.id===layerId)};
  await step('reset-wave','keyform_apply',{changes:[{op:'reset',target,all_keys:true,to:'default',along:['ParamWave']}]});
  console.log('refine-wave');
  const newWave=await applyContinuousWave(session,part,[{target,layerId}]);
  await step('save-refined','project_save_as',{path:modelProject});
  await step('export-refined','project_export_model',{output_directory:path.join(out,'model')});
  await step('reopen-refined','project_open',{path:modelProject},{lifecycle:true});
  const scratch=path.join(out,'verification.psd2live');
  const trajectory=await read('dynamics/preview/trajectory.json');
  const expectedClip=(await session.query('motion_get',{id:trajectory.clip.id}).catch(()=>null))?.data?.clip;
  if(!expectedClip)await step('put-original-verification','motion_put',{clip:trajectory.clip});
  await step('save-verification','project_save_as',{path:scratch});
  await writeJson(path.join(out,'result.json'),{scope:'isolated same artwork, identical preview controls; no native publication or benchmark acceptance',
    sourceTaskId:stage.taskId,sourceCandidateId:stage.candidateId,sourceRevision:stage.revision,inputSha256:stage.inputSha256,
    sourceProject:await digest(deliverable),sourcePreviewProject:await digest(source),refinedProject:await digest(modelProject),
    originalTrajectory:await digest(path.join(from,'dynamics/preview/trajectory.json')),headPoseCount:head.poses.length,
    originalWave:wave,newWave});
  await step('render-original-timeline','project_export_target',{target:'mp4',output_directory:path.join(out,'render'),settings:renderStep.request.settings});
} finally {
  lines.close();
  if(child.exitCode===null&&child.signalCode===null) {
    const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();
    await exited;
  }
  await fs.rm(runtime,{recursive:true,force:true});
}
