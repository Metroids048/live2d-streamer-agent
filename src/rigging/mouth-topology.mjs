import fs from 'node:fs/promises';
import path from 'node:path';
import {RigError,writeJson} from './engine.mjs';
import {inspectTopology} from './geometry.mjs';
import {has} from './recipe.mjs';

export const MOUTH_TOPOLOGY_VERSION='hachi-mouth-topology-v1';
const fail=code=>{throw new RigError(code);};

async function topology(session,target) {
  const read=async section=>{
    const items=[];let offset=0;
    for(;;) {
      const r=(await session.query('mesh_get_topology',{target,section,space:'local',offset,limit:4096})).data;
      if(r.coordinate_space!=='mesh_rest'||r.target!==target)fail('MOUTH_TOPOLOGY_SPACE_MISMATCH');
      items.push(...r.items);
      if(r.next_offset===undefined)break;
      if(!Number.isInteger(r.next_offset)||r.next_offset<=offset)fail('MOUTH_TOPOLOGY_PAGINATION');
      offset=r.next_offset;
    }
    return items;
  };
  const vertices=await read('vertices'),triangles=await read('triangles');
  if(!inspectTopology(vertices,triangles).ok||vertices.some((v,i)=>v[0]!==i))fail('MOUTH_TOPOLOGY_INVALID');
  return {vertices,triangles};
}

// One native midpoint subdivision, before expression curves are sampled. The
// persisted original selection makes a resumed build replay the exact request,
// rather than subdividing the newly created vertices on each entry.
export async function refineMouthTopology(session,parts,objects) {
  const selected=parts.filter(p=>has(p,'mouth','open'));
  if(!selected.length)return null;
  const targets=selected.map(p=>{
    const object=objects.find(o=>o.layerId===p.id&&o.target.startsWith('mesh:'));
    if(!object)fail('MOUTH_TOPOLOGY_MESH_MISSING');
    return {layerId:p.id,target:object.target};
  });
  const file=path.join(session.dir,MOUTH_TOPOLOGY_VERSION+'-baseline.json');
  let baseline;
  try {
    const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink())fail('MOUTH_TOPOLOGY_BASELINE_INVALID');
    baseline=JSON.parse(await fs.readFile(file,'utf8'));
  } catch(error) {
    if(error.code!=='ENOENT')throw error;
    if(targets.some(p=>session.journal.done[MOUTH_TOPOLOGY_VERSION+'-'+p.layerId]))fail('MOUTH_TOPOLOGY_BASELINE_MISSING');
    baseline={version:MOUTH_TOPOLOGY_VERSION,identity:session.journal.identity,sourceHash:session.journal.sourceHash,
      projectId:session.journal.projectId,state:session.journal.state,targets:[]};
    for(const p of targets)baseline.targets.push({...p,...await topology(session,p.target)});
    await writeJson(file,baseline);
  }
  if(baseline.version!==MOUTH_TOPOLOGY_VERSION||baseline.projectId!==session.journal.projectId||
    baseline.sourceHash!==session.journal.sourceHash||JSON.stringify(baseline.identity)!==JSON.stringify(session.journal.identity)||
    !Array.isArray(baseline.targets)||baseline.targets.length!==targets.length)fail('MOUTH_TOPOLOGY_BASELINE_INVALID');
  for(const [i,p] of targets.entries()) {
    const before=baseline.targets[i];
    if(before.layerId!==p.layerId||before.target!==p.target||!Array.isArray(before.vertices)||!Array.isArray(before.triangles)||
      !inspectTopology(before.vertices,before.triangles).ok||before.vertices.some((v,i)=>v[0]!==i))fail('MOUTH_TOPOLOGY_BASELINE_INVALID');
  }
  const report={version:MOUTH_TOPOLOGY_VERSION,baseline:path.basename(file),targets:[]};
  for(const [i,p] of targets.entries()) {
    const before=baseline.targets[i];
    const result=await session.step(MOUTH_TOPOLOGY_VERSION+'-'+p.layerId,'canvas_topology',
      {id:p.target.slice(5),action:'subdivide',vertices:before.vertices.map(v=>v[0])});
    const d=result.data?.geometry_diagnostics;
    if(d?.safe!==true||d.warnings?.length||d.violations?.length)fail('MOUTH_TOPOLOGY_GEOMETRY_REVIEW_REQUIRED');
    const after=await topology(session,p.target),edges=new Set();
    for(const [,a,b,c] of before.triangles)for(const [u,v] of [[a,b],[b,c],[c,a]])edges.add([u,v].sort((x,y)=>x-y).join(':'));
    if(after.vertices.length!==before.vertices.length+edges.size||after.triangles.length!==before.triangles.length*4||
      before.vertices.some(([id,x,y])=>Math.abs(after.vertices[id][1]-x)>1e-7||Math.abs(after.vertices[id][2]-y)>1e-7))
      fail('MOUTH_TOPOLOGY_SUBDIVISION_MISMATCH');
    report.targets.push({...p,beforeVertices:before.vertices.length,afterVertices:after.vertices.length,
      beforeTriangles:before.triangles.length,afterTriangles:after.triangles.length});
  }
  return report;
}
