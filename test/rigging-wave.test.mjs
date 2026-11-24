import test from 'node:test';
import assert from 'node:assert/strict';
import {canvasRegistration,solveWaveKeys,applyAnchoredWave,waveCells,checkWaveInterpolation,loadWaveReturnRegistration,solveContinuousWave,continuousWaveAnchors} from '../src/rigging/wave.mjs';
import {controlRecipe} from '../src/rigging/controls.mjs';
import {previewClip} from '../src/rigging/recipe.mjs';

// Synthetic strip with an exact affine parent: a unit test, never Hachi visual evidence.
function strip() {
  const points=[],triangles=[];
  for(let y=0;y<=12;y++)for(let x=0;x<=4;x++)points.push([x*2,y*2]);
  for(let y=0;y<12;y++)for(let x=0;x<4;x++) {
    const a=y*5+x,b=a+1,c=a+5,d=c+1;triangles.push([a,b,d],[a,d,c]);
  }
  return {points,triangles};
}
const anchors={coordinateSpace:'canvas_top_left_y_down',shoulderPins:[[-1,-1],[9,-1],[9,3],[-1,3]],elbow:[4,12],hand:[4,23],jointRadius:8,loweredDegrees:45};

test('a separate resting hand shares the source sleeve joints without weakening ordinary layer bounds',()=>{
  const joints={version:1,shoulder:[12,8],elbow:[12,48],wrist:[12,84],degrees:[7,120,12],direction:1,
    fingertips:[[10,102],[18,100]]};
  const rigging={continuousWave:joints};
  const sleeve={tags:['gesture','wave','continuous'],rect:{left:2,top:2,width:20,height:83},rigging};
  const hand={tags:['palm-rest-variant'],rect:{left:6,top:84,width:15,height:22},rigging};
  assert.throws(()=>continuousWaveAnchors(sleeve),/CONTINUOUS_WAVE_HAND_ANCHORS_INVALID/);
  assert.throws(()=>continuousWaveAnchors(hand),/CONTINUOUS_WAVE_ANCHORS_OUTSIDE_LAYER/);
  assert.equal(continuousWaveAnchors(sleeve,[sleeve,hand]),joints);
  assert.equal(continuousWaveAnchors(hand,[sleeve,hand]),joints);
  const sourceSide={...hand,id:'source-hand',tags:['palm-rest-variant','source-side-wave']};
  const brief={intent:{headMotion:{yawDegrees:12,pitchDegrees:8,rollDegrees:8},eyes:{blink:true},mouth:{speech:true},
    expressions:[],actions:[{id:'wave',label:'wave'}]}};
  const recipe=controlRecipe([{...sleeve,id:'source-sleeve'},sourceSide],brief);
  assert.deepEqual(recipe.gaps,[]);
  assert.deepEqual(recipe.specs.find(p=>p.id==='ParamWave').sampleValues,[.45,.53,.69]);
  assert.deepEqual(recipe.motions[0].curves.map(c=>c.parameter),['ParamWave','ParamGreetingWrist']);
  const wrist=recipe.motions[0].curves[1].keys;
  assert(wrist.some(k=>k.value>0));
  assert.equal(wrist[0].value,0);
  assert.equal(wrist.at(-1).value,0);
  assert.deepEqual(previewClip(brief,true,recipe.motions[0]).curves.find(c=>c.parameter==='ParamGreetingWrist').keys.slice(1),
    wrist.map(key=>({...key,time:key.time+2})));
  hand.rect.height=14;
  assert.throws(()=>continuousWaveAnchors(sleeve,[sleeve,hand]),/CONTINUOUS_WAVE_HAND_ANCHORS_INVALID/);
});

test('continuous wave fits a broad sleeve without allowing flipped triangles or altering neutral',()=>{
  const {points,triangles}=strip();
  // The gathered sleeve fits the older, narrower fixture at full amplitude.
  // Exercise fallback with a wider cut that still exceeds the safe bend.
  const source=points.map(([x,y])=>[(x-4)*7.5,y*6.5]);
  const joints={shoulder:[0,0],elbow:[0,62],wrist:[0,125],degrees:[31,113,13],direction:1};
  const fitted=solveContinuousWave(source,triangles,joints);
  assert(fitted.amplitude<1&&fitted.amplitude>=.6);
  assert(fitted.minAreaRatio>=.15);
  assert.deepEqual(fitted.keys[0].points,source);
  assert.deepEqual(fitted.keys.at(-1).points,source);
  assert.equal(solveContinuousWave(source.map(([x,y])=>[x*.65,y]),triangles,joints).amplitude,1);
  assert.throws(()=>solveContinuousWave(source.map(([x,y])=>[x*2,y]),triangles,joints),/CONTINUOUS_WAVE_TRIANGLE_COLLAPSE/);
});

test('split sleeve preserves forearm length and shares both joints across the greeting',()=>{
  const anchors={shoulder:[0,0],elbow:[0,60],wrist:[0,120],degrees:[26,88,9],direction:1,
    fingertips:[[-5,141],[6,138]],approach:'outward_split'};
  const points=[[-6,48],[6,48],[0,60],[-6,81],[6,81],[0,120],[-5,141],[6,138]];
  const triangles=[[0,1,2],[2,3,4],[3,4,5],[5,6,7]];
  const fit=(splitPart,source=anchors)=>solveContinuousWave(points,triangles,source,
    {splitPart,sourceSide:true,palmTransition:true,passive:splitPart!=='hand'});
  const sections=['upper','forearm','hand','backing'];
  const [upper,forearm,hand,backing]=sections.map(section=>fit(section));
  assert.deepEqual(sections.map(section=>fit(section,{...anchors,balanceLead:1})),[upper,forearm,hand,backing]);
  const at=(result,value,controls='')=>result.keys.find(k=>k.value===value&&k.controls.join()===controls).points;
  const dist=([x,y],[u,v])=>Math.hypot(x-u,y-v);
  for(const value of [.09,.45,.53,.69,.90]) {
    const u=at(upper,value), f=at(forearm,value), h=at(hand,value,'1');
    assert.deepEqual(u,f);
    assert.deepEqual(at(backing,value),f);
    assert(dist(f[5],h[5])<1e-9);
    // The curved section moves the old elbow vertex. Check two vertices
    // that are beyond the curve in the rigid part of this fixture.
    assert(Math.abs(dist(f[5],f[6])-dist(points[5],points[6]))<1e-9);
  }
  assert.deepEqual(at(forearm,0),points);
  assert.deepEqual(at(hand,1,'0'),points);
});

test('continuous wave separates wrist and fingertip shapes without pulling the shoulder or resting pose',()=>{
  const {points,triangles}=strip(),source=points.map(([x,y])=>[(x-4)*3,y*7]);
  const joints={shoulder:[0,0],elbow:[0,63],wrist:[0,140],degrees:[29,106,12],direction:1,
    fingertips:[[-12,168],[6,168]]};
  const fitted=solveContinuousWave(source,triangles,joints);
  const at=(value,hand,first,second=0)=>fitted.keys.find(k=>k.value===value&&
    k.controls.join()=== [hand,first,second].join()).points;
  const shoulder=2,tip=source.findIndex(([x,y])=>x===-12&&y===168);
  assert(fitted.minAreaRatio>=.15);
  assert.deepEqual(at(0,0,0),source);
  assert.deepEqual(at(1,0,0),source);
  assert.deepEqual(at(.53,1,1)[shoulder],source[shoulder]);
  assert.notDeepEqual(at(.53,1,0)[tip],at(.53,0,0)[tip]);
  assert.notDeepEqual(at(.53,1,1)[tip],at(.53,1,0)[tip]);
  const other=source.findIndex(([x,y])=>x===6&&y===168);
  assert.deepEqual(at(.53,1,1)[other],at(.53,1,0)[other]);
  assert.notDeepEqual(at(.53,1,0,1)[other],at(.53,1,0)[other]);
  assert.deepEqual(at(.53,1,0,1)[tip],at(.53,1,0)[tip]);
});

test('continuous wave retains independent stronger digits on the native silver sleeve mesh',async()=>{
  const {readFile}=await import('node:fs/promises');
  const {points,triangles,anchors}=JSON.parse(await readFile(new URL('./fixtures/silver-continuous-wave.json',import.meta.url),'utf8'));
  const fit=solveContinuousWave(points,triangles,anchors);
  assert.equal(fit.amplitude,1);
  assert(fit.minAreaRatio>=.15);
  const raised=fit.keys.find(key=>key.value===.53&&key.controls.join()==='1,0,0,0,0');
  const largest=controls=>fit.keys.find(key=>key.value===.53&&key.controls.join()===controls).points
    .reduce((n,[x,y],i)=>Math.max(n,Math.hypot(x-raised.points[i][0],y-raised.points[i][1])),0);
  for(const controls of ['1,1,0,0,0','1,0,1,0,0','1,0,0,1,0','1,0,0,0,1'])assert(largest(controls)>6);
});

test('continuous wave submits a complete dense key before native safety checks',async()=>{
  const points=[],triangles=[],target='mesh:sleeve',requests=[];
  for(let y=0;y<34;y++)for(let x=0;x<9;x++){
    points.push([x+6,y*4+5]);
    if(y&&x){const d=y*9+x,c=d-1,b=d-9,a=b-1;triangles.push([a,b,d],[a,d,c]);}
  }
  const projectId='project',state='state';
  const session={capturePlan:async(_key,read)=>read(),journal:{projectId,state},schema:async()=>({request_schema:{properties:{space:{}}}}),list:async()=>[],
    query:async(op,{space,section})=>{
      if(op==='workspace_inspect')return {data:{axes:{}}};
      return {data:{project_id:projectId,state,target,section,coordinate_space:space==='canvas'?'canvas_x_right_y_down':'mesh_rest',
        vertex_count:points.length,triangle_count:triangles.length,items:(section==='vertices'?points:triangles).map((row,i)=>[i,...row])}};
    },
    step:async(_name,op,args)=>{if(op==='rig_deform')requests.push(args.changes);return {data:{}};}};
  const part={id:'sleeve',tags:['gesture','wave','continuous'],rect:{left:0,top:0,width:26,height:150},
    rigging:{continuousWave:{version:1,shoulder:[10,5],elbow:[10,67],wrist:[10,130],direction:1,degrees:[31,113,13]}}};
  const result=await applyAnchoredWave(session,[part],[{layerId:'sleeve',target}],{intent:{actions:[{id:'wave'}]}});
  const submitted=new Set();
  for(const changes of requests){
    assert(changes.length<=128);
    const keys=new Map();
    for(const change of changes){
      assert(change.operations.length<=16);
      const key=change.key.ParamWave;
      const indices=keys.get(key)??[];
      indices.push(...change.operations.flatMap(o=>o.selection.indices));
      keys.set(key,indices);
    }
    for(const [key,indices] of keys){
      assert(!submitted.has(key));
      submitted.add(key);
      assert.deepEqual(indices,points.map((_,i)=>i));
    }
  }
  assert.deepEqual([...submitted],result.records[0].values.slice(1,-1));
});

test('wave uses paired runtime vertices, preserves shear, and refuses a non-affine or collapsed mapping',()=> {
  const {points}=strip(),canvas=points.map(([x,y])=>[100+30*x+2*y,20-3*x+15*y]);
  const map=canvasRegistration(points,canvas);
  for(const p of points)assert(Math.hypot(...map.toLocal(map.toCanvas(p)).map((v,i)=>v-p[i]))<1e-9);
  const broken=structuredClone(canvas);broken[10][0]+=.2;
  assert.throws(()=>canvasRegistration(points,broken),/WAVE_PARENT_NON_AFFINE/);
  assert.throws(()=>canvasRegistration(points,points.map(()=>[1,1])),/WAVE_PARENT_SINGULAR/);
});

test('four absolute ARAP keys retain the shoulder, move the distal hand and preserve signed triangle area',()=> {
  const input=strip(),result=solveWaveKeys({...input,anchors});
  assert.deepEqual(result.keys.map(k=>k.value),[.25,.5,.75,1]);
  for(const key of result.keys) {
    assert(key.minAreaRatio>.05);
    for(const i of result.pinned)assert.deepEqual(key.points[i],input.points[i]);
    const index=61,p=input.points[index],q=key.points[index],a=key.value*Math.PI/4;
    const expected=[4+Math.cos(a)*(p[0]-4)-Math.sin(a)*(p[1]-12),12+Math.sin(a)*(p[0]-4)+Math.cos(a)*(p[1]-12)];
    assert(Math.hypot(q[0]-expected[0],q[1]-expected[1])<1e-8);
  }
  assert.deepEqual(input,strip(),'input baseline is immutable');
});

test('wave refuses unmeasured anchors, absent attachment pins and unsafe topology',()=> {
  const input=strip();
  assert.throws(()=>solveWaveKeys({...input,anchors:{...anchors,coordinateSpace:'guess'}}),/WAVE_ANCHORS_INVALID/);
  assert.throws(()=>solveWaveKeys({...input,anchors:{...anchors,shoulderPins:[[100,100],[101,100],[100,101]]}}),/WAVE_SHOULDER_UNSAMPLED/);
  assert.throws(()=>solveWaveKeys({...input,triangles:[[0,0,1]],anchors}),/WAVE_REST_DEGENERATE/);
});

test('production wave writes the absolute field through schema-sized batches and checks every captured index',async()=>{
  const points=[],triangles=[];
  for(let y=0;y<=24;y++)for(let x=0;x<=12;x++)points.push([x*2/3,y]);
  for(let y=0;y<24;y++)for(let x=0;x<12;x++){const a=y*13+x,b=a+1,c=a+13,d=c+1;triangles.push([a,b,d],[a,d,c]);}
  const cells=new Map(),calls=[],key=k=>k.ParamWaveLift+':'+k.ParamWaveWrist;
  const session={journal:{projectId:'fixture-project',state:'fixture-state'},schema:async()=>({request_schema:{properties:{space:{}}}}),
    list:async()=>[],query:async(op,req)=>{
      if(op==='workspace_inspect')return {data:{axes:{}}};
      const source=req.section==='triangles'?triangles:points;
      return {data:{project_id:'fixture-project',state:'fixture-state',target:req.target,section:req.section,
        coordinate_space:req.space==='canvas'?'canvas_x_right_y_down':'mesh_rest',vertex_count:points.length,triangle_count:triangles.length,
        items:source.map((p,i)=>[i,...p])}};
    },step:async(name,op,req)=>{
      calls.push({name,op,req});
      if(op==='rig_deform')for(const change of req.changes) {
        const p=cells.get(key(change.key))??points.map(p=>[...p]),xs=p.map(p=>p[0]),ys=p.map(p=>p[1]);
        const b=[Math.min(...xs),Math.min(...ys),Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys)];
        assert(change.operations.length<=16);
        for(const o of change.operations) {
          assert(o.from.length<=16&&o.to.length===o.from.length);
          for(let j=0;j<o.selection.indices.length;j++) {
            const i=o.selection.indices[j],from=[b[0]+b[2]*o.from[j][0],b[1]+b[3]*o.from[j][1]];
            assert(Math.hypot(from[0]-p[i][0],from[1]-p[i][1])<1e-8,'later batches must use the current input bounds');
            p[i]=[p[i][0]+b[2]*(o.to[j][0]-o.from[j][0]),p[i][1]+b[3]*(o.to[j][1]-o.from[j][1])];
          }
        }
        cells.set(key(change.key),p);
      }
      return {data:{}};
    }};
  const part={id:'raised',tags:['gesture','wave','raised'],rigging:{wave:anchors}};
  const result=await applyAnchoredWave(session,[part],[{target:'mesh:raised',layerId:'raised'}],{intent:{actions:[{id:'wave'}]}});
  assert.equal(cells.size,15);assert.equal(calls.filter(c=>c.op==='rig_deform').length,2);
  assert.equal(calls[2].op,'keyform_apply','all identity cells precede the geometry-rest capture');
  const expected=solveWaveKeys({points,triangles,anchors,values:result.records[0].keyforms.map(k=>k.value)});
  for(let k=0;k<expected.keys.length;k++) {
    const cell=result.records[0].keyforms[k],actual=cells.get(cell.lift+':'+cell.wrist);
    for(let i=0;i<points.length;i++)assert(Math.hypot(...actual[i].map((v,j)=>v-expected.keys[k].points[i][j]))<1e-8);
  }
  assert.deepEqual(cells.get('0:0'),points,'neutral key must preserve exact rest points');
  const read=session.query;
  session.query=async(op,req)=>{const r=await read(op,req);if(req.space==='canvas')r.data.state='different-state';return r;};
  await assert.rejects(applyAnchoredWave(session,[part],[{target:'mesh:raised',layerId:'raised'}],{intent:{actions:[{id:'wave'}]}}),{code:'WAVE_TOPOLOGY_CAPTURE_MISMATCH'});
});

test('native r8 wide elbow keeps the hand handle out of the shoulder and solves the measured full range',async()=>{
  const {readFile}=await import('node:fs/promises');
  const input=JSON.parse(await readFile(new URL('./fixtures/hachi-r8-wave.json',import.meta.url),'utf8'));
  const values=[0,.25,.5,.75,1].flatMap(lift=>[-1,0,1].map(wrist=>lift+wrist*18/input.anchors.loweredDegrees));
  const r=solveWaveKeys({...input,values});
  assert(!r.handles.includes(90),'near-shoulder upper arm must never become a rigid hand handle');
  for(const key of r.keys){
    assert(key.minAreaRatio>.05);
    for(const i of r.pinned)assert.deepEqual(key.points[i],input.points[i]);
    for(const i of r.handles){
      const angle=key.value*input.anchors.loweredDegrees*Math.PI/180,[x,y]=input.points[i].map((v,j)=>v-input.anchors.elbow[j]);
      const expected=[input.anchors.elbow[0]+Math.cos(angle)*x-Math.sin(angle)*y,input.anchors.elbow[1]+Math.sin(angle)*x+Math.cos(angle)*y];
      assert(Math.hypot(...key.points[i].map((v,j)=>v-expected[j]))<1e-8,'full measured rotation is retained');
    }
  }
  assert(r.free.length>1,'the joint transition must span the measured arm, not one isolated vertex');
  assert.equal(r.controlRegion.declaredJointRadius,12,'frozen source anchors stay unchanged');
  for(const i of r.controlRegion.disconnectedRest)for(const key of r.keys)assert.deepEqual(key.points[i],input.points[i]);
  // Cubism blends the authored lattice. Safe endpoints alone do not establish a
  // safe intermediate wave/wrist combination.
  const area=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  for(let lift=0;lift<4;lift++)for(let wrist=0;wrist<2;wrist++)for(const u of [.25,.5,.75])for(const v of [.25,.5,.75]){
    const p=input.points.map((p,i)=>p.map((x,j)=>
      (1-u)*(1-v)*r.keys[lift*3+wrist].points[i][j]+u*(1-v)*r.keys[(lift+1)*3+wrist].points[i][j]+
      (1-u)*v*r.keys[lift*3+wrist+1].points[i][j]+u*v*r.keys[(lift+1)*3+wrist+1].points[i][j]));
    for(const t of input.triangles)assert(area(...t.map(i=>p[i]))/area(...t.map(i=>input.points[i]))>.05);
  }
});

test('measured native return retains full angle, fixes default independently and keeps all trilinear wave/lift/wrist cells safe',async()=>{
  const {readFile}=await import('node:fs/promises');
  const input=JSON.parse(await readFile(new URL('./fixtures/hachi-r8-wave.json',import.meta.url),'utf8'));
  const entry=JSON.parse(await readFile(new URL('./fixtures/hachi-r8-wave-return.json',import.meta.url),'utf8'));
  const anchors={...input.anchors,shoulderPins:entry.commonShoulderSupport},cells=waveCells(anchors,{singleArm:true});
  const result=solveWaveKeys({...input,anchors,poses:cells,values:cells.map(c=>c.value),returnPose:entry.returnPose});
  assert.equal(result.keys.length,75);assert(Math.min(...result.keys.map(k=>k.minAreaRatio))>.34);
  assert(checkWaveInterpolation(input.points,input.triangles,cells,result.keys).minAreaRatio>.36);
  const defaults=result.keys.filter((k,i)=>cells[i].wave===0);
  for(const key of defaults)assert.deepEqual(key.points,defaults[0].points,'Wave=0 ignores both residual lift and wrist');
  const raised=result.keys[cells.findIndex(c=>c.wave===1&&c.lift===0&&c.wrist===0)];
  assert.deepEqual(raised.points,input.points,'neutral raised pose retains exact source rest');
  assert.equal(cells.find(c=>c.wave===1&&c.lift===1&&c.wrist===0).value*anchors.loweredDegrees,132.28899982575652);
});

test('registered return requires complete measured inputs and refuses missing/malformed/changed sources before an edit',async()=>{
  const fs=await import('node:fs/promises'),path=await import('node:path'),os=await import('node:os');
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'wave-return-'))),dir=path.join(root,'rigging');await fs.mkdir(dir);
  const session={dir,ctx:{taskRoot:root,taskId:'t',candidateId:'c',revision:8,waveReturnRegistrationRequired:true}};
  try {
    await assert.rejects(loadWaveReturnRegistration(session,[]),{code:'WAVE_RETURN_REGISTRATION_REQUIRED'});
    const source=(id,tags)=>({id,tags,imagePath:id+'.png',rect:{left:0,top:0,width:1,height:1}});
    const parts=[source('raised',['gesture','wave','raised']),source('rest',['gesture','wave','rest']),source('skirt',['lower-body'])];
    const {createHash}=await import('node:crypto');const bytes=Buffer.from('test-only-source');
    for(const p of parts)await fs.writeFile(path.join(root,p.imagePath),bytes);
    const entry=JSON.parse(await fs.readFile(new URL('./fixtures/hachi-r8-wave-return.json',import.meta.url),'utf8'));
    const contract={version:'measured-wave-return-v1',ownership:'single_raised_return',coordinateSpace:'canvas_top_left_y_down',identity:{taskId:'t',candidateId:'c',revision:8},sources:parts.map(p=>({layerId:p.id,path:p.imagePath,rect:p.rect,sha256:createHash('sha256').update(bytes).digest('hex')})),records:[{...entry,layerId:'raised',restLayerId:'rest',occlusion:{...entry.occlusion,layerId:'skirt'}}]};
    const write=async value=>fs.writeFile(path.join(dir,'wave-return-registration.json'),JSON.stringify(value));
    await write(contract);assert.equal((await loadWaveReturnRegistration(session,parts)).ownership,'single_raised_return');
    for(const mutate of [r=>delete r.records[0].returnPose,r=>r.records.push(r.records[0]),r=>r.sources.pop(),r=>r.records[0].commonShoulderSupport[0][0]=null,
      r=>r.records[0].returnPose.source[1]=r.records[0].returnPose.source[0],r=>r.records[0].returnPose.target[1]=r.records[0].returnPose.target[0]]){
      const bad=structuredClone(contract);mutate(bad);await write(bad);await assert.rejects(loadWaveReturnRegistration(session,parts),e=>e.code.startsWith('WAVE_RETURN_'));
    }
    await write(contract);await fs.writeFile(path.join(root,'rest.png'),'changed');await assert.rejects(loadWaveReturnRegistration(session,parts),{code:'WAVE_RETURN_SOURCE_HASH_MISMATCH'});
    await fs.unlink(path.join(dir,'wave-return-registration.json'));await fs.writeFile(path.join(root,'contract.json'),JSON.stringify(contract));await fs.symlink(path.join(root,'contract.json'),path.join(dir,'wave-return-registration.json'));
    await assert.rejects(loadWaveReturnRegistration(session,parts),{code:'WAVE_RETURN_REGISTRATION_PATH_INVALID'});
  } finally {await fs.rm(root,{recursive:true,force:true});}
});

test('single-arm ownership retains generation visibility tracks while final evidence measures geometry',()=>{
  const parts=[{id:'rest',tags:['gesture','wave','rest']},{id:'raised',tags:['gesture','wave','raised'],rigging:{wave:anchors}},
    {id:'waist',tags:['body','underlay','waist']}].map(p=>({...p,geometry:{canvasBounds:[0,0,10,20]}}));
  const brief={intent:{actions:[{id:'wave'}]}},legacy=controlRecipe(parts,brief),single=controlRecipe(parts,brief,{waveOwnership:'single_raised_return'});
  assert.deepEqual(single.variants,legacy.variants,'fresh generation still creates actual opacity keys');
  assert.deepEqual(single.variants.map(v=>[v.layer_id,v.switch_id]),[['rest',0],['raised',1]]);
  assert.deepEqual(single.finalVariants,[],'refined wave is verified by real geometry/pixels rather than obsolete layer switching');
  assert.deepEqual(single.gaps,[]);assert.deepEqual(single.specs,legacy.specs);assert.deepEqual(single.motions,legacy.motions);
});

test('body-edge-supported native mesh keeps the corrected return safe without changing raised source or residual reset',async()=>{
  const {readFile}=await import('node:fs/promises');
  const input=JSON.parse(await readFile(new URL('./fixtures/hachi-body-boundary-wave.json',import.meta.url),'utf8'));
  assert.equal(input.points.length,161);assert.equal(input.triangles.length,186);
  const cells=waveCells(input.anchors,{singleArm:true});
  const result=solveWaveKeys({...input,poses:cells,values:cells.map(c=>c.value)});
  assert.equal(result.keys.length,75);assert(Math.min(...result.keys.map(k=>k.minAreaRatio))>.05);
  assert(checkWaveInterpolation(input.points,input.triangles,cells,result.keys).minAreaRatio>.05);
  const raised=result.keys[cells.findIndex(c=>c.wave===1&&c.lift===0&&c.wrist===0)];
  assert.deepEqual(raised.points,input.points,'measured inset affects only the return path');
  const defaults=result.keys.filter((k,i)=>cells[i].wave===0);
  for(const key of defaults)assert.deepEqual(key.points,defaults[0].points,'reset ignores residual Lift/Wrist');
  for(const key of result.keys)for(const i of result.pinned)assert.deepEqual(key.points[i],input.points[i],'shoulder support remains exact');
});

test('generated palm adds a fifth independent finger without changing legacy continuous ownership',()=>{
  const rig={version:1,shoulder:[25,5],elbow:[25,65],wrist:[25,130],direction:1,degrees:[29,106,12]};
  const part={id:'source',tags:['gesture','wave','continuous'],rect:{left:0,top:0,width:60,height:180},
    rigging:{continuousWave:{...rig,fingertips:[[10,165],[20,171],[30,172],[40,167]]}}};
  const palm={...structuredClone(part),id:'palm',opacity:0,tags:['gesture','wave','palm-variant']};
  palm.rigging.continuousWave.fingertips.push([49,155]);
  const recipe=controlRecipe([part,palm],{intent:{actions:[{id:'wave',label:'wave'}]}});
  assert.deepEqual(recipe.gaps,[]);
  assert.deepEqual(recipe.specs.find(p=>p.id==='ParamWave').sampleValues,
    [.125,.13,.135,.45,.53,.69,.875,.88,.885,.96]);
  assert(recipe.specs.some(p=>p.id==='ParamGreetingFinger5'));
  assert.equal(recipe.motions[0].curves.filter(c=>c.parameter.startsWith('ParamGreetingFinger')).length,5);
  for(const curve of recipe.motions[0].curves)if(curve.parameter.startsWith('ParamGreeting'))
    for(const key of curve.keys)assert(key.value>=0&&key.value<=1);
  const legacy=controlRecipe([part],{intent:{actions:[{id:'wave',label:'wave'}]}});
  assert.deepEqual(legacy.specs.find(p=>p.id==='ParamWave').sampleValues,[.45,.53,.69]);
  assert.equal(legacy.specs.filter(p=>p.id.startsWith('ParamGreetingFinger')).length,4);
});

test('palm exchange retains full lift and ignores residual hand controls at rest on native meshes',async()=>{
  const {readFile}=await import('node:fs/promises');
  const meshes=JSON.parse(await readFile(new URL('./fixtures/silver-palm-native.json',import.meta.url),'utf8'));
  for(const mesh of meshes) {
    const fit=solveContinuousWave(mesh.points,mesh.triangles,mesh.anchors,{palmTransition:true});
    assert.equal(fit.amplitude,1,mesh.id);
    assert(fit.minAreaRatio>=.15,mesh.id);
    for(const key of fit.keys.filter(k=>k.value===0||k.value===1)) {
      for(let i=0;i<mesh.points.length;i++)assert(Math.hypot(key.points[i][0]-mesh.points[i][0],key.points[i][1]-mesh.points[i][1])<1e-6);
    }
    for(const value of [.125,.135,.875,.885])assert(fit.keys.some(k=>k.value===value));
  }
});
