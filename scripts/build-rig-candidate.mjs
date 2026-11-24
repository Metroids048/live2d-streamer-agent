// Resume the production Rig stage for a frozen ArtworkBundle and owned engine.
// Does not submit artwork generation, grant visual acceptance or publish media.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {buildRig} from '../src/rigging/index.mjs';
import {RIG_REPAIR_PROFILE} from '../src/rigging/recipe.mjs';
import {createStageEngine,PinnedPsd2Live} from '../src/pipeline/production-engine.mjs';
import {imageEngineDirectory} from '../src/pipeline/engine-location.mjs';
import {identityKeys} from '../src/pipeline/lease.mjs';
import {Store} from '../src/store.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const [candidateRoot,expectedArtworkStageSha256,runtimeArgsPath]=process.argv.slice(2);
assert(candidateRoot&&runtimeArgsPath&&/^[a-f0-9]{64}$/.test(expectedArtworkStageSha256??''),'candidate root, frozen Artwork SHA and runtime descriptor required');
const taskRoot=path.resolve(candidateRoot);
assert(taskRoot.startsWith(path.join(root,'openclaw-workspace/outputs/')));
assert.equal(await fs.realpath(taskRoot),taskRoot);
const hash=b=>createHash('sha256').update(b).digest('hex');
const artworkBytes=await fs.readFile(path.join(taskRoot,'artwork/stage.json'));
assert.equal(hash(artworkBytes),expectedArtworkStageSha256,'Frozen Artwork changed');
const artwork=JSON.parse(artworkBytes);
assert.equal(artwork.status,'completed');assert.deepEqual(artwork.unresolved,[]);
const originalRoot=path.join(root,'openclaw-workspace/outputs',artwork.taskId);
const intake=JSON.parse(await fs.readFile(path.join(originalRoot,'intake/stage.json')));
assert.equal(artwork.inputSha256,intake.inputSha256);assert.equal(artwork.descriptionSha256,intake.descriptionSha256);
assert.deepEqual(artwork.brief.intent,intake.brief.intent,'Original full intent must be retained');
assert.notEqual(artwork.productionScope?.gate,'G1');assert.equal(artwork.productionScope?.deferred?.length??0,0);
const args=JSON.parse(await fs.readFile(path.resolve(runtimeArgsPath)));
const manifestBytes=await fs.readFile(args.runtimeManifest),engineRuntimePatch=JSON.parse(manifestBytes);
assert.equal(hash(manifestBytes),args.runtimeManifestSha256);
assert.equal(hash(await fs.readFile(args.argsFile)),args.argsSha256);
for(const c of engineRuntimePatch.runtimeComponents)assert.equal(hash(await fs.readFile(c.path)),c.sha256,c.path);
const dir=imageEngineDirectory(root,artwork.taskId,artwork.candidateId,artwork.revision);
assert.equal(dir,args.engineDirectory);assert.equal(path.dirname(args.argsFile),dir);
const identity=Object.fromEntries(identityKeys.map(k=>[k,artwork[k]]));
const execution={identity,repairProfile:RIG_REPAIR_PROFILE,artworkStageSha256:expectedArtworkStageSha256,
 runtimeManifestSha256:args.runtimeManifestSha256,argsFile:args.argsFile,argsSha256:args.argsSha256};
const serviceStore=new Store(root,dir),client=new PinnedPsd2Live(root,{connectionDir:dir});
async function ensureEngine() {
 const s=await serviceStore.read('psd2live-service');assert(s,'Start the owned dedicated engine first');
 for(const k of ['taskId','candidateId','revision'])assert.equal(s[k],artwork[k]);
 assert.equal(s.argsFile,args.argsFile);assert.equal(s.argsSha256,args.argsSha256);
 assert(Number.isInteger(s.pid)&&s.pid>0);process.kill(s.pid,0);
 assert(Number.isInteger(s.port)&&s.port>0&&s.port<=65535);
 client.endpoint=`http://127.0.0.1:${s.port}/mcp`;
 await client.call('workspace_list_operations',{limit:1});
}
const withEngine=createStageEngine({root,client,ensureEngine});
const result=await withEngine('rigging',artwork,{root,taskRoot,...identity,engineRuntimePatch,waveReturnRegistrationRequired:true,
 progress:p=>process.stdout.write(p.key+' '+p.operation+'\n')},async ctx=>buildRig(artwork,ctx));
assert.equal(hash(await fs.readFile(path.join(taskRoot,'artwork/stage.json'))),expectedArtworkStageSha256);
await fs.writeFile(path.join(taskRoot,'rigging/build-execution.json'),JSON.stringify({execution,status:result.status,
 projectId:result.engineProjectId,state:result.engineRevision,projectPath:result.projectPath,modelPath:result.modelPath,
 unresolved:result.unresolved,visualAcceptance:'not_granted_by_build_script'},null,2)+'\n');
console.log(JSON.stringify({status:result.status,projectId:result.engineProjectId,state:result.engineRevision,unresolved:result.unresolved}));
