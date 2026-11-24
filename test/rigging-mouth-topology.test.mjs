import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {RigSession} from '../src/rigging/engine.mjs';
import {refineMouthTopology,MOUTH_TOPOLOGY_VERSION} from '../src/rigging/mouth-topology.mjs';

async function fixture(t,{warning=false}={}) {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mouth-topology-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 await fs.mkdir(path.join(dir,'schemas'));
 const parts=['cavity','upper','lower'].map(id=>({id,tags:['mouth','open']}));
 const objects=parts.map(p=>({layerId:p.id,target:'mesh:'+p.id}));
 const shapes=new Map(parts.map(p=>[p.id,{vertices:[[0,0,0],[1,1,0],[2,0,1]],triangles:[[0,0,1,2]]}]));
 let edits=0,state='s0';
 const journal={identity:{taskId:'task',candidateId:'candidate',revision:10},sourceHash:'source',projectId:'owned',state,done:{},pending:null};
 // This boundary fixture tests the real durable RigSession. Native geometry and
 // visible quality are separately verified on the saved Hachi project and MOC.
 const engine={async call(operation,request) {
  if(operation==='workspace_get_operation')return {data:{id:request.id,request_schema:{type:'object',properties:{}}}};
  if(operation==='workspace_inspect')return {data:{project_id:'owned',state,busy:false}};
  if(operation==='mesh_get_topology')return {data:{target:request.target,coordinate_space:'mesh_rest',items:structuredClone(shapes.get(request.target.slice(5))[request.section]),project_id:'owned',state}};
  assert.equal(operation,'canvas_topology');assert.deepEqual(request.vertices,[0,1,2]);
  edits++;state='s'+edits;
  shapes.set(request.id,{vertices:[[0,0,0],[1,1,0],[2,0,1],[3,.5,0],[4,.5,.5],[5,0,.5]],triangles:[[0,0,3,5],[1,3,1,4],[2,5,4,2],[3,3,4,5]]});
  return {data:{project_id:'owned',state,geometry_diagnostics:{safe:true,warnings:warning?['unsafe']:[],violations:[]}}};
 }};
 const session=new RigSession({engine},dir,journal);
 return {dir,parts,objects,journal,session,shapes,edits:()=>edits,file:path.join(dir,MOUTH_TOPOLOGY_VERSION+'-baseline.json')};
}

test('only mouth-open meshes subdivide once; durable resume reuses the original selection',async t=>{
 const f=await fixture(t);f.parts.push({id:'closed',tags:['mouth','closed']});
 const a=await refineMouthTopology(f.session,f.parts,f.objects);assert.equal(f.edits(),3);assert.equal(a.targets.length,3);
 assert(a.targets.every(p=>p.beforeVertices===3&&p.afterVertices===6&&p.afterTriangles===4));
 const saved=JSON.parse(await fs.readFile(path.join(f.dir,'state.json'),'utf8'));
 const resumed=new RigSession(f.session.ctx,f.dir,saved),before=JSON.stringify([...f.shapes]);
 assert.deepEqual(await refineMouthTopology(resumed,f.parts,f.objects),a);
 assert.equal(f.edits(),3);assert.equal(JSON.stringify([...f.shapes]),before);assert.equal(resumed.journal.state,'s3');
});

test('completed operation with an unknown body hash is not replayed',async t=>{
 const f=await fixture(t);await refineMouthTopology(f.session,f.parts,f.objects);
 f.journal.done[MOUTH_TOPOLOGY_VERSION+'-cavity'].bodyHash='unknown';
 await assert.rejects(refineMouthTopology(f.session,f.parts,f.objects),{code:'RECIPE_CHANGED_USE_NEW_CANDIDATE'});assert.equal(f.edits(),3);
});

test('missing original baseline after a completed subdivision cannot compound the mesh',async t=>{
 const f=await fixture(t);await refineMouthTopology(f.session,f.parts,f.objects);await fs.unlink(f.file);
 await assert.rejects(refineMouthTopology(f.session,f.parts,f.objects),{code:'MOUTH_TOPOLOGY_BASELINE_MISSING'});assert.equal(f.edits(),3);
});

test('malformed later target, wrong source and symlink baselines fail before any native edit',async t=>{
 const f=await fixture(t);await refineMouthTopology(f.session,f.parts,f.objects);const original=JSON.parse(await fs.readFile(f.file,'utf8'));f.journal.done={};
 const corrupt=structuredClone(original);corrupt.targets[2].vertices[1][1]=NaN;
 await fs.writeFile(f.file,JSON.stringify(corrupt));await assert.rejects(refineMouthTopology(f.session,f.parts,f.objects));assert.equal(f.edits(),3);
 await fs.writeFile(f.file,JSON.stringify({...original,sourceHash:'other'}));await assert.rejects(refineMouthTopology(f.session,f.parts,f.objects),{code:'MOUTH_TOPOLOGY_BASELINE_INVALID'});
 const target=f.file+'.original';await fs.writeFile(target,JSON.stringify(original));await fs.unlink(f.file);await fs.symlink(target,f.file);
 await assert.rejects(refineMouthTopology(f.session,f.parts,f.objects),{code:'MOUTH_TOPOLOGY_BASELINE_INVALID'});assert.equal(f.edits(),3);
});

test('native geometry warnings block without relaxing the safety threshold',async t=>{
 const f=await fixture(t,{warning:true});await assert.rejects(refineMouthTopology(f.session,f.parts,f.objects),{code:'MOUTH_TOPOLOGY_GEOMETRY_REVIEW_REQUIRED'});assert.equal(f.edits(),1);
});
