// PSD2Live v3.6.7 bfadd834; ranges from core/RigBuilder.kt, units from rig_deform schema.
import {roles,hasRole,requestedControls,controlRecipe,waveClip} from './controls.mjs';
export const ENGINE_VERSION='3.6.7';
export const ENGINE_COMMIT='bfadd8343774d5b6208146060c4fa175d84a0f4f';
export const RIG_REPAIR_PROFILE='semantic-surface-v57';
const parameter=(id,semantic,min,max,neutral=0,unit='normalized')=>({id,semantic,min,max,default:neutral,unit,owner:'rigging'});
export const BASE_PARAMETERS=[
  parameter('ParamAngleX','head.yaw',-45,45,0,'degree'),parameter('ParamAngleY','head.pitch',-30,30,0,'degree'),parameter('ParamAngleZ','head.roll',-30,30,0,'degree'),
  ...['X','Y','Z'].map(a=>parameter(`ParamBodyAngle${a}`,`body.angle${a}`,-10,10,0,'degree')),
  parameter('ParamEyeLOpen','eye.left.open',0,1,1),parameter('ParamEyeROpen','eye.right.open',0,1,1),
  parameter('ParamEyeSmile','eyes.smile',0,1),
  parameter('ParamEyeBallX','eyes.gazeX',-1,1),parameter('ParamEyeBallY','eyes.gazeY',-1,1),parameter('ParamEyeBallForm','eyes.form',-1,1),
  parameter('ParamBrowLY','brow.left',-1,1),parameter('ParamBrowRY','brow.right',-1,1),
  parameter('ParamMouthForm','mouth.form',-1,1),parameter('ParamMouthOpenY','mouth.open',0,1),
  parameter('ParamBreath','body.breath',0,1),parameter('ParamHairFront','hair.front',-1,1),parameter('ParamHairBack','hair.back',-1,1),
];
export const has=(part,...tags)=>tags.every(t=>part.tags.includes(t));
export const eyeRimAxis=p=>has(p,'eye','rim')?(has(p,'left')?'ParamEyeLOpen':has(p,'right')?'ParamEyeROpen':null):null;
export const fixedHeadDetail=p=>has(p,'hair','root');
export const eye=part=>has(part,'eye')||has(part,'brow');
export const mouth=part=>has(part,'mouth')||has(part,'teeth')||has(part,'tongue');
export const accessory=part=>has(part,'accessory')||has(part,'headwear')||has(part,'eyewear');

export function materialGaps(parts,brief) {
  const gaps=[],need=(ok,code,message)=>{if(!ok)gaps.push({code,message,stage:'rigging'});};
  need(parts.some(p=>has(p,'face')&&!has(p,'detail')),'FACE_MATERIAL_MISSING','需要独立脸部轮廓素材。');
  if(brief.intent.eyes.blink||brief.intent.eyes.gaze)for(const side of ['left','right']) {
    for(const tag of ['white','iris','lash'])need(parts.some(p=>has(p,'eye',tag,side)),'EYE_MATERIAL_MISSING',`${side} 眼缺少独立 ${tag} 图层；请02回补。`);
    if(brief.intent.eyes.blink)need(parts.some(p=>has(p,'eye','closed',side)),'EYE_CLOSED_MATERIAL_MISSING',`${side} 眼缺少真实闭眼线，不能将虹膜缩成黑块。`);
  }
  if(brief.intent.mouth.speech) {
    need(parts.some(p=>has(p,'mouth','open')),'MOUTH_INTERIOR_MISSING','缺少独立口腔开口素材。');
    need(parts.some(p=>has(p,'mouth','closed')),'MOUTH_CLOSED_MISSING','缺少独立闭嘴线/嘴唇素材。');
  }
  if(brief.intent.expressions.length)for(const side of ['left','right'])need(parts.some(p=>has(p,'brow',side)),'BROW_MATERIAL_MISSING',`${side} 眉毛需独立分层。`);
  return [...gaps,...controlRecipe(parts,brief).gaps];
}

export function validateMotion(brief) {
  const m=brief?.intent?.headMotion;
  if(!m||!['yawDegrees','pitchDegrees','rollDegrees'].every(k=>Number.isFinite(m[k])&&m[k]>=0))throw new Error('BRIEF_HEAD_RANGE_REQUIRED');
  if(m.yawDegrees>45||m.pitchDegrees>30||m.rollDegrees>30)throw new Error('REQUESTED_HEAD_RANGE_UNSUPPORTED');
  if(!brief.intent.eyes||!brief.intent.mouth||!Array.isArray(brief.intent.expressions)||!Array.isArray(brief.intent.actions))throw new Error('BRIEF_INTENT_REQUIRED');
  return {yaw:m.yawDegrees,pitch:m.pitchDegrees,roll:m.rollDegrees};
}

// Small, relative refinements to the generated baseline. These are candidate shapes,
// never automatic claims of anatomy, reference quality or visually correct interpolation.
export function planRefinements(parts,objects,brief,{gate}={}) {
  const ranges=validateMotion(brief),byLayer=new Map();
  for(const o of objects)if(o.target.startsWith('mesh:')&&o.layerId) {
    const list=byLayer.get(o.layerId)??[];list.push(o.target);byLayer.set(o.layerId,list);
  }
  const groups=new Map(),rimOpacity=[],apertureResets=[],apertureDeformations=[],specs=new Map(BASE_PARAMETERS.map(p=>[p.id,p]));
  const add=(id,s)=>{const list=groups.get(id)??[];list.push(s);groups.set(id,list);};
  const controls=controlRecipe(parts,brief);
  for(const spec of controls.specs)specs.set(spec.id,spec);
  if(brief.intent.expressions.some(e=>e.id==='angry'))specs.set('ParamEyeAngry',parameter('ParamEyeAngry','expression.eye.angry',0,1));
  if(brief.intent.expressions.some(e=>e.id==='surprise'))specs.set('ParamEyeSurprise',parameter('ParamEyeSurprise','expression.eye.surprise',0,1));
  // Reveal patches and gesture poses retain their own visibility/motion ownership.
  const movingParts=parts.filter(p=>!p.reference&&!p.tags.some(t=>t.split(':').some(role=>role==='underlay'||role==='gesture')));
  const articulated=parts.some(p=>p.rigging?.continuousWave?.fingertips);
  // Each independent layer gets a separate output for04; the common front/back axes remain usable.
  const hair=movingParts.filter(p=>has(p,'hair')&&!has(p,'root')).sort((a,b)=>a.id.localeCompare(b.id));
  const ornaments=movingParts.filter(p=>accessory(p)||hasRole(p,roles.bow)).sort((a,b)=>a.id.localeCompare(b.id));
  const cloth=movingParts.filter(p=>!hair.includes(p)&&!ornaments.includes(p)&&p.tags.some(t=>t.split(':').some(role=>
    ['lower-body','waist-ribbon'].includes(role)||articulated&&role==='sleeve'))).sort((a,b)=>a.id.localeCompare(b.id));
  for(const [list,prefix,semantic,degrees,rootPin] of [[hair,'ParamHairStrand','hair.strand',3,.18],[ornaments,'ParamAccessory','accessory',2,.25],[cloth,'ParamCloth','cloth',1.5,.35]]) {
    for(const [i,p] of list.entries()) {
      const targets=byLayer.get(p.id)??[];if(!targets.length)continue;
      const id=`${prefix}${String(i+1).padStart(2,'0')}`,partSemantic=hasRole(p,roles.bow)?'accessory.chest_bow':semantic;
      const chain=articulated&&(has(p,'hair','back')||has(p,'sleeve')),tipId=id+'Tip';
      specs.set(id,{...parameter(id,`${partSemantic}.${p.id}`,-1,1),runtimeOwner:'physics',...(chain?{physicsChain:{id,vertex:1}}:{})});
      if(chain)specs.set(tipId,{...parameter(tipId,`${partSemantic}.${p.id}.tip`,-1,1),runtimeOwner:'physics',physicsChain:{id,vertex:2}});
      for(const target of targets)for(const v of [-1,1]) {
        const arc=(angle,pin)=>({type:'arc',degrees:v*angle,root:p.geometry.root,tip:p.geometry.tip,root_pin:pin});
        add(id,{target,value:v,operations:[arc(chain?(semantic==='cloth'?4:6):articulated&&semantic==='hair.strand'?4.7:degrees,rootPin)]});
        if(chain)for(const base of [-1,0,1])add(tipId,{target,value:v,key:{[id]:base},operations:[arc(semantic==='cloth'?7:9,.54)]});
      }
    }
  }
  // Native generation already binds ParamBreath on the common body hierarchy.
  // Scaling each dense clothing mesh again caused real degenerate triangles in
  // r3 and also stacked two breathing fields. Keep the native field and require
  // the ordinary exported parameter pixel check; never infer movement here.
  return {repairProfile:RIG_REPAIR_PROFILE,ranges,controls,rimOpacity,apertureResets,apertureDeformations,deferred:[],
    breathing:{source:'generated_common_body_warp',validation:'actual_parameter_pixels_required'},specs:[...specs.values()],steps:[false,true].flatMap(combined=>[...groups].flatMap(([id,allShapes])=> {
    const shapes=allShapes.filter(s=>Boolean(s.key)===combined);
    const spec=specs.get(id),axis=Object.fromEntries(['id','name','min','max','default','kind','repeat'].filter(k=>Object.hasOwn(spec,k)).map(k=>[k,spec[k]]));
    const chunks=[];for(let i=0;i<shapes.length;i+=64)chunks.push({parameter:axis,shapes:shapes.slice(i,i+64)});return chunks;
  })),unmapped:parts.filter(p=>!(byLayer.get(p.id)?.length)).map(p=>p.id)};
}

export function poseSets(brief,continuous=false,{portrait=false}={}) {
  const {yaw,pitch,roll}=validateMotion(brief);
  const headXY=[-pitch,0,pitch].flatMap(y=>[-yaw,0,yaw].map(x=>({ParamAngleX:x,ParamAngleY:y})));
  const {wave,bow}=requestedControls(brief);
  return {headXY,...(wave?{wave:continuous?[0,.27,.45,.53,.69,1].map(ParamWave=>({ParamWave})):[{ParamWave:0},{ParamWave:0,ParamWaveLift:1},{ParamWave:1,ParamWaveLift:1},{ParamWave:1,ParamWaveWrist:-1},{ParamWave:1,ParamWaveWrist:1},{ParamWave:0}]}:{}),
    ...(bow?{bow:[{ParamChestBowHidden:0},{ParamChestBowHidden:1},{ParamChestBowHidden:0}]}:{}),midpoints:[{ParamAngleX:-yaw/2,ParamAngleY:pitch/2},{ParamAngleX:yaw/2,ParamAngleY:-pitch/2},{ParamAngleZ:-roll},{ParamAngleZ:roll}],
    eyes:[{ParamEyeLOpen:1,ParamEyeROpen:1},{ParamEyeLOpen:.5,ParamEyeROpen:.5},{ParamEyeLOpen:0,ParamEyeROpen:0},{ParamEyeLOpen:0},{ParamEyeROpen:0},{ParamAngleX:-yaw,ParamEyeLOpen:0,ParamEyeROpen:0},{ParamAngleX:yaw,ParamEyeLOpen:0,ParamEyeROpen:0}],
    mouth:[{ParamMouthOpenY:0},{ParamMouthOpenY:.25},{ParamMouthOpenY:.65},{ParamMouthOpenY:1},{ParamMouthOpenY:.65,ParamMouthForm:-1},{ParamMouthOpenY:.65,ParamMouthForm:1},{ParamAngleX:-yaw,ParamMouthOpenY:1},{ParamAngleX:yaw,ParamMouthOpenY:1},{ParamAngleX:yaw,ParamAngleY:pitch,ParamMouthForm:1,ParamEyeSmile:1}],
    ...(portrait?{combined:[-1,1].flatMap(s=>[[1,0],[.5,.55],[0,.85]].map(([aperture,mouth])=>({
      ParamAngleX:s*yaw,ParamAngleY:s*pitch*.5,ParamEyeLOpen:aperture,ParamEyeROpen:aperture,ParamMouthOpenY:mouth,
    })))}:{}),
  };
}

export function previewClip(brief,continuous=false,registeredWave) {
  const {yaw,pitch}=validateMotion(brief);
  const values={ParamAngleX:[0,-yaw,0,yaw,0,-yaw/2,yaw/2,0,0],ParamAngleY:[0,0,pitch,0,-pitch,pitch/2,-pitch/2,0,0],
    ParamEyeLOpen:[1,1,.5,0,1,1,0,1,1],ParamEyeROpen:[1,1,.5,0,1,1,0,1,1],ParamMouthOpenY:[0,0,.25,.65,1,.25,.65,0,0],ParamMouthForm:[0,0,0,-1,1,0,1,0,0]};
  const {wave,bow}=requestedControls(brief);
  if(bow)values.ParamChestBowHidden=[0,0,0,0,0,0,1,1,0];
  const curves=Object.entries(values).map(([parameter,points])=>({parameter,keys:points.map((value,time)=>({time,value}))}));
  if(wave)for(const c of (registeredWave??waveClip(wave,continuous)).curves)curves.push({...c,keys:[{time:0,value:0},...c.keys.map(k=>({...k,time:(continuous?2:3)+k.time})),...(continuous?[]:[{time:8,value:0}])]});
  return {id:'rigging-preview',name:'制作预览（非摄像头实录）',duration:8,fps:24,loop:false,
    curves};
}
