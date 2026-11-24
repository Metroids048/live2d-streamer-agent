import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateSync} from 'node:zlib';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {decodePng,crc32,alphaGeometry,eyeRimFade,eyeRimAperture,inspectTopology,pixelDifference,inspectGif} from '../src/rigging/geometry.mjs';
import {BASE_PARAMETERS,ENGINE_COMMIT,materialGaps,planRefinements,poseSets,previewClip} from '../src/rigging/recipe.mjs';
import {buildRig,safePath,parameterBindings,parameterAvailability,rigCriteriaFor} from '../src/rigging/index.mjs';
import {sharedHeadShapes} from '../src/rigging/shared-face.mjs';

// Explicit synthetic encoder, used only by automated geometry/engine fixtures.
export function fixturePng(width,height,pixel=()=>[220,120,80,255]) {
  const chunk=(tag,p)=>{const t=Buffer.from(tag),n=Buffer.alloc(4),crc=Buffer.alloc(4);n.writeUInt32BE(p.length);crc.writeUInt32BE(crc32(Buffer.concat([t,p])));return Buffer.concat([n,t,p,crc]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
  const rows=[];for(let y=0;y<height;y++){rows.push(Buffer.from([0]));for(let x=0;x<width;x++)rows.push(Buffer.from(pixel(x,y)));}
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.concat(rows))),chunk('IEND',Buffer.alloc(0))]);
}
export const brief={intent:{headMotion:{yawDegrees:12,pitchDegrees:8,rollDegrees:6},eyes:{blink:true,gaze:true},mouth:{speech:true},expressions:[{id:'happy',label:'开心'},{id:'angry',label:'生气'}],actions:[{id:'reset',label:'恢复'}]}};

test('真实解码与 alpha 边界不把透明 RGB 当轮廓/地标',()=> {
  const image=decodePng(fixturePng(8,8,(x,y)=>[255,0,0,x>=2&&x<=5&&y>=1&&y<=6?255:0]));
  const g=alphaGeometry(image,{left:100,top:200,width:80,height:160});
  assert.deepEqual(g.pixelBounds,[2,1,6,7]);assert.deepEqual(g.canvasBounds,[120,220,160,340]);
  assert.equal(g.semanticLandmarksVerified,false);assert.equal(g.opaquePixels,24);
  assert.equal(g.contourControlMethod,'alpha_area_quartile_supports');assert.equal(g.contourControls.length,5);
  const b=fixturePng(2,2);b[40]^=1;assert.throws(()=>decodePng(b),/PNG_CRC/);
  assert.throws(()=>decodePng(Buffer.from('png')),/PNG_SIGNATURE/);
});

test('只比较有效 RGBA 像素，拒绝取景尺寸变化',()=> {
  const a=decodePng(fixturePng(3,2,()=>[0,0,0,0])),b=decodePng(fixturePng(3,2,()=>[200,150,80,0]));
  assert.equal(pixelDifference(a,b).changedPixels,0);b.rgba[3]=255;assert.equal(pixelDifference(a,b).changedPixels,1);
  assert.throws(()=>pixelDifference(a,decodePng(fixturePng(2,2))),/CAMERA_CHANGED/);
});

test('网格拒绝退化、无效索引、翻绕向及非流形，不用面积绝对值掩盖问题',()=> {
  const vertices=[[0,0,0],[1,1,0],[2,1,1],[3,0,1]];
  assert.equal(inspectTopology(vertices,[[0,0,1,2],[1,0,2,3]]).ok,true);
  const bad=inspectTopology(vertices,[[0,0,1,1],[1,0,2,1],[2,0,1,2],[3,0,1,3],[4,0,1,99]]);
  for(const code of ['INVALID_TRIANGLE','INCONSISTENT_WINDING','NON_MANIFOLD_EDGE'])assert(bad.issues.some(x=>x.code===code));
  assert(inspectTopology([[0,0,0],[1,1,0],[2,2,0]],[[0,0,1,2]]).issues.some(x=>x.code==='DEGENERATE_TRIANGLE'));
});

test('空 axes / 继承空 axes / 同图渲染不能将参数判可动',()=> {
  const binding={target:'mesh:eye',layerId:'eye',directAxes:{P:[0]},inherited:[{target:'warp:w',parameters:['P'],axes:{P:[0]}}]};
  assert.deepEqual(parameterBindings('P',[binding]),[]);binding.inherited[0].axes.P=[-1,0,1];
  const actual=parameterBindings('P',[binding]);assert.equal(actual.length,1);
  assert.equal(parameterAvailability(actual,[{changedPixels:0}]),false);assert.equal(parameterAvailability(actual,[]),false);
  assert.equal(parameterAvailability(actual,[{changedPixels:5},{changedPixels:0}]),false);
  assert.equal(parameterAvailability(actual,[{changedPixels:5},{changedPixels:7}]),true);
});

test('配方从实际层ID和 alpha 几何建立输出；不凭空创建饰品',()=> {
  const measured=alphaGeometry(decodePng(fixturePng(8,8,(x,y)=>[0,0,0,x>=Math.floor(y/3)&&x<=6?255:0])),{left:0,top:0,width:8,height:8});
  const layer=(id,tags)=>({id,tags,geometry:{...measured,root:[.3,0],tip:[.6,1]}});
  const parts=[layer('f',['face']),layer('hair-02',['hair','front']),layer('hair-01',['hair','back']),layer('e',['eye','lash','left']),layer('m',['mouth','open'])];
  const plan=planRefinements(parts,parts.map(p=>({target:'mesh:'+p.id,layerId:p.id})),brief);
  for(const s of plan.steps)assert(Object.keys(s.parameter).every(k=>['id','name','min','max','default','kind','repeat'].includes(k)),'author_axis rejects semantic/unit/owner metadata');
  assert(!plan.specs.some(p=>p.id.startsWith('ParamAccessory')));
  const strand=plan.steps.find(s=>s.parameter.id==='ParamHairStrand01');assert.equal(strand.shapes[0].target,'mesh:hair-01');
  assert.deepEqual(strand.shapes[0].operations[0].root,[.3,0]);assert.equal(strand.shapes[0].operations[0].type,'arc');
  assert(!plan.steps.some(s=>['ParamAngleX','ParamAngleY'].includes(s.parameter.id)));
  const head=sharedHeadShapes(parts,brief);
  assert(head.some(s=>s.shape.key?.ParamAngleY===8));
  assert(head.every(s=>s.shape.target==='warp:DeformHeadContainer'));
  assert.equal(head[0].shape.operations[0].from.length,16);
  const invalid=structuredClone(brief);invalid.intent.headMotion.yawDegrees=50;assert.throws(()=>planRefinements(parts,[],invalid),/UNSUPPORTED/);
});

test('素材缺失给出具体回补内容；双眼/开闭嘴不可由单个粗层替代',()=> {
  const gaps=materialGaps([{id:'face',tags:['face']},{id:'both-eyes',tags:['eye']}],brief);
  assert(gaps.some(g=>g.code==='EYE_MATERIAL_MISSING'&&g.message.includes('right')));
  assert(gaps.some(g=>g.code==='EYE_CLOSED_MATERIAL_MISSING'));
  assert(gaps.some(g=>g.code==='MOUTH_INTERIOR_MISSING'));
});

test('G1 and G2 keep generated body breath without the duplicate per-mesh scale that degenerated real triangles',()=> {
  const parts=[{id:'body',tags:['body'],geometry:{root:[.5,0],tip:[.5,1]}}];
  const objects=[{target:'mesh:body',layerId:'body'}];
  assert(!planRefinements(parts,objects,brief).steps.some(s=>s.parameter.id==='ParamBreath'));
  const plan=planRefinements(parts,objects,brief,{gate:'G1'});
  assert(!plan.steps.some(s=>s.parameter.id==='ParamBreath'));
  assert(plan.specs.some(s=>s.id==='ParamBreath'));
  assert.equal(plan.breathing.source,'generated_common_body_warp');
  assert.equal(plan.breathing.validation,'actual_parameter_pixels_required');
});

test('参数范围及姿态跟随 brief，连续预览回到默认值；不写真人已验',()=> {
  assert.equal(ENGINE_COMMIT.length,40);assert.equal(BASE_PARAMETERS.find(p=>p.id==='ParamEyeLOpen').default,1);
  assert.equal(BASE_PARAMETERS.find(p=>p.id==='ParamAngleX').max,45);
  const sets=poseSets(brief);assert.equal(sets.headXY.length,9);assert.deepEqual(sets.headXY[0],{ParamAngleX:-12,ParamAngleY:-8});
  const clip=previewClip(brief);assert(clip.name.includes('非摄像头'));
  for(const c of clip.curves){assert.equal(c.keys[0].value,c.keys.at(-1).value);assert.equal(c.keys.at(-1).time,8);}
});

test('GIF 单帧不会被解析成动态证据，截断文件拒绝',()=> {
  const b=Buffer.from('47494638396101000100800000000000ffffff21f904010a0000002c00000000010001000002024401003b','hex');
  const info=inspectGif(b);assert.equal(info.frames,1);assert.equal(info.durationSeconds,.1);
  assert.throws(()=>inspectGif(b.subarray(0,25)),/GIF_/);
});

async function artworkFixture(t,{coarse=false,controls=false,hiddenAlternates=false,waist=false,faceDetails=false}={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'rigging-bundle-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'artwork'));
  const tags=[['face'],['hair','front'],['hair','back'],['nose'],['neck'],['top'],['mouth','open'],['mouth','closed'],['teeth','upper'],['tongue'],
    ...['left','right'].flatMap(s=>[['eye','white',s],['eye','iris',s],['eye','lash',s],['eye','closed',s],['brow',s]])];
  if(hiddenAlternates)tags.push(['mouth','line','upper','open'],['mouth','line','lower','open']);
  if(controls)tags.push(['gesture','wave','rest'],['gesture','wave','raised'],['appearance','chest_bow','underlay'],['accessory','appearance','chest_bow']);
  if(controls||waist)tags.push(['body','underlay','waist']);
  if(faceDetails)tags.push(['eye','rim','left'],['eye','rim','right'],['hair','root']);
  const layers=(coarse?tags.slice(0,1):tags).map((tags,i)=>({id:'part-'+i,name:'Synthetic part '+i,tags,image:{path:`part-${i}.png`,width:8,height:8},rect:{left:10+i,top:20+i,width:80,height:100}}));
  if(controls) {
    for(const l of layers.filter(l=>l.tags.includes('wave')))l.rect={left:10,top:8,width:16,height:48};
    Object.assign(layers.find(l=>l.tags.includes('raised')),{visible:false,rigging:{wave:{coordinateSpace:'canvas_top_left_y_down',
      shoulderPins:[[9,7],[27,7],[27,14],[9,14]],elbow:[18,32],hand:[18,54],jointRadius:16,loweredDegrees:45}}});
  }
  if(waist)Object.assign(layers.at(-1),{visible:false,variant:{type:'switch',parameter:'ParamWave',switch_id:1}});
  if(hiddenAlternates)for(const l of layers.filter(l=>l.tags.includes('underlay')||l.tags.includes('closed')||l.tags.includes('open'))) {
    l.visible=false;l.variant={type:'switch',parameter:'ProviderSwitch',switch_id:1};
  }
  const artifacts=[];
  const put=async(relative,data)=>{await fs.writeFile(path.join(root,relative),data);artifacts.push({role:'synthetic_fixture',path:relative,sha256:createHash('sha256').update(data).digest('hex'),bytes:Buffer.byteLength(data)});};
  for(const [i,l] of layers.entries())await put('artwork/'+l.image.path,fixturePng(8,8,()=>[40+i,100+i,200-i,255]));
  await put('artwork/layout.json',JSON.stringify({format:'psd2live-layout',version:1,canvas:{width:200,height:240},layers}));
  await put('artwork/manifest.json',JSON.stringify({fixture:true,note:'No real segmentation or editor run'}));
  const bundle={schemaVersion:1,stage:'artwork',status:'completed',taskId:'fixture-task',candidateId:'fixture-candidate',revision:1,parentRevision:null,inputSha256:'a'.repeat(64),descriptionSha256:'b'.repeat(64),
    artifacts,checks:[],warnings:[],unresolved:[],layoutPath:'artwork/layout.json',artworkManifestPath:'artwork/manifest.json',brief:structuredClone(brief)};
  if(controls) {
    bundle.brief.intent.actions.push({id:'wave',label:'抬起一只手打招呼'});
    bundle.brief.intent.clothingVariants=[{id:'chest_bow',label:'摘戴胸前蝴蝶结'}];
  }
  const ctx={taskRoot:root,root,taskId:bundle.taskId,candidateId:bundle.candidateId,revision:1,parentRevision:null};
  return {root,bundle,ctx,layers};
}

function simulatedEngine(f,{moving=true,busy=false,reorderOnOpen=false,topologyChangedOnOpen=false,wrongRenderedParameter=false,ghostSwitch=false,mouthFormNeedsOpen=false}={}) {
  let state=0,project='other-before-import',savedPath,reopened=false;
  const parameters=structuredClone(BASE_PARAMETERS),axes=new Map([['warp:DeformHeadContainer',{}],...f.layers.map(l=>['mesh:'+l.id,{}])]),calls=[];
  const switches=new Map(),opacityKeys=new Map(),subdividedTopologies=new Map();
  const parents=new Map(f.layers.map(l=>['mesh:'+l.id,'DeformHeadContainer']));
  const fields={canvas_topology:['id','action','vertices'],mesh_get_topology:['target','space','section','offset','limit'],rig_create_warp:['id','name','targets','rows','columns','fit_local'],warp_set_topology:['target','rows','columns'],layer_replace_image:['layer_id','path','fit','rebuild_mesh'],layer_classify:['layer_id','type','role','side'],keyform_apply:['changes'],rig_deform:['changes'],layer_set_variant:['layer_id','parameter','variant','switch_id'],object_edit_appearance:['edits'],project_import_layout:['path','discard_unsaved'],settings_update:['changes'],layer_mesh_update:['layer_id','changes'],rig_generate:[],author_axis:['parameter','shapes'],project_save_as:['path'],project_save:[],project_open:['path','discard_unsaved'],project_export_model:['output_directory'],project_export_psd:['path','scale','include_generated_layers'],motion_put:['clip'],project_export_target:['target','output_directory','settings']};
  const engine={calls,async call(op,req,options) {
    calls.push({op,req});assert.equal(options.wait,false);
    if(op==='workspace_get_operation')return {data:{id:req.id,request_schema:{type:'object',additionalProperties:false,properties:Object.fromEntries(['state','project_id','request_id',...(fields[req.id]??[])].map(k=>[k,{}])),required:req.id==='layer_set_variant'?['layer_id','variant']:req.id==='layer_classify'?['layer_id','type','role']:fields[req.id]??[]}}};
    if(op==='job_list')return {data:{items:[],total:0}};
    if(op==='workspace_inspect') {
      const data={state:'s'+state,project_id:project};
      if(req.target) {
        const inherited=[{target:'warp:head',parameters:['ParamAngleX','ParamAngleY','ParamAngleZ']}];
        const parent=parents.get(req.target),parentAxes=axes.get('warp:'+parent);
        if(parentAxes)inherited.unshift({target:'warp:'+parent,parameters:Object.keys(parentAxes),axes:parentAxes});
        Object.assign(data,{forms:9,axes:axes.get(req.target)??{},parent,inherited,static:{masked_by:[]}});
      }
      else if(req.scope==='project')Object.assign(data,{loaded:true,busy});
      else if(req.scope==='layers')data.items=f.layers;
      else if(req.scope==='objects')data.items=[{target:'warp:DeformHeadContainer',parentId:'head'},...f.layers.map(l=>({target:'mesh:'+l.id,layerId:l.id,parentId:'DeformHeadContainer'}))];
      else if(req.scope==='parameters')data.items=reorderOnOpen&&reopened?[...parameters].reverse():parameters;
      else if(req.scope==='generation')Object.assign(data,{generated:true,pending_layers:[],pending_classifications:[]});
      else if(req.scope==='settings')throw new Error('3.6.7 rejects result.settings.drawOrderStep as an unknown field');
      if(req.target==='warp:head') {data.axes=Object.fromEntries(['X','Y','Z'].map(a=>['ParamAngle'+a,[-30,0,30]]));data.inherited=[];}
      if(req.target?.startsWith('mesh:')) {
        const v=switches.get(req.target.slice(5));
        if(v)data.channels=[{channel:'opacity',axes:{[v.parameter]:[0,1]}}];
        const curve=opacityKeys.get(req.target);
        if(curve)data.channels=[{channel:'opacity',axes:{[curve.axis]:[...curve.keys.keys()]}}];
      }
      return {data};
    }
    if(op==='mesh_get_topology') {
      let vertices=[[0,0],[1,0],[topologyChangedOnOpen&&reopened?.9:1,1],[0,1]],triangles=[[0,1,2],[0,2,3]];
      const raised=f.layers.find(l=>'mesh:'+l.id===req.target&&l.tags.includes('raised'));
      if(raised) {
        vertices=[];triangles=[];
        for(let y=0;y<=12;y++)for(let x=0;x<=4;x++)vertices.push([x*2,y*2]);
        for(let y=0;y<12;y++)for(let x=0;x<4;x++){const a=y*5+x,b=a+1,c=a+5,d=c+1;triangles.push([a,b,d],[a,d,c]);}
        if(req.space==='canvas')vertices=vertices.map(([x,y])=>[10+2*x,8+2*y]);
      }
      const subdivided=subdividedTopologies.get(req.target);
      if(subdivided)({vertices,triangles}=structuredClone(subdivided));
      if(subdivided&&topologyChangedOnOpen&&reopened)vertices[2][0]-=.1;
      const items=(req.section==='vertices'?vertices:triangles).map((v,i)=>[i,...v]);
      return {data:{state:'s'+state,project_id:project,target:req.target,section:req.section,coordinate_space:req.space==='canvas'?'canvas_x_right_y_down':'mesh_rest',
        vertex_count:vertices.length,triangle_count:triangles.length,bounds:[0,0,1,1],items:items.slice(req.offset??0,(req.offset??0)+(req.limit??4096))}};
    }
    if(op.startsWith('view_render')) {
      const value=Object.values(req.parameters??{}).at(-1)??0;
      const layer=req.include_layer_ids?.length===1?switches.get(req.include_layer_ids[0]):null;
      const curve=req.include_layer_ids?.length===1?opacityKeys.get('mesh:'+req.include_layer_ids[0]):null;
      const formHidden=mouthFormNeedsOpen&&Object.hasOwn(req.parameters??{},'ParamMouthForm')&&!(req.parameters.ParamMouthOpenY>0);
      const alpha=formHidden?0:curve?Math.round(255*(curve.keys.get(req.parameters?.[curve.axis]??1)??1)):layer&&!ghostSwitch&&(req.parameters?.[layer.parameter]??0)!==layer.switch_id?0:255;
      const rim=req.include_layer_ids?.length===1&&f.layers.find(l=>l.id===req.include_layer_ids[0])?.tags.includes('rim');
      const half=rim&&moving&&value===.5;
      return {data:{revisionId:'revision-'+state,appliedParameters:wrongRenderedParameter?{}:req.parameters??{},outOfRangeParameters:[],
        ...(req.poses?{tiles:req.poses.map(parameters=>({parameters,outOfRangeParameters:[]}))}:{})},images:[fixturePng(16,16,(_,y)=>[moving?(Math.round(value*50)+130)&255:130,90,200,rim&&(y<(half?5:2)||y>(half?8:9))?0:alpha])]};
    }
    assert(op in fields,op);assert.equal(req.state,'s'+state);assert.equal(req.project_id,project);assert(req.request_id);
    if(op==='canvas_topology') {
      assert.equal(req.action,'subdivide');assert.deepEqual(req.vertices,[0,1,2,3]);
      assert(!subdividedTopologies.has('mesh:'+req.id),'must not subdivide twice');
      assert(f.layers.some(l=>l.id===req.id&&l.tags.includes('mouth')&&l.tags.includes('open')));
      // Explicit native midpoint result for this synthetic square, retained on reopen.
      subdividedTopologies.set('mesh:'+req.id,{vertices:[[0,0],[1,0],[1,1],[0,1],[.5,0],[1,.5],[.5,.5],[.5,1],[0,.5]],
        triangles:[[0,4,6],[4,1,5],[6,5,2],[4,5,6],[0,6,8],[6,2,7],[8,7,3],[6,7,8]]});
      state++;return {data:{project_id:project,state:'s'+state,geometry_diagnostics:{safe:true,warnings:[],violations:[]}}};
    }
    if(op==='project_import_layout')project='fixture-owned';
    if(op==='project_open')reopened=true;
    if(op==='keyform_apply')for(const {target,key,channels} of req.changes) {
      if(!channels)continue; // Geometry resets have no opacity channel in this simulation.
      const [axis]=Object.keys(key),curve=opacityKeys.get(target)??{axis,keys:new Map()};
      curve.keys.set(key[axis],channels.opacity);opacityKeys.set(target,curve);
    }
    if(op==='layer_mesh_update') {
      // Pinned WorkspaceDocumentEdits.mesh UI ranges, not merely the permissive JSON number schema.
      for(const k of ['maxEdgeDistance','interiorDensity'])assert(req.changes[k]>=6&&req.changes[k]<=128,k+' outside PSD2Live UI range');
      assert(req.changes.edgeWidth>=.5&&req.changes.edgeWidth<=32);
    }
    if(op==='layer_set_variant') {
      if(req.variant==='none')switches.delete(req.layer_id);
      else {
        switches.set(req.layer_id,{...req,switch_id:req.variant==='toggle'?1:req.switch_id});
        if(!parameters.some(p=>p.id===req.parameter))parameters.push({id:req.parameter,min:0,max:1,default:0});
      }
    }
    if(op==='rig_generate')for(const l of f.layers.filter(l=>l.tags.includes('mouth')&&l.tags.includes('closed')))switches.set(l.id,{parameter:'ParamMouthOpenY',switch_id:0});
    if(op==='rig_generate')for(const [target] of axes) {
      const layer=f.layers.find(l=>'mesh:'+l.id===target);
      // Native facial meshes own local feature axes; head/body motion is inherited.
      // Giving every mesh every parameter concealed ownership mistakes in this fixture.
      const owned=layer?.tags.includes('brow')?[layer.tags.includes('left')?'ParamBrowLY':'ParamBrowRY']:
        layer?.tags.includes('mouth')?(layer.tags.includes('open')?['ParamMouthForm','ParamMouthOpenY']:['ParamMouthForm']):
        target==='warp:DeformHeadContainer'?['ParamAngleX','ParamAngleY','ParamAngleZ']:null;
      for(const p of parameters.filter(p=>owned?owned.includes(p.id):!['ParamWave','ParamChestBowHidden'].includes(p.id)))axes.get(target)[p.id]=[p.min,p.default,p.max];
    }
    if(op==='rig_create_warp'){axes.set('warp:'+req.id,{});for(const target of req.targets)parents.set(target,req.id);}
    if(op==='author_axis') {
      if(!parameters.some(p=>p.id===req.parameter.id))parameters.push({...req.parameter});
      for(const {target,value,key} of req.shapes) {
        const targetAxes=axes.get(target);
        for(const [id,coordinate] of Object.entries({...key,[req.parameter.id]:value})) {
          targetAxes[id]=[...new Set([...(targetAxes[id]??[]),parameters.find(p=>p.id===id).default,coordinate])].sort((a,b)=>a-b);
        }
      }
    }
    if(op==='project_save_as') {savedPath=req.path;await fs.writeFile(req.path,'PK_SYNTHETIC_NOT_A_REAL_PROJECT');}
    if(op==='project_save')await fs.writeFile(savedPath,'PK_SYNTHETIC_NOT_A_REAL_PROJECT');
    if(op==='project_export_psd') {
      // Structural fixture for the editor export receipt; never packaged as an editable model.
      const header=Buffer.alloc(26);header.write('8BPS');header.writeUInt16BE(1,4);
      header.writeUInt32BE(240,14);header.writeUInt32BE(200,18);await fs.writeFile(req.path,header);
      state++;return {data:{project_id:project,state:'s'+state,path:req.path,bytes:header.length,layers:f.layers.length}};
    }
    if(op==='project_export_model') {
      await fs.writeFile(path.join(req.output_directory,'fixture.model3.json'),JSON.stringify({Version:3,FileReferences:{Moc:'fixture.moc3',Textures:['fixture.png']}}));
      await fs.writeFile(path.join(req.output_directory,'fixture.moc3'),'MOC3_SYNTHETIC_NOT_A_REAL_MODEL');await fs.writeFile(path.join(req.output_directory,'fixture.png'),fixturePng(8,8));
    }
    if(op==='project_export_target') {
      const b=Buffer.from('47494638396101000100800000000000ffffff21f90401640000002c00000000010001000002024401003b','hex');
      await fs.writeFile(path.join(req.output_directory,'fixture.gif'),Buffer.concat([b.subarray(0,19),b.subarray(19,-1),b.subarray(19)]));
    }
    state++;return {data:{project_id:project,state:'s'+state,applied:true}};
  }};
  return engine;
}

test('缺编辑租约/粗素材均有明确阻点，不调用任何运行引擎',async t=> {
  const f=await artworkFixture(t);const r=await buildRig(f.bundle,f.ctx);
  assert.equal(r.status,'blocked');assert(r.unresolved.some(x=>x.code==='ENGINE_LEASE_REQUIRED'));
  const coarse=await artworkFixture(t,{coarse:true});let calls=0;
  const c=await buildRig(coarse.bundle,{...coarse.ctx,engine:{call(){calls++;throw new Error('must not call');}}});
  assert.equal(c.status,'blocked');assert(c.unresolved.some(x=>x.code==='EYE_MATERIAL_MISSING'));assert.equal(calls,0);
});

test('Bundle 身份、hash、越界路径或 symlink 不匹配均在编辑前拒绝',async t=> {
  const f=await artworkFixture(t);let calls=0;const ctx={...f.ctx,engine:{call(){calls++;}}};
  const wrong=await buildRig(f.bundle,{...ctx,candidateId:'someone-else'});assert(wrong.unresolved.some(x=>x.code==='BUNDLE_CONTEXT_MISMATCH'));assert.equal(calls,0);
  await fs.writeFile(path.join(f.root,'artwork','part-0.png'),'not actual original PNG');
  const corrupted=await buildRig(f.bundle,ctx);assert(corrupted.unresolved.some(x=>x.code==='ARTIFACT_HASH_MISMATCH'));assert.equal(calls,0);
  await assert.rejects(safePath(f.root,'artwork/../outside'),e=>e.code==='ARTIFACT_PATH_INVALID');
  await fs.symlink(os.tmpdir(),path.join(f.root,'artwork','outside'));await assert.rejects(safePath(f.root,'artwork/outside'),e=>e.code==='ARTIFACT_OUTSIDE_TASK');
});

test('模拟真实调用形状走完导入/修形/导出/重开，仍不能冒充视觉与单图主案例通过',async t=> {
  const f=await artworkFixture(t),engine=simulatedEngine(f,{reorderOnOpen:true});
  const engineRuntimePatch={runtimeSha256:'a'.repeat(64),parentRuntime:{sha256:'b'.repeat(64)},patches:[{id:'synthetic-runtime-provenance-fixture'}]};
  const r=await buildRig(f.bundle,{...f.ctx,engine,engineRuntimePatch});
  assert.equal(r.status,'blocked',JSON.stringify(r.unresolved));assert(r.unresolved.some(x=>x.code==='RIG_VISUAL_REVIEW_REQUIRED'),JSON.stringify(r.unresolved));
  assert.equal(r.projectPath,'rigging/candidate.psd2live');assert.equal(r.psdPath,'rigging/candidate.psd');assert(r.modelPath.endsWith('.model3.json'));
  assert.equal(engine.calls.filter(c=>c.op==='rig_generate').length,1);
  // HD source pixels are denser than document units; default 2px atlas gutters
  // let traced mesh UVs sample a neighboring tile even at the default pose.
  const configure=engine.calls.find(c=>c.op==='settings_update');
  assert.equal(configure.req.changes.texturePadding,32);
  assert(engine.calls.indexOf(configure)<engine.calls.findIndex(c=>c.op==='rig_generate'));
  assert(engine.calls.some(c=>c.op==='project_open'));assert(engine.calls.some(c=>c.op==='project_export_target'&&c.req.target==='gif'));
  const headRange=JSON.parse(await fs.readFile(path.join(f.root,'rigging/head-range.json'),'utf8'));
  assert(headRange.copiedCells>0);
  assert(engine.calls.some(c=>c.op==='keyform_apply'&&c.req.changes.some(change=>change.op==='copy'&&
    change.target==='warp:DeformHeadContainer'&&change.key.ParamAngleX===45&&change.from.ParamAngleX===12)));
  assert.equal(r.checks.find(c=>c.name==='rigging_visual_review').status,'not_run');
  assert.equal(r.checks.find(c=>c.name==='rigging_save_reopen').status,'passed');
  const map=JSON.parse(await fs.readFile(path.join(f.root,r.parameterMapPath),'utf8'));
  assert.deepEqual(r.engineRuntimePatch,engineRuntimePatch);assert.deepEqual(map.engineRuntimePatch,engineRuntimePatch);
  const recipe=JSON.parse(await fs.readFile(path.join(f.root,'rigging/recipe.json'),'utf8'));assert.deepEqual(recipe.engineRuntimePatch,engineRuntimePatch);
  assert.equal(map.requested.headMotion.yawDegrees,12);assert(map.parameters.some(p=>p.id==='ParamHairStrand01'&&p.available));
  assert(!map.parameters.some(p=>p.id.startsWith('ParamAccessory')));assert(map.parameters.every(p=>p.owner==='rigging'));
  const subdivisions=engine.calls.filter(c=>c.op==='canvas_topology').length;
  assert.equal(subdivisions,f.layers.filter(l=>l.tags.includes('mouth')&&l.tags.includes('open')).length);
  const before=await fs.readFile(path.join(f.root,'rigging','poses','before-headXY.png'));
  const second=await buildRig(f.bundle,{...f.ctx,engine});assert(second.unresolved.some(x=>x.code==='RIG_VISUAL_REVIEW_REQUIRED'),JSON.stringify(second.unresolved));
  assert.equal(engine.calls.filter(c=>c.op==='canvas_topology').length,subdivisions,'resume must preserve the refined mesh');
  assert.equal(engine.calls.filter(c=>c.op==='rig_generate').length,1);assert.deepEqual(await fs.readFile(path.join(f.root,'rigging','poses','before-headXY.png')),before);
});

test('相同渲染的参数全部 unavailable，导出有文件也不能完成',async t=> {
  const f=await artworkFixture(t),engine=simulatedEngine(f,{moving:false});const r=await buildRig(f.bundle,{...f.ctx,engine});
  assert.equal(r.status,'blocked');assert(r.unresolved.some(x=>x.code==='RIG_PARAMETER_NOT_MOVING'),JSON.stringify(r.unresolved));
  const map=JSON.parse(await fs.readFile(path.join(f.root,r.parameterMapPath),'utf8'));assert(map.parameters.every(p=>!p.available));
});

test('口型形状在明确开口上下文实渲，透明闭口层不能冒充参数不可动',async t=> {
  const f=await artworkFixture(t),engine=simulatedEngine(f,{mouthFormNeedsOpen:true});
  const r=await buildRig(f.bundle,{...f.ctx,engine});
  const map=JSON.parse(await fs.readFile(path.join(f.root,r.parameterMapPath),'utf8'));
  const form=map.parameters.find(p=>p.id==='ParamMouthForm');
  assert.equal(form.available,true,JSON.stringify(r.unresolved));
  assert(form.motionEvidence.every(e=>e.context.ParamMouthOpenY===.5&&e.changedPixels>0));
  const renders=engine.calls.filter(c=>c.op==='view_render_model'&&Object.hasOwn(c.req.parameters??{},'ParamMouthForm'));
  assert(renders.length>=3&&renders.every(c=>c.req.parameters.ParamMouthOpenY===.5));
});

test('重开后点数相同但 rest 网格坐标改变仍然拒绝交接',async t=> {
  const f=await artworkFixture(t),engine=simulatedEngine(f,{topologyChangedOnOpen:true});
  const r=await buildRig(f.bundle,{...f.ctx,engine});
  assert(r.unresolved.some(x=>x.code==='REOPEN_TOPOLOGY_CHANGED'),JSON.stringify(r.unresolved));
  assert(!r.projectPath);assert.equal(r.status,'blocked');
});

test('图片变化但实际渲染参数回读不符，不能记成可动输出',async t=> {
  const f=await artworkFixture(t),engine=simulatedEngine(f,{wrongRenderedParameter:true});
  const r=await buildRig(f.bundle,{...f.ctx,engine});
  assert(r.unresolved.some(x=>x.code==='PARAMETER_RENDER_VALUE_MISMATCH'),JSON.stringify(r.unresolved));assert(!r.parameterMapPath);
});

test('同版动作与外观经原生 switch 分类、通道读取、独立图层端点和复位曲线交给04',async t=>{
  const f=await artworkFixture(t,{controls:true}),engine=simulatedEngine(f);
  const result=await buildRig(f.bundle,{...f.ctx,engine});
  assert.deepEqual(result.unresolved.map(x=>x.code),['RIG_VISUAL_REVIEW_REQUIRED'],JSON.stringify(result.unresolved));
  const map=JSON.parse(await fs.readFile(path.join(f.root,result.parameterMapPath),'utf8'));
  const variants=engine.calls.filter(c=>c.op==='layer_set_variant').map(c=>c.req);
  assert.deepEqual(variants.filter(v=>v.variant==='switch').map(v=>[v.parameter,v.switch_id]),[['ParamWave',0],['ParamWave',1],['ParamChestBowHidden',0]]);
  assert.equal(engine.calls.filter(c=>c.op==='object_edit_appearance').length,1);
  for(const id of ['ParamWave','ParamChestBowHidden']) {
    const p=map.parameters.find(p=>p.id===id);assert.equal(p.available,true);
    assert(p.switchEvidence.every(e=>e.passed&&e.off.pixels===0&&e.on.pixels>0));
    assert(p.bindings.every(b=>b.opacityAxes[id].length===2));
  }
  assert(map.parameters.find(p=>p.id==='ParamWaveWrist').motionEvidence.every(e=>e.context.ParamWave===1));
  const lift=engine.calls.find(c=>c.op==='author_axis'&&c.req.parameter.id==='ParamWaveLift').req.shapes;
  const raised=f.layers.find(l=>l.tags.includes('raised')).id;
  assert(lift.length&&lift.every(s=>s.target==='mesh:'+raised));
  assert(map.parameters.find(p=>p.id==='ParamWaveLift').motionEvidence.every(e=>e.context.ParamWave===1));
  assert.deepEqual(map.dynamics.appearances,[{id:'chest_bow',name:'摘戴胸前蝴蝶结',parameter:'ParamChestBowHidden',on:1,off:0}]);
  assert.equal(map.dynamics.motions[0].id,'wave');
  assert(map.dynamics.motions[0].curves.every(c=>c.keys[0].value===0&&c.keys.at(-1).value===0));
  assert(map.poseSets.after.wave&&map.poseSets.after.bow);
  assert(rigCriteriaFor(f.bundle.brief).includes('gesture_sleeve_return')&&rigCriteriaFor(f.bundle.brief).includes('bow_underlay_restore'));
});

test('抬手后腰部补布仅显隐，腰部图层独立呈像且不加入肩、手腕或饰品的形变',async t=>{
  const f=await artworkFixture(t,{controls:true,waist:true}),engine=simulatedEngine(f);
  const result=await buildRig(f.bundle,{...f.ctx,engine});
  assert.deepEqual(result.unresolved.map(x=>x.code),['RIG_VISUAL_REVIEW_REQUIRED'],JSON.stringify(result.unresolved));
  const waist=f.layers.at(-1).id;
  const map=JSON.parse(await fs.readFile(path.join(f.root,result.parameterMapPath),'utf8'));
  const endpoint=map.parameters.find(p=>p.id==='ParamWave').switchEvidence.find(v=>v.layerId===waist);
  assert(endpoint.passed&&endpoint.on.value===1&&endpoint.off.value===0&&endpoint.on.pixels>0&&endpoint.off.pixels===0);
  assert(engine.calls.filter(c=>c.op==='author_axis').every(c=>c.req.shapes.every(s=>s.target!=='mesh:'+waist)));
});

test('显示摘要有变化，但被关闭的图层仍有像素时不可交给04',async t=>{
  const f=await artworkFixture(t,{controls:true});
  const result=await buildRig(f.bundle,{...f.ctx,engine:simulatedEngine(f,{ghostSwitch:true})});
  assert(result.unresolved.some(x=>x.code==='RIG_PARAMETER_NOT_MOVING'));
  const map=JSON.parse(await fs.readFile(path.join(f.root,result.parameterMapPath),'utf8'));
  assert.equal(map.parameters.find(p=>p.id==='ParamChestBowHidden').available,false);
});

test('上睑褶线按实际语义归 eyelash 并共用 aperture；半闭是几何压缩，闭眼清空',async t=>{
  const f=await artworkFixture(t,{faceDetails:true}),engine=simulatedEngine(f);
  const result=await buildRig(f.bundle,{...f.ctx,engine});
  assert.deepEqual(result.unresolved.map(e=>e.code),['RIG_VISUAL_REVIEW_REQUIRED'],JSON.stringify(result.unresolved));
  const details=f.layers.slice(-3),classifications=engine.calls.filter(c=>c.op==='layer_classify');
  assert.deepEqual(new Set(classifications.map(c=>c.req.layer_id)),new Set(details.map(p=>p.id)));
  for(const p of details){const c=classifications.find(c=>c.req.layer_id===p.id);assert.equal(c.req.role,p.tags.includes('rim')?'eyelash':'face_detail');assert(engine.calls.indexOf(c)<engine.calls.findIndex(c=>c.op==='rig_generate'));}
  const map=JSON.parse(await fs.readFile(path.join(f.root,result.parameterMapPath),'utf8'));
  for(const [i,axis] of ['ParamEyeLOpen','ParamEyeROpen'].entries()) {
    const proof=map.parameters.find(p=>p.id===axis).rimEvidence[0];
    assert.equal(proof.layerId,details[i].id);assert(proof.passed);assert.deepEqual(proof.keys,[0,.2,1]);
    assert.equal(proof.heightRatio,.5);assert(proof.shared);assert.equal(proof.half.peak,proof.full.peak);
  }
  const fixed=new Set(details.map(p=>'mesh:'+p.id));
  const steps=engine.calls.filter(c=>c.op==='author_axis');
  for(const c of steps.filter(c=>c.req.shapes.some(s=>fixed.has(s.target))))assert(['ParamAngleX','ParamAngleY'].includes(c.req.parameter.id));
  assert(steps.some(c=>c.req.shapes.some(s=>s.target==='warp:DeformHeadContainer'&&s.key?.ParamAngleY===8)));
  assert(steps.every(c=>c.req.shapes.every(s=>!fixed.has(s.target))));
});

test('上睑褶线不得用固定图层淡化冒充开合，必须压缩而保持峰值透明度',()=>{
  const band=(top,bottom,alpha)=>decodePng(fixturePng(16,16,(_,y)=>[150,90,80,y>=top&&y<=bottom?alpha:0]));
  const open=band(2,9,255),closed=band(0,0,0);
  assert(eyeRimAperture(open,band(5,8,255),closed).passed);
  assert(!eyeRimAperture(open,band(2,9,77),closed).passed);
  assert(!eyeRimAperture(open,band(5,8,77),closed).passed);
  assert(!eyeRimAperture(open,band(5,8,255),band(0,0,5)).passed);
});

test('同样30%总透明度的眼周色块如果向下滑动，或闭眼后仍有残影，按像素拦截',()=>{
  const row=(y,alpha)=>decodePng(fixturePng(8,8,(_,j)=>[140,62,72,j===y?alpha:0]));
  const open=row(2,255),closed=row(2,0);
  assert(eyeRimFade(open,row(2,77),closed).passed);
  assert(!eyeRimFade(open,row(4,77),closed).passed);
  assert(!eyeRimFade(open,row(2,77),row(2,5)).passed);
  assert(!eyeRimFade(open,row(2,128),closed).passed);
});

test('备用衣料在摘下时显示，闭眼闭嘴部件释放生成器自带的独立开关',async t=>{
  const f=await artworkFixture(t,{controls:true,hiddenAlternates:true}),engine=simulatedEngine(f);
  const result=await buildRig(f.bundle,{...f.ctx,engine});
  assert.deepEqual(result.unresolved.map(x=>x.code),['RIG_VISUAL_REVIEW_REQUIRED'],JSON.stringify(result.unresolved));
  const variants=engine.calls.filter(c=>c.op==='layer_set_variant').map(c=>c.req);
  const cloth=f.layers.find(l=>l.tags.includes('underlay')),closed=f.layers.filter(l=>l.tags.includes('closed'));
  assert(variants.some(v=>v.layer_id===cloth.id&&v.parameter==='ParamChestBowHidden'&&v.switch_id===1));
  const opened=f.layers.filter(l=>l.tags.includes('mouth')&&l.tags.includes('open'));
  assert.equal(opened.length,3);
  assert(opened.every(l=>variants.some(v=>v.layer_id===l.id&&v.parameter==='ParamMouthOpenY'&&v.variant==='toggle')));
  const map=JSON.parse(await fs.readFile(path.join(f.root,result.parameterMapPath),'utf8'));
  const mouth=map.parameters.find(p=>p.id==='ParamMouthOpenY');
  assert.equal(mouth.switchEvidence.length,4);
  assert(mouth.switchEvidence.every(e=>e.passed&&e.off.pixels===0&&e.on.pixels>0));
  assert(closed.every(l=>variants.some(v=>v.layer_id===l.id&&v.variant==='none')));
  const visible=engine.calls.filter(c=>c.op==='object_edit_appearance').flatMap(c=>c.req.edits);
  assert([...closed,cloth].every(l=>visible.some(e=>e.id===l.id&&e.visible)));
});

test('头部叠层只继承同一个含脸部中线支持点的转头场',()=>{
  const layer=(id,tags,rect)=>({id,tags,geometry:alphaGeometry(decodePng(fixturePng(8,8)),rect)});
  const face=layer('face',['face'],{left:20,top:30,width:60,height:80});
  const hair=layer('hair',['hair','root'],{left:0,top:0,width:100,height:120});
  const shapes=sharedHeadShapes([face,hair],brief);
  assert(shapes.every(s=>s.shape.target==='warp:DeformHeadContainer'));
  const yaw=shapes.find(s=>s.parameter==='ParamAngleX'&&s.shape.value===12&&!s.shape.key).shape.operations[0];
  assert(yaw.from.some(([x],i)=>Math.abs(x-.5)<1e-9&&yaw.to[i][0]-x>.03),'central face depth must be sampled, not lost in a head-wide grid');
});

test('手臂两套素材不能在原画肩部对位时，退回素材阶段',()=>{
  const request=structuredClone(brief);request.intent.actions.push({id:'wave',label:'打招呼'});
  const part=(pose,rect)=>({id:pose,tags:['gesture','wave',pose],geometry:alphaGeometry(decodePng(fixturePng(8,8)),rect)});
  const rect={left:25,top:20,width:20,height:72},rest=part('rest',rect);
  for(const raised of [part('raised',rect),part('raised',{...rect,left:100})]) {
    assert(materialGaps([rest,raised],request).some(g=>g.code==='WAVE_SHOULDER_POSES_INVALID'));
  }
});
