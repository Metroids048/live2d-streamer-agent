// Resume the existing production Dynamics stage in its exclusively owned engine.
// This runner neither submits artwork nor grants visual/runtime/user acceptance.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {buildDynamics,captureDynamicsPreview} from '../src/dynamics/index.mjs';
import {createStageEngine,PinnedPsd2Live} from '../src/pipeline/production-engine.mjs';
import {imageEngineDirectory} from '../src/pipeline/engine-location.mjs';
import {identityKeys} from '../src/pipeline/lease.mjs';
import {Store} from '../src/store.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const [mode,candidateRoot,expectedStageSha256,runtimeArgsPath]=process.argv.slice(2);
assert(['build','preview'].includes(mode)&&candidateRoot&&runtimeArgsPath&&/^[a-f0-9]{64}$/.test(expectedStageSha256??''),
  'build|preview, candidate root, frozen source-stage SHA and runtime descriptor required');
const taskRoot=path.resolve(candidateRoot);
assert(taskRoot.startsWith(path.join(root,'openclaw-workspace/outputs/')));
assert.equal(await fs.realpath(taskRoot),taskRoot);
const hash=b=>createHash('sha256').update(b).digest('hex');
const stagePath=path.join(taskRoot,mode==='build'?'rigging/stage.json':'dynamics/stage.json');
const bytes=await fs.readFile(stagePath);assert.equal(hash(bytes),expectedStageSha256,'Source stage changed');
const source=JSON.parse(bytes);
assert.equal(source.stage,mode==='build'?'rigging':'dynamics');
assert.equal(source.status,mode==='build'?'completed':'blocked');
if(mode==='build')assert.deepEqual(source.unresolved,[]);
assert.equal(source.productionScope?.deferred?.length??0,0);
const args=JSON.parse(await fs.readFile(path.resolve(runtimeArgsPath)));
const manifestBytes=await fs.readFile(args.runtimeManifest),engineRuntimePatch=JSON.parse(manifestBytes);
assert.equal(hash(manifestBytes),args.runtimeManifestSha256);
assert.equal(hash(await fs.readFile(args.argsFile)),args.argsSha256);
for(const c of engineRuntimePatch.runtimeComponents)assert.equal(hash(await fs.readFile(c.path)),c.sha256,c.path);
const dir=imageEngineDirectory(root,source.taskId,source.candidateId,source.revision);
assert.equal(dir,args.engineDirectory);assert.equal(path.dirname(args.argsFile),dir);
const identity=Object.fromEntries(identityKeys.map(k=>[k,source[k]]));
const serviceStore=new Store(root,dir),client=new PinnedPsd2Live(root,{connectionDir:dir});
async function ensureEngine() {
  const s=await serviceStore.read('psd2live-service');assert(s,'Start the owned dedicated engine first');
  for(const k of ['taskId','candidateId','revision'])assert.equal(s[k],source[k]);
  assert.equal(s.argsFile,args.argsFile);assert.equal(s.argsSha256,args.argsSha256);
  assert(Number.isInteger(s.pid)&&s.pid>0);process.kill(s.pid,0);
  assert(Number.isInteger(s.port)&&s.port>0&&s.port<=65535);
  client.endpoint=`http://127.0.0.1:${s.port}/mcp`;
  await client.call('workspace_list_operations',{limit:1});
}
const withEngine=createStageEngine({root,client,ensureEngine,location:{dir,args:[source.taskId,source.candidateId,String(source.revision)]}});
const work=mode==='build'?buildDynamics:captureDynamicsPreview;
const result=await withEngine('dynamics',source,{root,taskRoot,...identity,engineRuntimePatch,
  progress:p=>console.log(p.step??p.operation??p.stage)},ctx=>work(source,ctx));
console.log(JSON.stringify({mode,status:result.status,projectId:result.engineProjectId,state:result.engineRevision,
  previewCapture:result.previewCapture,unresolved:result.unresolved}));
