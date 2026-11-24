// Stable layer roles are authored by stage 02 in the hashed Layout. The brief supplies resource IDs.
import {continuousWaveAnchors,greetingAxes,palmWaveSamples,waveAnchors} from './wave.mjs';
import {gestureAxes,gestureClips} from './streamer-presets.mjs';
export const roles={continuous:'gesture:wave:continuous',rest:'gesture:wave:rest',raised:'gesture:wave:raised',waist:'body:underlay:waist',bow:'appearance:chest_bow',cloth:'appearance:chest_bow:underlay'};
export function hasRole(part,role) {
  const match=part.tags.includes(role)||role.split(':').every(t=>part.tags.includes(t));
  return match&&(role!==roles.bow||!hasRole(part,roles.cloth));
}
export function requestedControls(brief) {
  const intent=brief.intent;
  const wave=intent.actions?.find(a=>a.id==='wave');
  const bow=intent.clothingVariants?.find(a=>a.id==='chest_bow');
  return {wave,bow};
}
const steps=values=>values.map(([time,value,interpolation='BEZIER'])=>({time,value,interpolation}));
export function waveClip(wave,continuous=false,fingertips=[],fullCycle=false,wristOnly=false,splitSleeve=false) {
  if(continuous)return {id:wave.id,name:wave.label,duration:6,fps:30,loop:false,curves:[
    {parameter:'ParamWave',keys:steps(splitSleeve?
      [[0,0],[.38,0],[1.72,.53],[2.47,.61],[2.89,.69],
       [3.25,.76],[3.76,.83],[4.25,.90],[4.85,1,"STEPPED"],[5,0,"STEPPED"],[6,0]]:wristOnly?
      [[0,0],[.42,0],[.95,.20],[1.52,.45],[1.91,.53],[2.46,.61],[2.97,.69],
       [3.36,.75],[3.81,.83],[4.26,.90],[4.73,1,"STEPPED"],[5,0,"STEPPED"],[6,0]]:fullCycle?
      [[0,0],[.42,0],[.97,.20],[1.55,.45],[1.91,.52],[2.95,.56],[3.24,.58],
       [3.68,.72],[4.26,.88],[4.76,1,"STEPPED"],[5,0,"STEPPED"],[6,0]]:fingertips.length?
      [[0,0],[.48,0],[.82,.15],[1.19,.34],[1.60,.47],[2.01,.57],[2.53,.63],[2.87,.60],
       [3.12,.59],[3.49,.49],[3.89,.27],[4.33,.06],[4.74,0],[6,0]]:
      [[0,0],[.7,0],[1.75,.45],[2.07,.53],[2.38,.61],[2.69,.69],[3,.61],[3.25,.45],[4.62,0],[6,0]])},
    ...(fingertips.length?[
      {parameter:greetingAxes(fingertips,{wristOnly})[0].id,keys:steps(splitSleeve?[
        [0,0],[1.13,0],[1.54,.14],[2.05,.88],[2.62,.16],[3.05,.66],[3.58,.36],[4.38,.10],[4.85,0],[6,0],
      ]:wristOnly?[
        [0,0],[1.18,0],[1.65,.28],[2.10,.81],[2.63,.16],[3.13,.68],[3.65,.22],[4.24,0],[6,0],
      ]:fullCycle?[
        [0,0],[.88,0],[1.49,.22],[1.86,.75],[2.24,.12],[2.63,.88],
        [3.01,.22],[3.39,.67],[3.85,.27],[4.38,0],[6,0],
      ]:[
        [0,0],[.90,0],[1.30,.20],[1.70,.39],[1.97,1],[2.17,.96],[2.54,.06],
        [2.87,.92],[3.12,.70],[3.51,.18],[3.88,.27],[4.43,0],[6,0],
      ])},
      ...greetingAxes(fingertips,{wristOnly}).slice(1).map((axis,i)=>({parameter:axis.id,keys:steps(fullCycle?[
        [0,0],[1.12+i*.04,0],[1.58+i*.03,.25+i*.035],[2.16+i*.05,.08],
        [2.72+i*.04,.23+i*.025],[3.37+i*.05,.10],[3.97+i*.045,.24],[4.61+i*.03,0],[6,0],
      ]:[
        [0,0],[.84+i*.04,0],[1.31+i*.08,.96-i*.08],[1.72+i*.06,.05],
        [2.08+i*.085,Math.min(1,.47+i*.15)],[2.53+i*.065,.06],[2.91+i*.075,.82-i*.08],
        [3.28+i*.03,.14],[3.66+i*.10,.97-i*.09],[4.56+i*.04,0],[6,0],
      ])})),
    ]:[])
  ]};
  return {id:wave.id,name:wave.label,duration:2.4,fps:30,loop:false,curves:[
    {parameter:'ParamWave',keys:steps([[0,0],[.30,0],[.36,1],[2.04,1],[2.10,0],[2.4,0]])},
    {parameter:'ParamWaveLift',keys:steps([[0,0],[.30,1],[.36,1],[.62,0],[1.78,0],[2.04,1],[2.10,1],[2.4,0]])},
    {parameter:'ParamWaveWrist',keys:steps([[0,0],[.50,0],[.75,1],[1.05,-1],[1.48,1],[1.78,-.5],[1.94,0],[2.4,0]])}
  ]};
}
export function controlRecipe(parts,brief,{waveOwnership}={}) {
  const {wave,bow}=requestedControls(brief);
  const variants=[],gaps=[],specs=[],motions=[],appearances=[];
  if(brief.streamerPresets) {
    specs.push(...gestureAxes);
    motions.push(...gestureClips);
  }
  const layers=role=>parts.filter(p=>!p.reference&&hasRole(p,role));
  const requireRole=role=>{
    const found=layers(role);
    if(!found.length)gaps.push({stage:'rigging',code:'CONTROL_MATERIAL_MISSING',message:'需要02交付独立的 '+role+' 像素。'});
    return found;
  };
  const axis=(id,semantic,owner,min=0,max=1)=>({id,semantic,min,max,default:0,unit:'normalized',owner:'rigging',runtimeOwner:owner});
  const variant=(parts,parameter,value)=>variants.push(...parts.map(p=>({layer_id:p.id,variant:'switch',parameter,switch_id:value})));
  const continuous=wave&&layers(roles.continuous);
  if(continuous?.length) {
    try {
      if(continuous.length!==1||continuous[0].visible===false||
        continuous[0].variant&&continuous[0].variant.type!=='none'||
        layers(roles.rest).length||layers(roles.raised).length||waveOwnership)throw new Error();
      continuousWaveAnchors(continuous[0],parts);
    }catch {gaps.push({stage:'rigging',code:'CONTINUOUS_WAVE_ANCHORS_INVALID',message:'连续挥手须有唯一可见袖臂层及原画肩、肘、腕坐标，不能混用双姿态图层。'});}
    const palm=parts.find(p=>p.tags.includes('palm-variant'));
    const sourceSide=parts.find(p=>p.tags.includes('source-side-wave'));
    specs.push({...axis('ParamWave','action.wave','motion'),sampleValues:palm?palmWaveSamples:[.45,.53,.69]});
    if(palm||sourceSide)continuousWaveAnchors(palm??sourceSide,parts);
    const fingertips=(palm??sourceSide??continuous[0]).rigging?.continuousWave?.fingertips??[];
    specs.push(...greetingAxes(fingertips,{wristOnly:!!sourceSide}).map(p=>axis(p.id,p.semantic,'motion',p.min,p.max)));
    const clip=waveClip(wave,true,fingertips,!!(palm??sourceSide),!!sourceSide,
      continuous[0].rigging?.continuousWave?.approach==='outward_split');
    if(continuous[0].rigging?.continuousWave?.balanceLead) {
      specs.push(axis('ParamGreetingBalance','action.wave.balance','motion',-1,1));
      clip.curves.push({parameter:'ParamGreetingBalance',keys:steps([
        [0,0],[.16,-.18],[.46,-.48],[.92,.12],[1.54,.52],[2.55,.36],
        [3.35,.15],[4.02,-.31],[4.56,-.21],[5.28,0],[6,0],
      ])});
    }
    motions.push(clip);
  } else if(wave) {
    const rest=requireRole(roles.rest),raised=requireRole(roles.raised);requireRole(roles.waist);
    if(rest.length&&raised.length) {
      const joint=shoulderJoint(parts);
      if(!joint)gaps.push({stage:'rigging',code:'WAVE_SHOULDER_POSES_INVALID',message:'静止手和抬手需在原画肩袖相连，抬手层须附真实 shoulderPins/elbow/hand/jointRadius/loweredDegrees 画布坐标。'});
    }
    // Seed the existing source visibility tracks before generation. The measured
    // return refinement later sets constant ownership on those real tracks.
    variant(rest,'ParamWave',0);variant([...raised,...layers(roles.waist).filter(p=>p.visible===false||p.variant&&p.variant.type!=='none')],'ParamWave',1);
    specs.push(axis('ParamWave','action.wave','motion'),axis('ParamWaveLift','action.wave.lift','motion'),axis('ParamWaveWrist','action.wave.wrist','motion',-1,1));
    motions.push(waveClip(wave));
  }
  if(bow) {
    const bows=requireRole(roles.bow),cloth=requireRole(roles.cloth);variant(bows,'ParamChestBowHidden',0);
    // A dedicated reveal patch can be hidden in the source PSD. Permanently visible cloth
    // stays beneath the bow, while alternate-only cloth follows the complementary key.
    variant(cloth.filter(p=>p.visible===false||p.variant&&p.variant.type!=='none'),'ParamChestBowHidden',1);
    for(const b of bows)if(!cloth.some(c=>parts.indexOf(c)<parts.indexOf(b)&&overlaps(c.geometry?.canvasBounds,b.geometry?.canvasBounds)))
      gaps.push({stage:'rigging',code:'BOW_UNDERLAY_MISSING',message:b.id+' 下方须有在原画坐标相交的补绘衣料。'});
    specs.push(axis('ParamChestBowHidden','appearance.chest_bow.hidden','expression'));
    appearances.push({id:bow.id,name:bow.label,parameter:'ParamChestBowHidden',on:1,off:0});
  }
  const controlLayers=parts.filter(p=>Object.values(roles).some(t=>hasRole(p,t)));
  for(const p of controlLayers)if(Object.values(roles).filter(t=>hasRole(p,t)).length!==1||
    (p.opacity??1)<=0)
    gaps.push({stage:'rigging',code:'CONTROL_LAYER_INVALID',message:p.id+' 的控制角色或底层可见性冲突。'});
  const finalVariants=waveOwnership==='single_raised_return'?variants.filter(v=>v.parameter!=='ParamWave'):variants;
  return {specs,variants,finalVariants,gaps,motions,appearances};
}
function overlaps(a,b) {
  return a&&b&&Math.min(a[2],b[2])>Math.max(a[0],b[0])&&Math.min(a[3],b[3])>Math.max(a[1],b[1]);
}

// Anatomical handles are authored by 02, not inferred from alpha centroids.
export function shoulderJoint(parts) {
  const rest=parts.filter(p=>hasRole(p,roles.rest)),raised=parts.filter(p=>hasRole(p,roles.raised));
  if(!rest.length||!raised.length)return null;
  for(const p of raised) {
    if(!rest.some(r=>overlaps(r.geometry?.canvasBounds,p.geometry?.canvasBounds)))return null;
    try {waveAnchors(p);}catch{return null;}
  }
  return waveAnchors(raised[0]);
}
