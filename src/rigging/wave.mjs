// The anchored ARAP field replaces the old single-arc wave refinement. All inputs
// are measured points from one native capture, in the Artwork's canvas space.
import {RigError} from './engine.mjs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {digest,safePath} from './files.mjs';
import {decodePng} from './geometry.mjs';
const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
const point=p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite);
const fail=(code,details)=>{throw new RigError(code,code,details);};

export function canvasRegistration(local,canvas,{tolerance=.001}={}) {
  if(local.length!==canvas.length||local.length<3||![...local,...canvas].every(point))fail('WAVE_REGISTRATION_INVALID');
  const mean=local.reduce((a,p)=>[a[0]+p[0]/local.length,a[1]+p[1]/local.length],[0,0]);
  const center=canvas.reduce((a,p)=>[a[0]+p[0]/canvas.length,a[1]+p[1]/canvas.length],[0,0]);
  let xx=0,xy=0,yy=0,ux=0,uy=0,vx=0,vy=0;
  for(let i=0;i<local.length;i++) {
    const x=local[i][0]-mean[0],y=local[i][1]-mean[1],u=canvas[i][0]-center[0],v=canvas[i][1]-center[1];
    xx+=x*x;xy+=x*y;yy+=y*y;ux+=u*x;uy+=u*y;vx+=v*x;vy+=v*y;
  }
  const det=xx*yy-xy*xy;if(!(det>1e-16))fail('WAVE_PARENT_SINGULAR');
  const a=(ux*yy-uy*xy)/det,b=(uy*xx-ux*xy)/det,c=(vx*yy-vy*xy)/det,d=(vy*xx-vx*xy)/det;
  const inverse=a*d-b*c;if(Math.abs(inverse)<1e-12)fail('WAVE_PARENT_SINGULAR');
  const toCanvas=([x,y])=>[center[0]+a*(x-mean[0])+b*(y-mean[1]),center[1]+c*(x-mean[0])+d*(y-mean[1])];
  const toLocal=([u,v])=>[mean[0]+(d*(u-center[0])-b*(v-center[1]))/inverse,mean[1]+(-c*(u-center[0])+a*(v-center[1]))/inverse];
  const maxError=Math.max(...local.map((p,i)=>distance(toCanvas(p),canvas[i])));
  if(maxError>tolerance)fail('WAVE_PARENT_NON_AFFINE');
  return {toCanvas,toLocal,maxError,matrix:[a,b,c,d],localCenter:mean,canvasCenter:center};
}

export function waveAnchors(part) {
  const a=part?.rigging?.wave;
  if(a?.coordinateSpace!=='canvas_top_left_y_down'||!Array.isArray(a.shoulderPins)||a.shoulderPins.length<3||!a.shoulderPins.every(point)||
    !point(a.elbow)||!point(a.hand)||!(a.jointRadius>0)||!Number.isFinite(a.loweredDegrees)||Math.abs(a.loweredDegrees)<3||Math.abs(a.loweredDegrees)>170)
    fail('WAVE_ANCHORS_INVALID');
  return a;
}

export async function loadWaveReturnRegistration(session,parts) {
  const file=path.join(session.dir,'wave-return-registration.json');
  let bytes;try{
    const stat=await fs.lstat(file),safe=await safePath(session.ctx.taskRoot,path.relative(session.ctx.taskRoot,file).split(path.sep).join('/'));
    if(!stat.isFile()||stat.isSymbolicLink()||safe!==path.resolve(file))fail('WAVE_RETURN_REGISTRATION_PATH_INVALID');
    bytes=await fs.readFile(safe);
  }catch(e){if(e.code==='ENOENT'&&!session.ctx.waveReturnRegistrationRequired)return null;if(e.code==='ENOENT')fail('WAVE_RETURN_REGISTRATION_REQUIRED');throw e;}
  let r;try{r=JSON.parse(bytes);}catch{fail('WAVE_RETURN_REGISTRATION_INVALID');}
  if(!r||typeof r!=='object')fail('WAVE_RETURN_REGISTRATION_INVALID');
  for(const id of ['taskId','candidateId','revision'])if(r.identity?.[id]!==session.ctx[id])fail('WAVE_RETURN_IDENTITY_MISMATCH');
  if(r.version!=='measured-wave-return-v1'||r.ownership!=='single_raised_return'||r.coordinateSpace!=='canvas_top_left_y_down'||!Array.isArray(r.sources)||r.sources.length<3||
    !Array.isArray(r.records)||!r.records.length||!r.sources.every(s=>s&&typeof s.layerId==='string'&&typeof s.path==='string'&&/^[a-f0-9]{64}$/.test(s.sha256)&&s.rect&&['left','top','width','height'].every(k=>Number.isFinite(s.rect[k]))&&s.rect.width>0&&s.rect.height>0)||
    !r.records.every(s=>s&&typeof s.layerId==='string')||new Set(r.sources.map(s=>s.layerId)).size!==r.sources.length||new Set(r.records.map(s=>s.layerId)).size!==r.records.length)fail('WAVE_RETURN_REGISTRATION_INVALID');
  for(const part of parts.filter(p=>p.tags.includes('gesture')&&p.tags.includes('wave')&&p.tags.includes('raised')))if(!r.records.some(e=>e.layerId===part.id))fail('WAVE_RETURN_TARGET_MISSING');
  for(const entry of r.records) {
    const source=parts.find(p=>p.id===entry.layerId),rest=parts.find(p=>p.id===entry.restLayerId),mask=parts.find(p=>p.id===entry.occlusion?.layerId),pose=entry.returnPose;
    if(!['gesture','wave','raised'].every(t=>source?.tags.includes(t))||!['gesture','wave','rest'].every(t=>rest?.tags.includes(t))||!mask?.tags.some(t=>t==='skirt'||t==='lower-body')||!Array.isArray(entry.commonShoulderSupport)||entry.commonShoulderSupport.length<3||!entry.commonShoulderSupport.every(point)||
      !pose||!Array.isArray(pose.source)||pose.source.length!==2||!Array.isArray(pose.target)||pose.target.length!==2||![...pose.source,...pose.target,pose.elbow].every(point)||
      !(distance(...pose.source)>1e-8)||!(distance(...pose.target)>1e-8)||!Number.isFinite(pose.radius)||!(pose.radius>0)||
      !Number.isFinite(entry.occlusion?.sourceHandRadius)||!(entry.occlusion.sourceHandRadius>0)||!Number.isInteger(entry.drawOrder)||entry.drawOrder<0||entry.drawOrder>1000)fail('WAVE_RETURN_REGISTRATION_INVALID');
    for(const id of [entry.layerId,entry.restLayerId,entry.occlusion.layerId])if(!r.sources.some(s=>s.layerId===id))fail('WAVE_RETURN_SOURCE_MISSING');
  }
  for(const source of r.sources) {
    const part=parts.find(p=>p.id===source.layerId);
    if(!part||part.imagePath!==source.path||!source.rect||JSON.stringify(part.rect)!==JSON.stringify(source.rect))fail('WAVE_RETURN_SOURCE_MISMATCH');
    const file=await safePath(session.ctx.taskRoot,source.path),stat=await fs.lstat(path.join(session.ctx.taskRoot,source.path));
    if(!stat.isFile()||stat.isSymbolicLink()||file!==path.resolve(session.ctx.taskRoot,source.path))fail('WAVE_RETURN_SOURCE_PATH_INVALID');
    if(digest(await fs.readFile(file))!==source.sha256)fail('WAVE_RETURN_SOURCE_HASH_MISMATCH');
  }
  return {...r,artifact:{path:'rigging/wave-return-registration.json',sha256:digest(bytes),bytes:bytes.length}};
}

export function waveReturnCoverage({points,triangles,posed,image,rect,mask,maskRect,hand,radius}) {
  let pixels=0,unmapped=0,uncovered=0,minAlpha=255;
  const misses=[],outsideMeshSamples=[];
  for(let y=0;y<image.height;y++)for(let x=0;x<image.width;x++) {
    if(image.rgba[(y*image.width+x)*4+3]<128)continue;
    const p=[rect.left+(x+.5)*rect.width/image.width,rect.top+(y+.5)*rect.height/image.height];
    if(distance(p,hand)>radius)continue;pixels++;
    let q=null;
    for(const t of triangles) {
      const [a,b,c]=t.map(i=>points[i]),area=cross(a,b,c),u=cross(p,b,c)/area,v=cross(a,p,c)/area,w=1-u-v;
      if(Math.min(u,v,w)<-1e-7)continue;
      q=[0,1].map(j=>u*posed[t[0]][j]+v*posed[t[1]][j]+w*posed[t[2]][j]);break;
    }
    if(!q){unmapped++;if(outsideMeshSamples.length<8)outsideMeshSamples.push({source:p,native:[x,y]});continue;}
    const u=Math.floor((q[0]-maskRect.left)*mask.width/maskRect.width),v=Math.floor((q[1]-maskRect.top)*mask.height/maskRect.height);
    const alpha=u>=0&&v>=0&&u<mask.width&&v<mask.height?mask.rgba[(v*mask.width+u)*4+3]:0;
    minAlpha=Math.min(minAlpha,alpha);
    if(alpha<250){uncovered++;if(misses.length<8)misses.push({source:p,posed:q,alpha});}
  }
  // Pixels outside the unchanged native mesh cannot be rendered. Keep them in the
  // report rather than counting them as hidden; all mapped pixels must be covered.
  return {pixels,renderedPixels:pixels-unmapped,unmapped,outsideMeshSamples,uncovered,minAlpha,misses,passed:pixels>unmapped&&uncovered===0};
}

export function waveCells(anchors,{singleArm=false}={}) {
  const cells=(singleArm?[0,.25,.5,.75,1]:[undefined]).flatMap(wave=>[0,.25,.5,.75,1].flatMap(lift=>[-1,0,1].map(wrist=>{
    const returnLift=wave===undefined?lift:1-wave*(1-lift);
    return {lift,wrist,...(wave===undefined?{}:{wave}),returnLift,value:returnLift+(wave??1)*wrist*18/anchors.loweredDegrees};
  })));
  return cells;
}

export function checkWaveInterpolation(points,triangles,cells,keys) {
  const waves=cells[0].wave===undefined?[undefined]:[0,.25,.5,.75,1],lifts=[0,.25,.5,.75,1],wrists=[-1,0,1];
  const at=(w,l,r)=>keys[cells.findIndex(c=>c.wave===w&&c.lift===l&&c.wrist===r)].points;
  let minAreaRatio=Infinity;
  for(let wi=0;wi<Math.max(1,waves.length-1);wi++)for(let li=0;li<4;li++)for(let ri=0;ri<2;ri++)
    for(const u of waves.length===1?[0]:[.25,.5,.75])for(const v of [.25,.5,.75])for(const z of [.25,.5,.75]) {
      const p=points.map(()=>[0,0]);
      for(const [dw,ww] of waves.length===1?[[0,1]]:[[0,1-u],[1,u]])for(const [dl,wl] of [[0,1-v],[1,v]])for(const [dr,wr] of [[0,1-z],[1,z]]) {
        const form=at(waves[wi+dw],lifts[li+dl],wrists[ri+dr]);
        for(let i=0;i<p.length;i++)for(let a=0;a<2;a++)p[i][a]+=ww*wl*wr*form[i][a];
      }
      for(const t of triangles)minAreaRatio=Math.min(minAreaRatio,cross(...t.map(i=>p[i]))/cross(...t.map(i=>points[i])));
    }
  if(!(minAreaRatio>.05))fail('WAVE_UNSAFE_INTERPOLATION',{minAreaRatio});
  return {minAreaRatio,samplesPerCell:waves.length===1?9:27};
}

function inside(p,polygon) {
  let hit=false;
  for(let i=0,j=polygon.length-1;i<polygon.length;j=i++) {
    const a=polygon[j],b=polygon[i];
    if(Math.abs(cross(a,b,p))<1e-9&&p[0]>=Math.min(a[0],b[0])-1e-9&&p[0]<=Math.max(a[0],b[0])+1e-9&&p[1]>=Math.min(a[1],b[1])-1e-9&&p[1]<=Math.max(a[1],b[1])+1e-9)return true;
    if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])hit=!hit;
  }
  return hit;
}
function touching(triangle,polygon) {
  if(triangle.some(p=>inside(p,polygon))||polygon.some(p=>inside(p,triangle)))return true;
  for(let i=0;i<3;i++)for(let j=0;j<polygon.length;j++) {
    const a=triangle[i],b=triangle[(i+1)%3],c=polygon[j],d=polygon[(j+1)%polygon.length];
    if(cross(a,b,c)*cross(a,b,d)<0&&cross(c,d,a)*cross(c,d,b)<0)return true;
  }
  return false;
}

// Positive edge weights give an SPD free Laplacian. CG retains the sparse mesh
// structure, so dense HD sleeve meshes need no quadratic matrix allocation.
function solveLaplacian(adjacency,free,fixed,rhs,start) {
  const index=new Map(free.map((id,i)=>[id,i]));
  const multiply=x=>free.map(id=>{
    let value=0;for(const [j,w] of adjacency[id])value+=w*(x[index.get(id)]-(index.has(j)?x[index.get(j)]:0));return value;
  });
  const b=free.map(id=>rhs[id]+[...adjacency[id]].reduce((n,[j,w])=>n+(index.has(j)?0:w*fixed[j]),0));
  const x=free.map(i=>start[i]),ax=multiply(x),r=b.map((v,i)=>v-ax[i]);let p=[...r],rr=r.reduce((s,v)=>s+v*v,0);
  const epsilon=Math.max(1,b.reduce((s,v)=>s+v*v,0))*1e-20;
  for(let k=0;rr>epsilon&&k<Math.max(64,free.length*4);k++) {
    const ap=multiply(p),pap=p.reduce((s,v,i)=>s+v*ap[i],0);if(!(pap>0))fail('WAVE_SOLVER_SINGULAR');
    const alpha=rr/pap;for(let i=0;i<x.length;i++){x[i]+=alpha*p[i];r[i]-=alpha*ap[i];}
    const next=r.reduce((s,v)=>s+v*v,0),beta=next/rr;p=r.map((v,i)=>v+beta*p[i]);rr=next;
  }
  if(rr>epsilon)fail('WAVE_SOLVER_DID_NOT_CONVERGE');return x;
}

export function solveWaveKeys({points,triangles,anchors,values=[.25,.5,.75,1],poses,returnPose}) {
  waveAnchors({rigging:{wave:anchors}});
  if(!Array.isArray(points)||!points.every(point)||!triangles.length)fail('WAVE_TOPOLOGY_INVALID');
  const adjacency=points.map(()=>new Map()),pinned=new Set(),restAreas=[];
  for(const t of triangles) {
    if(t.length!==3||!t.every(i=>Number.isInteger(i)&&i>=0&&i<points.length))fail('WAVE_TOPOLOGY_INVALID');
    const area=cross(...t.map(i=>points[i]));if(Math.abs(area)<1e-10)fail('WAVE_REST_DEGENERATE');restAreas.push(area);
    if(touching(t.map(i=>points[i]),anchors.shoulderPins))for(const i of t)pinned.add(i);
    for(let i=0;i<3;i++){const a=t[i],b=t[(i+1)%3],w=1/Math.max(distance(points[a],points[b]),1e-6);adjacency[a].set(b,w);adjacency[b].set(a,w);}
  }
  if(pinned.size<3)fail('WAVE_SHOULDER_UNSAMPLED');
  // A small elbow disk need not cut through a wide sleeve. Flooding everything
  // outside that disk then rotates the upper arm all the way into the shoulder.
  // Use an anatomical distal cap instead: half the measured elbow-to-palm length,
  // measured along mesh edges. The rest of that connected arm is the ARAP field.
  const candidates=points.map((p,i)=>i).filter(i=>!pinned.has(i));
  if(!candidates.length)fail('WAVE_JOINT_UNSAMPLED');
  const tip=candidates.reduce((a,b)=>distance(points[a],anchors.hand)<distance(points[b],anchors.hand)?a:b);
  const geodesic=points.map(()=>Infinity),unvisited=new Set(points.map((p,i)=>i));geodesic[tip]=0;
  while(unvisited.size){
    let i=-1;for(const j of unvisited)if(i===-1||geodesic[j]<geodesic[i])i=j;
    if(!Number.isFinite(geodesic[i]))break;unvisited.delete(i);
    for(const j of adjacency[i].keys())if(unvisited.has(j))geodesic[j]=Math.min(geodesic[j],geodesic[i]+distance(points[i],points[j]));
  }
  if(![...pinned].some(i=>Number.isFinite(geodesic[i])))fail('WAVE_SHOULDER_DISCONNECTED');
  const forearmLength=distance(anchors.elbow,anchors.hand),handleRadius=forearmLength/2;
  const handles=new Set(candidates.filter(i=>geodesic[i]<=handleRadius));
  const cuff=new Map();
  if(returnPose) {
    const {source,target,radius,elbow}=returnPose;
    if(!Array.isArray(source)||source.length!==2||!Array.isArray(target)||target.length!==2||
      ![...source,...target,elbow].every(point)||!(radius>0))fail('WAVE_RETURN_REGISTRATION_INVALID');
    const a=source[1].map((v,i)=>v-source[0][i]),b=target[1].map((v,i)=>v-target[0][i]);
    const length=a[0]*a[0]+a[1]*a[1],c=(a[0]*b[0]+a[1]*b[1])/length,s=(a[0]*b[1]-a[1]*b[0])/length;
    if(!(length>1e-8)||c*c+s*s<.01)fail('WAVE_RETURN_REGISTRATION_INVALID');
    for(const i of candidates) {
      if(handles.has(i))continue;
      const p=points[i],t=Math.max(0,Math.min(1,((p[0]-source[0][0])*a[0]+(p[1]-source[0][1])*a[1])/length));
      if(distance(p,[source[0][0]+t*a[0],source[0][1]+t*a[1]])>radius)continue;
      const x=p[0]-source[0][0],y=p[1]-source[0][1];cuff.set(i,[target[0][0]+c*x-s*y,target[0][1]+s*x+c*y]);
    }
    if(cuff.size<2)fail('WAVE_RETURN_CUFF_UNSAMPLED');
  }
  const free=candidates.filter(i=>Number.isFinite(geodesic[i])&&!handles.has(i)&&!cuff.has(i));
  if(!free.length||!handles.size)fail('WAVE_JOINT_UNSAMPLED');
  const keys=[];
  for(const [index,value] of values.entries()) {
    if(!Number.isFinite(value))fail('WAVE_KEY_INVALID');
    const angle=value*anchors.loweredDegrees*Math.PI/180,cos=Math.cos(angle),sin=Math.sin(angle),p=points.map(p=>[...p]);
    const lift=poses?.[index]?.returnLift??poses?.[index]?.lift??value,shift=returnPose?returnPose.elbow.map((v,i)=>(v-anchors.elbow[i])*lift):[0,0];
    if(angle===0&&lift===0){keys.push({value,points:p,minAreaRatio:1});continue;}
    for(const i of handles){const x=points[i][0]-anchors.elbow[0],y=points[i][1]-anchors.elbow[1];p[i]=[anchors.elbow[0]+cos*x-sin*y+shift[0],anchors.elbow[1]+sin*x+cos*y+shift[1]];}
    for(const [i,target] of cuff)p[i]=points[i].map((v,j)=>v+(target[j]-v)*lift);
    for(let iteration=0;iteration<48;iteration++) {
      const rotations=points.map((a,i)=>{
        let dot=0,det=0;for(const [j,w] of adjacency[i]){const x=a[0]-points[j][0],y=a[1]-points[j][1],u=p[i][0]-p[j][0],v=p[i][1]-p[j][1];dot+=w*(x*u+y*v);det+=w*(x*v-y*u);}
        const theta=Math.atan2(det,dot);return [Math.cos(theta),Math.sin(theta)];
      });
      const rhs=points.map(()=>[0,0]);
      for(let i=0;i<points.length;i++)for(const [j,w] of adjacency[i]) {
        const x=points[i][0]-points[j][0],y=points[i][1]-points[j][1],c=(rotations[i][0]+rotations[j][0])/2,s=(rotations[i][1]+rotations[j][1])/2;
        rhs[i][0]+=w*(c*x-s*y);rhs[i][1]+=w*(s*x+c*y);
      }
      for(const axis of [0,1]){const result=solveLaplacian(adjacency,free,p.map(v=>v[axis]),rhs.map(v=>v[axis]),p.map(v=>v[axis]));for(let j=0;j<free.length;j++)p[free[j]][axis]=result[j];}
    }
    const ratios=triangles.map((t,i)=>cross(...t.map(j=>p[j]))/restAreas[i]),minAreaRatio=Math.min(...ratios);
    if(!(minAreaRatio>.05)){
      const triangle=ratios.indexOf(minAreaRatio),indices=triangles[triangle];
      fail('WAVE_UNSAFE_TRIANGLES',{value,angleDegrees:value*anchors.loweredDegrees,minAreaRatio,triangle,indices,
        rest:indices.map(i=>points[i]),posed:indices.map(i=>p[i]),
        pinned:[...pinned],handles:[...handles],free});
    }
    keys.push({value,points:p,minAreaRatio});
  }
  return {keys,pinned:[...pinned].sort((a,b)=>a-b),handles:[...handles].sort((a,b)=>a-b),free,cuff:[...cuff.keys()],
    controlRegion:{method:'distal_geodesic_cap_connected_arm_arap',forearmLength,handleRadius,
      declaredJointRadius:anchors.jointRadius,disconnectedRest:points.flatMap((p,i)=>!Number.isFinite(geodesic[i])?[i]:[])}};
}

async function topology(session,target,space,section='vertices') {
  const rows=[];let offset=0;
  for(;;) {
    const r=(await session.query('mesh_get_topology',{target,space,section,offset,limit:4096})).data;
    if(r.project_id!==session.journal.projectId||r.state!==session.journal.state||r.target!==target||r.section!==section||
      r.coordinate_space!==(space==='canvas'?'canvas_x_right_y_down':'mesh_rest'))fail('WAVE_TOPOLOGY_CAPTURE_MISMATCH');
    if(!Array.isArray(r.items)||r.items.some((v,i)=>v[0]!==offset+i))fail('WAVE_TOPOLOGY_INDEX_MISMATCH');
    rows.push(...r.items);
    if(r.next_offset===undefined){if(rows.length!==(section==='vertices'?r.vertex_count:r.triangle_count))fail('WAVE_TOPOLOGY_COUNT_MISMATCH');return rows.map(p=>p.slice(1));}
    if(r.next_offset!==rows.length||r.next_offset<=offset)fail('WAVE_TOPOLOGY_PAGINATION');offset=r.next_offset;
  }
}

function checked(result) {
  function visit(v){if(!v||typeof v!=='object')return;const d=v.geometry_diagnostics;if(d&&((d.violations?.length??0)||(d.warnings?.length??0)))fail('WAVE_NATIVE_GEOMETRY_REJECTED',{diagnostics:d});for(const [k,x] of Object.entries(v))if(k!=='geometry_diagnostics')visit(x);}
  visit(result.data);
}

export async function applyRestingWrist(session,sleeve,hand,objects) {
  const meshes=[sleeve,hand].map(p=>objects.filter(o=>o.layerId===p.id&&o.target.startsWith('mesh:')));
  if(meshes.some(list=>list.length!==1)||meshes[0][0].parentId!==meshes[1][0].parentId)
    fail('RESTING_WRIST_PARENT_MISMATCH');
  const wrist=hand.rigging?.restingWrist;
  if(!point(wrist)||!Number.isFinite(hand.rigging.cuffSlope))fail('RESTING_WRIST_ANCHOR_REQUIRED');
  const relax=hand.rigging.restRelease??0;
  if(!Number.isFinite(relax)||relax<0||relax>.18)fail('RESTING_WRIST_RELEASE_INVALID');
  const shapes=[],neutral=[];
  for(const [i,[{target}]] of meshes.entries()) {
    const local=await topology(session,target,'local');
    const canvas=await topology(session,target,'canvas');
    const registration=canvasRegistration(local,canvas);
    const left=Math.min(...local.map(p=>p[0])),top=Math.min(...local.map(p=>p[1]));
    const width=Math.max(...local.map(p=>p[0]))-left,height=Math.max(...local.map(p=>p[1]))-top;
    const from=[[0,0],[1,0],[0,1],[1,1]];
    for(const value of (relax?[-10,10,0]:[-10,10])) {
      const to=from.map(([u,v])=>{
        const [x,y]=registration.toCanvas([left+u*width,top+v*height]);
        // Preserve the same displacement on both sides of the diagonal cuff.
        // A separate affine field on the hand lets its distal edge settle.
        const cuffDistance=y-wrist[1]+(x-wrist[0])*hand.rigging.cuffSlope;
        const shoulderDistance=y-sleeve.rect.top;
        const sway=shoulderDistance*value*(.003+relax*.012);
        const settle=-shoulderDistance*relax*.16;
        const lift=shoulderDistance*relax*.28;
        const [nx,ny]=registration.toLocal([x+sway+settle+i*cuffDistance*(value*.008-relax),y-lift]);
        return [(nx-left)/width,(ny-top)/height];
      });
      const operations=[{type:'landmarks',from,to}];
      if(value===0)neutral.push({target,key:{ParamBodyAngleX:0},operations});
      else shapes.push({target,value,operations});
    }
  }
  checked(await session.step('resting-wrist-affine','author_axis',{
    parameter:{id:'ParamBodyAngleX',min:-10,max:10,default:0},shapes,
  }));
  if(neutral.length)checked(await session.step('resting-wrist-neutral','rig_deform',{changes:neutral}));
}

export async function applyAnchoredWave(session,parts,objects,brief,{registration=null}={}) {
  if(!brief.intent.actions.some(a=>a.id==='wave'))return null;
  const schema=await session.schema('mesh_get_topology');
  if(!schema.request_schema.properties?.space)fail('WAVE_CANVAS_QUERY_REQUIRED');
  const continuous=parts.find(p=>!p.tags.includes('palm-variant')&&(['gesture','wave','continuous'].every(t=>p.tags.includes(t))||p.tags.includes('gesture:wave:continuous')));
  if(continuous) {
    const palm=parts.find(p=>p.tags.includes('palm-variant'));
    const resting=parts.find(p=>p.tags.includes('palm-rest-variant'));
    const sourceSide=!!resting?.tags.includes('source-side-wave');
    if(resting&&!palm&&!sourceSide||sourceSide&&palm)fail('PALM_VARIANT_MISSING');
    const fore=parts.find(p=>p.tags.includes('split-forearm'));
    const backing=parts.find(p=>p.tags.includes('split-elbow-backing'));
    const split=continuous.rigging?.continuousWave?.approach==='outward_split';
    if(split&&(!fore||!backing||!sourceSide)||!split&&(fore||backing))fail('WAVE_SPLIT_SLEEVE_INCOMPLETE');
    let maxAmplitude=1;
    const options=part=>({palmTransition:!!palm||sourceSide,sharedSleeve:!!resting,sourceSide,maxAmplitude,
      passive:!!resting&&part!==(palm??resting),
      ...(split?{splitPart:part===fore?'forearm':part===backing?'backing':part===resting?'hand':'upper'}:{}),
      anchors:continuousWaveAnchors(part,parts)});
    if(palm||sourceSide)for(const part of [continuous,palm,resting,fore,backing].filter(Boolean)) {
      const matches=objects.filter(o=>o.layerId===part.id&&o.target.startsWith('mesh:'));
      if(matches.length!==1)fail('CONTINUOUS_WAVE_MESH_REQUIRED');
      const canvas=await topology(session,matches[0].target,'canvas');
      const triangles=await topology(session,matches[0].target,'local','triangles');
      const settings=options(part);
      const fit=solveContinuousWave(canvas,triangles,settings.anchors,settings);
      maxAmplitude=Math.min(maxAmplitude,fit.amplitude);
    }
    const result=await applyContinuousWave(session,continuous,objects,options(continuous));
    if(sourceSide) {
      const hand=await applyContinuousWave(session,resting,objects,options(resting));
      if(hand.records[0].amplitude!==result.records[0].amplitude)fail('PALM_SLEEVE_AMPLITUDE_MISMATCH');
      result.records.push(...hand.records);
    }
    if(split) {
      const lower=await applyContinuousWave(session,fore,objects,options(fore));
      const fill=await applyContinuousWave(session,backing,objects,options(backing));
      if([lower,fill].some(x=>x.records[0].amplitude!==result.records[0].amplitude))
        fail('PALM_SLEEVE_AMPLITUDE_MISMATCH');
      await session.step('split-elbow-backing-visibility','keyform_apply',{changes:splitGreetingStops.map(([value,lift])=>({
        op:'set',target:fill.records[0].target,key:{ParamWave:value},channels:{opacity:Math.min(1,Math.max(0,(lift-.04)/.15))}
      }))});
      result.records.push(...lower.records,...fill.records);
    }
    if(palm) {
      const alternative=await applyContinuousWave(session,palm,objects,options(palm));
      const source=resting?await applyContinuousWave(session,resting,objects,options(resting)):result;
      if([source,alternative].some(record=>record.records[0].amplitude!==result.records[0].amplitude))
        fail('PALM_SLEEVE_AMPLITUDE_MISMATCH');
      const sourceTarget=source.records[0].target,palmTarget=alternative.records[0].target;
      // Exchange the art during the low arm lift, before the visible greeting.
      // Both sleeves share the same shoulder/elbow field. Preserve source art
      // exactly at rest and after lowering, including its original hand.
      // Reuse authored geometry stops. Extra scalar-only stops make this
      // engine's MOC bundler reject the mesh grid and export a static sleeve.
      const visibility=palmVisibility;
      await session.step('wave-palm-visibility','keyform_apply',{changes:visibility.flatMap(([value,opacity])=>[
        {op:'set',target:sourceTarget,key:{ParamWave:value},channels:{opacity:1-opacity}},
        {op:'set',target:palmTarget,key:{ParamWave:value},channels:{opacity}}
      ])});
      result.records.push(...alternative.records,...(resting?source.records:[]));
      result.palmTransition={visibility,sharedSleeve:!!resting};
    }
    const folds=parts.find(p=>p.tags.includes('elbow-fold')&&p.tags.includes('wave'));
    if(folds)result.elbowFabric=await applyElbowFabric(session,folds,objects,result.records[0],options(continuous));
    return result;
  }
  const raised=parts.filter(p=>p.tags.includes('gesture')&&p.tags.includes('wave')&&p.tags.includes('raised'));
  const records=[];
  for(const part of raised)for(const o of objects.filter(o=>o.layerId===part.id&&o.target.startsWith('mesh:'))) {
    const declaredAnchors=waveAnchors(part),target=o.target;
    const entry=registration?.records?.find(r=>r.layerId===part.id);
    if(registration&&!entry)fail('WAVE_RETURN_TARGET_MISSING');
    const anchors=entry?{...declaredAnchors,shoulderPins:entry.commonShoulderSupport}:declaredAnchors;
    const prefix=entry?'wave-single-arm-return-v4-':'wave-';
    const cells=waveCells(anchors,{singleArm:!!entry});
    const detail=(await session.query('workspace_inspect',{target})).data,parameters=await session.list('parameters');
    const defaults=Object.fromEntries(Object.keys(detail.axes??{}).map(id=>{
      const p=parameters.find(p=>p.id===id);if(!p)fail('WAVE_GEOMETRY_PARAMETER_MISSING');return [id,p.default];
    }));
    // Seed every cell before any deformation; inserting a later cell by sampling
    // a partly edited lattice compounded the blink field in the earlier G1 run.
    await session.step('wave-seed-lift-'+part.id,'author_axis',{parameter:{id:'ParamWaveLift',min:0,max:1,default:0},shapes:[.25,.5,.75,1].map(value=>({target,value,operations:[{type:'translate',delta:[0,0]}]}))});
    await session.step('wave-seed-wrist-'+part.id,'author_axis',{parameter:{id:'ParamWaveWrist',min:-1,max:1,default:0},shapes:waveCells(anchors).filter(c=>c.wrist!==0).map(c=>({target,value:c.wrist,key:{ParamWaveLift:c.lift},operations:[{type:'translate',delta:[0,0]}]}))});
    if(entry)await session.step(prefix+'seed-wave-'+part.id,'author_axis',{parameter:{id:'ParamWave',min:0,max:1,default:0},shapes:cells.filter(c=>c.wave!==0).map(c=>({target,value:c.wave,key:{ParamWaveLift:c.lift,ParamWaveWrist:c.wrist},operations:[{type:'translate',delta:[0,0]}]}))});
    // This dedicated raised-arm mesh owns the new field; parent body motion stays
    // inherited. Capture canvas positions only after the mesh's geometry is rest.
    const captureFile=entry?path.join(session.dir,prefix+'baseline-'+part.id+'.json'):null;
    let capture;
    if(entry)try{capture=JSON.parse(await fs.readFile(captureFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
    if(entry&&session.journal.done[prefix+'rest-'+part.id]&&!capture)fail('WAVE_RETURN_BASELINE_MISSING');
    checked(await session.step(prefix+'rest-'+part.id,'keyform_apply',{changes:[{op:'reset',target,all_keys:true,to:'rest'}]}));
    const local=await topology(session,target,'local'),triangles=await topology(session,target,'local','triangles');
    if(capture&&(capture.projectId!==session.journal.projectId||capture.target!==target||capture.registrationSha256!==registration.artifact.sha256||
      JSON.stringify(local)!==JSON.stringify(capture.local)||JSON.stringify(triangles)!==JSON.stringify(capture.triangles)))fail('WAVE_RETURN_BASELINE_CHANGED');
    const canvas=capture?.canvas??await topology(session,target,'canvas');
    if(entry&&!capture)await fs.writeFile(captureFile,JSON.stringify({projectId:session.journal.projectId,state:session.journal.state,target,
      registrationSha256:registration.artifact.sha256,local,canvas,triangles},null,2)+'\n',{flag:'wx'});
    const map=canvasRegistration(local,canvas),solved=solveWaveKeys({points:canvas,triangles,anchors,values:cells.map(c=>c.value),poses:cells,returnPose:entry?.returnPose});
    const interpolation=checkWaveInterpolation(canvas,triangles,cells,solved.keys);
    let occlusion;
    if(entry) {
      const source=registration.sources.find(s=>s.layerId===part.id),maskSource=registration.sources.find(s=>s.layerId===entry.occlusion.layerId);
      if(!source||!maskSource)fail('WAVE_RETURN_MASK_MISSING');
      const read=async s=>decodePng(await fs.readFile(await safePath(session.ctx.taskRoot,s.path)));
      occlusion=waveReturnCoverage({points:canvas,triangles,posed:solved.keys[cells.findIndex(c=>c.wave===0&&c.lift===0&&c.wrist===0)].points,
        image:await read(source),rect:source.rect,mask:await read(maskSource),maskRect:maskSource.rect,hand:declaredAnchors.hand,radius:entry.occlusion.sourceHandRadius});
      if(!occlusion.passed)fail('WAVE_RETURN_HAND_NOT_OCCLUDED',occlusion);
    }
    const targetPoints=solved.keys.map((k,i)=>k.value===0&&cells[i].returnLift===0?local.map(p=>[...p]):k.points.map(map.toLocal)),current=cells.map(()=>local.map(p=>[...p]));
    // The public schema permits 16 operations of 16 landmarks. Later batches use
    // the exact predicted input frame after earlier disjoint selections moved.
    for(let start=0;start<local.length;start+=256) {
      const changes=cells.map((c,k)=>{
        const xs=current[k].map(p=>p[0]),ys=current[k].map(p=>p[1]),bounds=[Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)];
        const normalize=([x,y])=>[(x-bounds[0])/(bounds[2]-bounds[0]),(y-bounds[1])/(bounds[3]-bounds[1])],operations=[];
        for(let i=start;i<Math.min(local.length,start+256);i+=16){const end=Math.min(local.length,i+16),indices=Array.from({length:end-i},(_,j)=>i+j);operations.push({type:'landmarks',selection:{indices},from:indices.map(i=>normalize(current[k][i])),to:indices.map(i=>normalize(targetPoints[k][i]))});}
        for(let i=start;i<Math.min(local.length,start+256);i++)current[k][i]=targetPoints[k][i];
        return {target,key:{...defaults,...(c.wave===undefined?{}:{ParamWave:c.wave}),ParamWaveLift:c.lift,ParamWaveWrist:c.wrist},operations};
      });
      for(let j=0;j<changes.length;j+=64)checked(await session.step(prefix+'absolute-arap-'+part.id+'-'+start+(entry?'-'+j:''),'rig_deform',{changes:changes.slice(j,j+64)}));
    }
    if(entry) {
      const restTargets=objects.filter(o=>o.layerId===entry.restLayerId&&o.target.startsWith('mesh:'));
      if(!restTargets.length)fail('WAVE_RETURN_REST_MESH_MISSING');
      const changes=[{target,opacity:1},...restTargets.map(o=>({target:o.target,opacity:0}))].map(o=>({op:'multi_key',targets:[o.target],opacity:o.opacity}));
      await session.step(prefix+'visibility-'+part.id,'keyform_apply',{changes});
      await session.step(prefix+'enable-'+part.id,'object_edit_appearance',{edits:[{action:'visibility',kind:'mesh',id:target.slice(5),visible:true}]});
      await session.step(prefix+'depth-'+part.id,'layer_draw_order',{target,order:entry.drawOrder});
    }
    records.push({layerId:part.id,target,anchors,declaredAnchors,...(entry?{returnRegistration:entry,registrationArtifact:registration.artifact,occlusion}:{}),registration:{maxError:map.maxError,matrix:map.matrix,localCenter:map.localCenter,canvasCenter:map.canvasCenter},vertexCount:local.length,triangleCount:triangles.length,pinned:solved.pinned,handles:solved.handles,free:solved.free,cuff:solved.cuff,controlRegion:solved.controlRegion,
      interpolation,ownership:entry?'single_raised_return':'switch_layers',resetGeometryAxes:Object.keys(defaults),keyforms:cells.map((c,i)=>({...c,minAreaRatio:solved.keys[i].minAreaRatio})),validation:'native geometry and actual parameter pixels still required'});
  }
  if(!records.length)fail('WAVE_RAISED_MESH_MISSING');return {method:registration?'anchored_arap_single_arm_wave_lift_wrist':'anchored_arap_absolute_four_lifts_and_wrist',records};
}

// Angles and joint distances come from this character's registered source canvas.
const continuousStops=[[0,0,0],[.09,.18,0],[.18,.41,0],[.27,.68,0],[.36,.89,0],[.45,1,-1],
  [.53,1,1],[.61,1,-1],[.69,1,1],[.76,.91,0],[.83,.68,0],[.90,.41,0],[.96,.18,0],[1,0,0]];
// With one side-view hand, the forearm must carry the greeting. A held elbow
// plus repeated wrist rotations reads as a mechanical flick of the fingers.
const sideGreetingStops=continuousStops.map(([value,lift,turn])=>[
  value,({.45:.91,.53:1,.61:.91,.69:.97})[value]??lift,turn,
]);
// Keep the lift moving through the middle of the rise. The painted sleeve,
// hand and elbow backing share these stops so their contact stays registered.
const splitGreetingStops=sideGreetingStops.map(([value,lift,turn])=>[
  value,({.09:.16,.18:.34,.27:.54,.36:.73})[value]??lift,turn,
]);
const palmVisibility=[[0,0],[.125,0],[.135,1],[.875,1],[.885,0],[1,0]];
export const palmWaveSamples=Object.freeze([
  ...palmVisibility.slice(1,-1).flatMap(([value],i,keys)=>
    i%2===0?[value,(value+keys[i+1][0])/2,keys[i+1][0]]:[]),
  .45,.53,.69,.96
].sort((a,b)=>a-b));
// Turn through a narrow hand silhouette before changing its painted surface.
// Keep the original motion samples for callers without alternate palm art.
const palmStops=[...continuousStops,...[.125,.135,.145,.875,.885,.895].map(value=>{
  const i=continuousStops.findIndex(([v])=>v>value),a=continuousStops[i-1],b=continuousStops[i];
  const t=(value-a[0])/(b[0]-a[0]);
  return [value,a[1]+(b[1]-a[1])*t,a[2]+(b[2]-a[2])*t];
})].sort((a,b)=>a[0]-b[0]);
export function greetingAxes(fingertips,{wristOnly=false}={}) {
  if(!fingertips?.length)return [];
  return [
    {id:'ParamGreetingWrist',semantic:'action.wave.wrist',min:0,max:1,default:0},
    ...(wristOnly?[]:fingertips).map((_,i)=>({id:'ParamGreetingFinger'+(i+1),semantic:'action.wave.finger.'+(i+1),min:0,max:1,default:0})),
  ];
}
export function continuousWaveAnchors(part,parts=[]) {
  const a=part.rigging?.continuousWave;
  if(a?.version!==1||![a.shoulder,a.elbow,a.wrist].every(point)||![-1,1].includes(a.direction)||
    !Array.isArray(a.degrees)||a.degrees.length!==3||
    !a.degrees.every((v,i)=>Number.isFinite(v)&&v>0&&v<=[45,145,30][i]))
    fail('CONTINUOUS_WAVE_ANCHORS_INVALID');
  if(a.restRelease!==undefined&&(!Number.isFinite(a.restRelease)||a.restRelease<=0||a.restRelease>.18||a.approach!=='outward_split')||
    a.balanceLead!==undefined&&(!Number.isFinite(a.balanceLead)||a.balanceLead<=0||a.balanceLead>8))
    fail('CONTINUOUS_WAVE_BALANCE_INVALID');
  const rest=parts.find(p=>p.tags.includes('palm-rest-variant'));
  const sleeve=parts.find(p=>p.tags.includes('continuous')&&p.tags.includes('wave'));
  const fore=parts.find(p=>p.tags.includes('split-forearm'));
  const split=rest&&sleeve&&(part===rest||part===sleeve||part.tags.includes('palm-variant')||
    part===fore||part.tags.includes('split-elbow-backing'));
  const contains=(r,[x,y])=>r&&x>=r.left&&x<r.left+r.width&&y>=r.top&&y<r.top+r.height;
  const jointRects=split?[sleeve.rect,rest.rect,...(fore?[fore.rect]:[])]:[part.rect];
  if(![a.shoulder,a.elbow,a.wrist].every(p=>jointRects.some(r=>contains(r,p))))
    fail('CONTINUOUS_WAVE_ANCHORS_OUTSIDE_LAYER');
  const tipRect=split&&(part===sleeve||part===fore||part.tags.includes('split-elbow-backing'))?rest.rect:part.rect;
  if(a.fingertips&&(!Array.isArray(a.fingertips)||a.fingertips.length<2||a.fingertips.length>5||
    !a.fingertips.every(p=>point(p)&&contains(tipRect,p))))
    fail('CONTINUOUS_WAVE_HAND_ANCHORS_INVALID');
  const span=distance(a.shoulder,a.wrist),elbow=distance(a.shoulder,a.elbow);
  if(span<12||elbow/span<.25||elbow/span>.75||distance(a.elbow,a.wrist)<8)fail('CONTINUOUS_WAVE_ANCHORS_INVALID');
  return a;
}

export function solveContinuousWave(points,triangles,anchors,options={}) {
  // Try the declared motion first. Wide sleeves can fold over themselves at the
  // elbow, so fit the amplitude against the actual native mesh before writing keys.
  let fit;
  for(const amplitude of [1,.9,.8,.7,.6].filter(value=>value<=(options.maxAmplitude??1))) {
    fit=continuousWaveFit(points,triangles,anchors,amplitude,options);
    if(fit.minAreaRatio>=.15)return {...fit,amplitude};
  }
  fail('CONTINUOUS_WAVE_TRIANGLE_COLLAPSE',{minAreaRatio:fit.minAreaRatio,amplitude:.6});
}

function continuousWaveFit(points,triangles,anchors,amplitude,{fabric=false,passive=false,palmTransition=false,sharedSleeve=false,sourceSide=false,splitPart}={}) {
  const originalStops=splitPart?splitGreetingStops:sourceSide?sideGreetingStops:palmTransition?palmStops:continuousStops;
  // The split sleeve gets its balance from the parent torso. Additional
  // local stops would put the cuff and hand on different motion grids.
  const localLead=splitPart?0:anchors.balanceLead??0;
  const stops=localLead?[...originalStops,[.035,0,0],[.98,0,0]].sort((a,b)=>a[0]-b[0]):originalStops;
  const [ox,oy]=anchors.shoulder,[wx,wy]=anchors.wrist;
  const span=Math.hypot(wx-ox,wy-oy),ux=(wx-ox)/span,uy=(wy-oy)/span;
  const elbow=(anchors.elbow[0]-ox)*ux+(anchors.elbow[1]-oy)*uy;
  if(!triangles.length||elbow/span<.25||elbow/span>.75)fail('CONTINUOUS_WAVE_ANCHORS_INVALID');
  const smooth=v=>{const t=Math.max(0,Math.min(1,v));return t*t*(3-2*t);};
  const [shoulderDeg,elbowDeg,wristDeg]=anchors.degrees;
  const outwardProfile=sourceSide&&anchors.approach==='outward_profile';
  const tips=anchors.fingertips??[],articulated=tips.length>0;
  const dimensions=fabric||passive?0:greetingAxes(tips,{wristOnly:sourceSide}).length;
  const cells=Array.from({length:2**dimensions},(_,mask)=>Array.from({length:dimensions},(_,i)=>(mask>>i)&1));
  const tipControls=(sourceSide?[]:tips).map((tip,i)=>{
    const length=distance(anchors.wrist,tip);
    const neighbors=tips.filter((_,j)=>j!==i);
    const spacing=Math.min(...neighbors.map(p=>distance(p,tip)));
    const direction=[(tip[0]-wx)/length,(tip[1]-wy)/length];
    return {tip,direction,span:length*.54,width:spacing*1.10,bend:Math.min(length*.14,spacing*.49),spacing,neighbors};
  });
  // A single palm texture supports an in-plane wrist turn. It cannot represent
  // pronation: squeezing the webbing would retain front-facing creases on a
  // side-facing silhouette. Keep the art proportional through the turn.
  const [hx,hy]=tips.reduce(([x,y],[tx,ty])=>[x+(tx-wx)/tips.length,y+(ty-wy)/tips.length],[0,0]);
  const palmLength=Math.hypot(hx,hy)||1,px=hx/palmLength,py=hy/palmLength;
  const distort=(original,hand,lift,control,value)=>{
    let [x,y]=original;
    const activation=palmTransition?lift:1;
    if(control) {
      const {tip,direction:[dx,dy],span,width,bend,spacing,neighbors}=control;
      const along=(x-tip[0])*dx+(y-tip[1])*dy;
      const across=-(x-tip[0])*dy+(y-tip[1])*dx;
      // Spread the flex across the webbing so a thin triangle cannot pinch
      // shut, while keeping the neighboring fingertips independently pinned.
      const separation=smooth(Math.min(...neighbors.map(p=>distance(original,p)))/(spacing*.70));
      const reach=smooth(1-Math.abs(across)/width)*smooth(1-Math.abs(along)/span)*separation;
      // The proximal bend turns the knuckle while the tip folds inward.
      const knuckle=smooth(1-Math.abs((along+span*.34)/(span*.55)));
      const transverse=(.13+.07*knuckle)*bend;
      const flex=palmTransition?.42:1;
      x-=(dx*bend+dy*transverse)*reach*amplitude*activation*flex;
      y-=(dy*bend-dx*transverse)*reach*amplitude*activation*flex;
    }
    const along=(x-wx)*px+(y-wy)*py,across=-(x-wx)*py+(y-wy)*px;
    const roll=palmTransition?0:hand*activation*smooth(along/(palmLength*.62));
    const fan=palmTransition?0:lift*(1-hand)*.20*amplitude*smooth((along-palmLength*.38)/(palmLength*.63));
    const exchange=palmTransition&&!sourceSide?Math.max(smooth((value-.09)/.035)*smooth((.18-value)/.035),
      smooth((value-.83)/.045)*smooth((.96-value)/.065)):0;
    const narrow=.40*exchange*smooth(along/(palmLength*.48));
    const turn=across*(1-(1-.29*roll+fan)*(1-narrow));
    const pitch=(along*.09+across*.14)*roll;
    return [x+py*turn-px*pitch,y-px*turn-py*pitch];
  };
  const pose=(x,y,value,lift,wrist,hand)=>{
    const s=(x-ox)*ux+(y-oy)*uy,z=-(x-ox)*uy+(y-oy)*ux;
    if(s<=0)return [x,y];
    if(splitPart&&anchors.restRelease) {
      const release=anchors.restRelease*(1-smooth(lift/.38));
      x+=release*(s*.23+Math.max(0,s-span*.98)*.69);
      y+=release*s*.035;
    }
    const lead=localLead*
      (smooth(value/.035)*(1-smooth((value-.035)/.15))-.55*smooth((value-.88)/.1)*(1-smooth((value-.98)/.02)));
    if(lift===0&&!hand&&!lead)return [x,y];
    if(splitPart) {
      const [ex,ey]=anchors.elbow;
      const rad=anchors.direction*Math.PI/180*amplitude*lift;
      const turn=rad*(shoulderDeg+3*wrist),flex=rad*elbowDeg;
      const rotate=([x,y],jx,jy,a)=>[jx+(x-jx)*Math.cos(a)-(y-jy)*Math.sin(a),
        jy+(x-jx)*Math.sin(a)+(y-jy)*Math.cos(a)];
      let handPose=[x,y];
      if(splitPart==='hand') {
        // Keep the cuff planted. Let the existing curved fingers yield a
        // little as the wrist catches up, without widening the webbing or
        // projecting a different palm surface.
        const reach=(x-wx)*px+(y-wy)*py;
        const flexReach=smooth((reach/palmLength-.28)/.64);
        const yieldBy=palmLength*.043*lift*amplitude*hand*flexReach;
        handPose=rotate([x-px*yieldBy+py*yieldBy*.62*anchors.direction,
          y-py*yieldBy-px*yieldBy*.62*anchors.direction],
        wx,wy,rad*wristDeg*(.28+hand)*smooth((s-span*.97)/(span*.13)));
      }
      // Bend the sleeve along an arc tangent to the rigid upper and lower
      // spans. Every layer follows the same cross sections at the elbow.
      const band=span*.30;
      const [hx,hy]=handPose;
      const along=(hx-ex)*ux+(hy-ey)*uy;
      if(along>=band)handPose=rotate(handPose,ex,ey,flex);
      else if(along>-band&&flex!==0) {
        const across=-(hx-ex)*uy+(hy-ey)*ux;
        const angle=flex*(along+band)/(2*band);
        const radius=band/Math.tan(flex/2);
        const localX=-band+(radius-across)*Math.sin(angle);
        const localY=radius-(radius-across)*Math.cos(angle);
        handPose=[ex+ux*localX-uy*localY,ey+uy*localX+ux*localY];
      }
      return rotate(handPose,ox,oy,turn*smooth(s/(span*.24)));
    }
    if(outwardProfile) {
      // Preserve the painted forearm and hand as separate rigid spans.
      // The inside of the sleeve needs more room to compress than its outside.
      const [ex,ey]=anchors.elbow,ez=-(ex-ox)*uy+(ey-oy)*ux;
      const band=.115+.145*smooth((anchors.direction*(z-ez)+span*.02)/(span*.07));
      const u=Math.max(0,Math.min(1,(s-elbow+span*band)/(2*span*band)));
      const elbowBlend=u-.08*Math.sin(2*Math.PI*u);
      const rad=anchors.direction*Math.PI/180*amplitude*lift;
      const rotateAbout=([px,py],jx,jy,angle)=>{
        const a=px-jx,b=py-jy,c=Math.cos(angle),n=Math.sin(angle);
        return [jx+a*c-b*n,jy+a*n+b*c];
      };
      const cuffBlend=smooth((s-span*.95)/(span*.10));
      const tuck=(z-ez)*.18*lift*amplitude*smooth((z-ez+span*.015)/(span*.08))*smooth(1-Math.abs(s-elbow)/(span*.35));
      const handPose=rotateAbout([x+uy*tuck,y-ux*tuck],wx,wy,rad*wristDeg*(.75+hand)*cuffBlend);
      const forearm=rotateAbout(handPose,ex,ey,rad*elbowDeg*elbowBlend);
      return rotateAbout(forearm,ox,oy,rad*(shoulderDeg+3*wrist)*smooth(s/(span*.22)));
    }
    // A broad sleeve folds at the inner elbow if the full bend is concentrated
    // there. Spread curvature around the measured elbow for the split rig.
    const elbowHalf=sharedSleeve?.36:.23;
    const elbowStart=palmTransition?elbow-span*elbowHalf:elbow*(articulated?.54:.73);
    const elbowSpan=span*(palmTransition?elbowHalf*2:.64);
    const shoulderTurn=((palmTransition?-shoulderDeg:shoulderDeg)+(sourceSide?4*wrist:0))*lift+lead;
    const angle=k=>anchors.direction*Math.PI/180*amplitude*(
      shoulderTurn*smooth(k/(span*.25))+
      lift*((palmTransition?17*smooth((k-elbow)/(span*.29)):0)+
        elbowDeg*smooth((k-elbowStart)/elbowSpan))+
      (articulated?-lift*wristDeg*.30+hand*(sourceSide?12*lift:palmTransition?15*lift:29):lift*wrist*wristDeg)*
        (palmTransition?smooth((k-span*.98)/(span*.13)):
          articulated?smooth((k-span*.90)/(span*.24)):smooth((k-span*.78)/(span*.36))));
    let cx=ox,cy=oy;
    for(let k=0;k<s;k+=2){const d=Math.min(2,s-k),a=angle(k+d/2),c=Math.cos(a),n=Math.sin(a);
      cx+=d*(ux*c-uy*n);cy+=d*(ux*n+uy*c);}
    const a=angle(s),c=Math.cos(a),n=Math.sin(a);
    const shoulder=smooth(s/(span*.12))*smooth((elbow-s)/(span*.24));
    const bend=smooth(1-Math.abs(s-elbow)/(span*.31));
    const inner=anchors.direction*z>0;
    // Keep the root pinned. At the elbow the inner sleeve compresses and
    // gathers toward the bend; the outer cloth keeps almost its full width.
    // The upper sleeve settles near the elbow; the loose cuff trails and
    // reverses later on the way down, without moving the wrist attachment.
    const cuffBand=smooth((s-elbow)/(span*.18))*smooth((span-s)/(span*.19));
    const lag=articulated?Math.sin(value*Math.PI*4+.3)*lift*amplitude*(palmTransition?.42:1):0;
    const width=z*(1+lift*amplitude*(.07*shoulder-(inner ? (articulated?.30:.24) : .05)*bend)+lag*.19*cuffBand);
    const crease=articulated?Math.sin((s-elbow)/(span*.10))*span*.012:0;
    const gather=inner?(-(s-elbow)*.16+crease)*lift*amplitude*bend*smooth(Math.abs(z)/(span*.09)):0;
    const drape=lag*span*.038*cuffBand;
    return [cx-(width+drape)*(uy*c+ux*n)+gather*(ux*c-uy*n),cy+(width+drape)*(ux*c-uy*n)+gather*(ux*n+uy*c)];
  };
  const fields=stops.map(([value,lift,wrist])=>Array.from({length:dimensions?2:1},(_,hand)=>{
    const project=(original,control)=>pose(...distort(original,hand,lift,control,value),value,lift,wrist,hand);
    return {base:points.map(p=>project(p)),digits:tipControls.map(control=>points.map(p=>project(p,control)))};
  }));
  const sample=(field,digits,i,axis)=>{
    const v=field.base[i][axis];
    return digits.reduce((sum,digit,j)=>sum+digit*(field.digits[j][i][axis]-v),v);
  };
  const keys=stops.flatMap(([value],k)=>cells.map(controls=>{
    const [hand=0,...digits]=controls,field=fields[k][hand];
    return {value,controls,points:points.map((_,i)=>[sample(field,digits,i,0),sample(field,digits,i,1)])};
  }));
  const restAreas=triangles.map(([i,j,k])=>cross(points[i],points[j],points[k]));
  if(restAreas.some(a=>!Number.isFinite(a)||Math.abs(a)<1e-9))fail('CONTINUOUS_WAVE_REST_DEGENERATE');
  // Digit offsets are additive in each wrist pose. Check the full corner grid
  // and intermediate positions along the wrist and the lift interpolation.
  const checks=dimensions?[...cells,...cells.filter(c=>!c[0]).map(c=>[.5,...c.slice(1)]),Array(dimensions).fill(.5)]:cells;
  let minAreaRatio=1;
  for(let k=1;k<fields.length;k++)for(const [hand=0,...digits] of checks) {
    const at=j=>points.map((_,i)=>[0,1].map(axis=>{
      const lo=sample(fields[j][0],digits,i,axis);
      return hand?lo*(1-hand)+sample(fields[j][1],digits,i,axis)*hand:lo;
    }));
    const before=at(k-1),after=at(k);
    for(let n=0;n<=8;n++) {
      const posed=before.map(([x,y],i)=>[x+(after[i][0]-x)*n/8,y+(after[i][1]-y)*n/8]);
      for(const [i,[a,b,c]] of triangles.entries())minAreaRatio=Math.min(minAreaRatio,cross(posed[a],posed[b],posed[c])/restAreas[i]);
    }
  }
  return {keys,minAreaRatio};
}

async function applyElbowFabric(session,part,objects,arm,options) {
  const matches=objects.filter(o=>o.layerId===part.id&&o.target.startsWith('mesh:'));
  if(matches.length!==1)fail('ELBOW_FABRIC_MESH_REQUIRED');
  const {target,parentId}=matches[0];
  if(parentId!==objects.find(o=>o.target===arm.target)?.parentId)fail('ELBOW_FABRIC_PARENT_MISMATCH');
  const local=await topology(session,target,'local'),triangles=await topology(session,target,'local','triangles');
  const canvas=await topology(session,target,'canvas'),registration=canvasRegistration(local,canvas);
  const {keys,minAreaRatio}=continuousWaveFit(canvas,triangles,arm.anchors,arm.amplitude,{...options,fabric:true});
  if(minAreaRatio<.15)fail('ELBOW_FABRIC_GEOMETRY_UNSAFE',{minAreaRatio});
  const axis={id:'ParamWave',min:0,max:1,default:0};
  const xs=local.map(p=>p[0]),ys=local.map(p=>p[1]),l=Math.min(...xs),t=Math.min(...ys);
  const w=Math.max(...xs)-l,h=Math.max(...ys)-t;
  const norm=([x,y])=>[(x-l)/w,(y-t)/h];
  await session.step('elbow-fabric-seed','author_axis',{parameter:axis,shapes:keys.filter(k=>k.value).map(({value})=>({
    target,value,operations:[{type:'translate',delta:[0,0]}]}))});
  const changes=keys.filter(k=>k.value>0&&k.value<1).map(({value,points})=>({
    target,key:{ParamWave:value},operations:Array.from({length:Math.ceil(local.length/16)},(_,group)=>{
      const indices=Array.from({length:Math.min(16,local.length-group*16)},(_,i)=>group*16+i);
      return {type:'landmarks',selection:{indices},from:indices.map(i=>norm(local[i])),to:indices.map(i=>norm(registration.toLocal(points[i])))};
    }),
  }));
  if(local.length>256)fail('ELBOW_FABRIC_MESH_TOO_DENSE',{vertexCount:local.length});
  checked(await session.step('elbow-fabric-shape','rig_deform',{changes}));
  const opacity=continuousStops.map(([value,lift])=>({op:'set',target,key:{ParamWave:value},
    channels:{opacity:Math.max(0,(lift-.37)/.63)**1.2}}));
  await session.step('elbow-fabric-opacity','keyform_apply',{changes:opacity});
  return {target,layerId:part.id,minAreaRatio,opacity:opacity.map(k=>[k.key.ParamWave,k.channels.opacity])};
}

export async function applyContinuousWave(session,part,objects,options={}) {
  const anchors=options.anchors??continuousWaveAnchors(part);
  const matches=objects.filter(o=>o.layerId===part.id&&o.target.startsWith('mesh:'));
  if(matches.length!==1)fail('CONTINUOUS_WAVE_MESH_REQUIRED');
  const {target}=matches[0],axes=options.passive?[]:greetingAxes(anchors.fingertips,{wristOnly:options.sourceSide}),articulated=axes.length>0;
  const prefix=(articulated?'wave-continuous-v3-':'wave-continuous-v1-')+part.id;
  const local=await topology(session,target,'local'),triangles=await topology(session,target,'local','triangles');
  const canvas=await topology(session,target,'canvas'),registration=canvasRegistration(local,canvas);
  const defaults=await session.capturePlan(prefix+'-original-defaults',async()=>{
    const detail=(await session.query('workspace_inspect',{target})).data,parameters=await session.list('parameters');
    const authored=new Set(['ParamWave',...axes.map(axis=>axis.id)]);
    return Object.fromEntries(Object.keys(detail.axes??{}).filter(id=>!authored.has(id)).map(id=>{
      const p=parameters.find(p=>p.id===id);if(!p)fail('WAVE_GEOMETRY_PARAMETER_MISSING');return [id,p.default];
    }));
  });
  const {keys,minAreaRatio,amplitude}=solveContinuousWave(canvas,triangles,anchors,options);
  const parameter={id:'ParamWave',min:0,max:1,default:0};
  const noop=[{type:'translate',delta:[0,0]}];
  checked(await session.step(prefix+'-seed','author_axis',{parameter,
    shapes:keys.filter(k=>k.value&&!k.controls.some(Boolean)).map(({value})=>({target,value,operations:noop}))}));
  const controlKey=(values,count=axes.length)=>Object.fromEntries(axes.slice(0,count).map((p,i)=>[p.id,values[i]]));
  for(const [i,{id,min,max,default:neutral}] of axes.entries()) {
    const shapes=keys.filter(k=>k.controls[i]&&!k.controls.slice(i+1).some(Boolean)).map(k=>({target,value:1,
      key:{ParamWave:k.value,...controlKey(k.controls,i)},operations:noop}));
    for(let start=0;start<shapes.length;start+=64)checked(await session.step(prefix+'-seed-'+id+'-'+start,'author_axis',{
      parameter:{id,min,max,default:neutral},shapes:shapes.slice(start,start+64)}));
  }
  const poses=keys.filter(k=>anchors.restRelease||k.controls.some(Boolean)||k.value>0&&k.value<1).map(k=>{
    const to=k.points.map(registration.toLocal),current=local.map(p=>[...p]),pose=[];
    for(let start=0;start<local.length;start+=256) {
      const xs=current.map(p=>p[0]),ys=current.map(p=>p[1]);
      const l=Math.min(...xs),r=Math.max(...xs),t=Math.min(...ys),b=Math.max(...ys);
      const norm=([x,y])=>[(x-l)/(r-l),(y-t)/(b-t)],operations=[];
      for(let i=start;i<Math.min(local.length,start+256);i+=16){
        const indices=Array.from({length:Math.min(local.length-i,16)},(_,j)=>i+j);
        operations.push({type:'landmarks',selection:{indices},from:indices.map(k=>norm(current[k])),to:indices.map(k=>norm(to[k]))});
      }
      for(let i=start;i<Math.min(local.length,start+256);i++)current[i]=to[i];
      pose.push({target,key:{...defaults,ParamWave:k.value,...controlKey(k.controls)},operations});
    }
    return pose;
  });
  // PSD2Live evaluates safety after the transaction. Partial vertex edits
  // leave a seam between moved and unmoved vertices until the key is complete.
  const posesPerEdit=Math.min(articulated?8:128,Math.floor(128/poses[0].length));
  if(!posesPerEdit)fail('CONTINUOUS_WAVE_KEY_EXCEEDS_ENGINE_LIMIT',{vertexCount:local.length});
  for(let i=0;i<poses.length;i+=posesPerEdit) {
    const changes=poses.slice(i,i+posesPerEdit).flat();
    checked(await session.step(prefix+'-atomic-shapes-'+i,'rig_deform',{changes}));
  }
  return {method:articulated?'continuous_sleeve_arm_v3':'continuous_sleeve_arm_v1',records:[{target,layerId:part.id,anchors,
    vertexCount:local.length,triangleCount:triangles.length,minAreaRatio,amplitude,
    values:[...new Set(keys.map(k=>k.value))],...(articulated?{handAxes:axes.map(p=>p.id),keyforms:keys.length}:{}),
    validation:'Native geometry only. Sleeve, occlusion and return need continuous video review.'}]};
}
