import {Fault} from '../rpc.mjs';
import {emotionPresets,gestureClips,includeStreamerPresets} from '../rigging/streamer-presets.mjs';

export const RECIPE_VERSION='dynamics-1.2';
const finite=Number.isFinite;
const problem=(code,message,parameter)=>({code,message,...(parameter?{parameter}:{})});
const protectedSemantic=s=>/^(head\.|body\.angle|eye\.(left|right)\.open$|eyes?\.gaze|mouth\.open$)/.test(s);
const targets=p=>[...new Set([...(p.targets??[]),...(p.bindings??[]).map(b=>b.target)])];
const permits=(p,owner)=>p.runtimeOwner? p.runtimeOwner===owner : ['rigging',owner,...(owner==='expression'?['expression_additive']:[])].includes(p.owner);

// This is a consumer format, not a new parameter registry. 03 remains the only axis owner.
export function readParameters(map) {
  if(map?.schemaVersion!==1||!Array.isArray(map.parameters))throw new Fault('DYNAMICS_MAP_INVALID','需要03的parameter-map v1与parameters数组');
  const ids=new Set();
  return map.parameters.map(p=>{
    if(!p||typeof p.id!=='string'||!p.id||ids.has(p.id)||typeof p.semantic!=='string'||
      ![p.min,p.max,p.default].every(finite)||p.min>=p.max||p.default<p.min||p.default>p.max)
      throw new Fault('DYNAMICS_MAP_INVALID','参数ID/语义/范围不合法或重复');
    ids.add(p.id);return p;
  });
}

export function hasMovingShape(p) {
  // 03's published evidence: real inspect bindings and same-viewport PNG pixel comparisons.
  const bound=axes=>Array.isArray(axes?.[p?.id])&&axes[p.id].length>=2&&axes[p.id].every(finite);
  return p?.available===true&&Array.isArray(p.bindings)&&p.bindings.some(b=>typeof b.target==='string'&&
    (bound(b.directAxes)||(p.semantic==='action.wave'||p.semantic?.startsWith('appearance.'))&&bound(b.opacityAxes)||(b.inherited??[]).some(parent=>bound(parent.axes))))&&
    Array.isArray(p.motionEvidence)&&p.motionEvidence.length>0&&p.motionEvidence.every(e=>finite(e.value)&&e.value!==p.default&&e.value>=p.min&&e.value<=p.max&&
      typeof e.defaultImage==='string'&&typeof e.posedImage==='string'&&e.defaultImage!==e.posedImage&&
      Number.isInteger(e.changedPixels)&&Number.isInteger(e.totalPixels)&&e.changedPixels>0&&e.changedPixels<=e.totalPixels);
}

export function compileDynamicsRecipe(map,brief={}) {
  const parameters=readParameters(map),byId=new Map(parameters.map(p=>[p.id,p]));
  const unresolved=[],warnings=[];
  const ready=p=>{
    if(hasMovingShape(p))return true;
    unresolved.push(problem('DYNAMICS_SHAPE_MISSING','参数缺少03实际非零形变/关键形证据',p?.id));return false;
  };
  const head=parameters.find(p=>['head.yaw','head.x'].includes(p.semantic)&&hasMovingShape(p));
  const tilt=parameters.find(p=>['head.roll','head.z'].includes(p.semantic)&&hasMovingShape(p));
  const body=parameters.find(p=>p.semantic==='body.angleX'&&hasMovingShape(p));
  const bodyTilt=parameters.find(p=>p.semantic==='body.angleZ'&&hasMovingShape(p));
  if(!head)unresolved.push(problem('DYNAMICS_INPUT_MISSING','缺少真实头部X输入'));
  const physics=[];
  const candidates=parameters.filter(p=>/^(hair\.|accessory\.|cloth\.)/.test(p.semantic));
  // Do not drive both common front/back and independent strand axes on the same mesh.
  const strands=candidates.filter(p=>p.semantic.startsWith('hair.strand.')&&hasMovingShape(p));
  const strandTargets=new Set(strands.flatMap(targets));
  const outputs=candidates.filter(p=>!/^hair\.(front|back)$/.test(p.semantic)||
    (p.available||!strands.length)&&!targets(p).some(t=>strandTargets.has(t)));
  if(!outputs.some(p=>p.semantic.startsWith('hair.')))unresolved.push(problem('DYNAMICS_HAIR_MISSING','缺少发束形变映射'));
  for(const p of outputs) {
    if(p.available===false) {
      unresolved.push(problem('DYNAMICS_SHAPE_MISSING','登记的发束/饰品/衣料尚不可动',p.id));continue;
    }
    if(!permits(p,'physics')||protectedSemantic(p.semantic))throw new Fault('DYNAMICS_OWNERSHIP_CONFLICT','物理输出必须由physics独占');
    const torso=p.semantic.startsWith('cloth.')||p.semantic.startsWith('accessory.chest_bow.');
    const input=torso?(body??head):head,rotation=torso?(bodyTilt??(body?null:tilt)):tilt;
    if(!ready(p)||!input)continue;
    if(p.default!==0||Math.min(p.max,p.default-p.min)<=0) {
      unresolved.push(problem('DYNAMICS_PHYSICS_RANGE_UNSUPPORTED','摆动输出需要中性0和双向范围',p.id));continue;
    }
    const back=/back|tip/.test(p.semantic),accessory=p.semantic.startsWith('accessory.');
    const segments=p.physicsChain?[{length:9,mobility:.72,delay:.17,acceleration:1.15},{length:8,mobility:.84,delay:.39,acceleration:1.07}]:
      p.semantic.startsWith('cloth.')?[{length:7,mobility:.55,delay:.3,acceleration:1.1}]:
      back?[{length:8,mobility:0.72,delay:0.22,acceleration:1.1},{length:7,mobility:0.78,delay:0.3,acceleration:1.2}]:
      [{length:accessory?7:10,mobility:accessory?0.6:0.65,delay:accessory?0.32:0.24,acceleration:accessory?1.6:1.3}];
    if(p.physicsChain?.vertex===2)continue;
    const tip=p.physicsChain&&outputs.find(t=>t.physicsChain?.id===p.id&&t.physicsChain.vertex===2);
    if(p.physicsChain&&(!tip||!hasMovingShape(tip)||!permits(tip,'physics')||
      targets(tip).sort().join()!==targets(p).sort().join()))
      throw new Fault('DYNAMICS_PHYSICS_CHAIN_INVALID','同一分段物理须有实际且同源的根部与末端形变');
    // A segmented sleeve responds to a tracked turn even in runners that leave
    // the body axes at neutral. A body turn still contributes when available.
    const segmentedSleeve=p.semantic.startsWith('cloth.')&&p.physicsChain&&body&&head;
    const inputs=[{parameter:input.id,weight:segmentedSleeve?(rotation?35:50):(rotation?70:100),type:'x',reflect:false},
      ...(rotation?[{parameter:rotation.id,weight:segmentedSleeve?15:30,type:'angle',reflect:false}]:[]),
      ...(segmentedSleeve?[{parameter:head.id,weight:50,type:'x',reflect:false}]:[])];
    physics.push({id:'dyn_'+p.id.replace(/[^A-Za-z0-9_-]/g,'_'),name:p.semantic,enabled:true,inputs,
      outputs:[p,...(tip?[tip]:[])].map(axis=>({parameter:axis.id,vertex:axis.physicsChain?.vertex??segments.length,
        scale:Math.min(axis.max-axis.default,axis.default-axis.min)*(axis.physicsChain?1.15:.75),weight:100,reflect:false})),
      segments,normalization:{position:{min:-10,default:0,max:10},angle:{min:-30,default:0,max:30}}});
  }
  if(new Set(physics.map(p=>p.id)).size!==physics.length)throw new Fault('DYNAMICS_MAP_INVALID','参数ID转换产生物理组ID冲突');
  const driven=new Map();
  for(const g of physics)for(const id of g.outputs.map(o=>o.parameter))for(const target of targets(byId.get(id))) {
    if(driven.has(target)&&driven.get(target)!==g.id)throw new Fault('DYNAMICS_OWNERSHIP_CONFLICT','同一形变对象被两组物理重复驱动：'+target);
    driven.set(target,g.id);
  }
  const intent=brief.intent??brief;
  const requestedExpressions=intent.expressions??[{id:'happy',label:'开心'},{id:'angry',label:'生气'}];
  if(!Array.isArray(requestedExpressions))throw new Fault('DYNAMICS_MAP_INVALID','表情需求必须为数组');
  const declared=map.dynamics?.expressions??[];
  const expressions=[];
  const presetAxes=['ParamBrowLY','ParamBrowRY','ParamEyeSmile','ParamEyeAngry','ParamEyeSurprise','ParamMouthForm'];
  const expandedExpressions=includeStreamerPresets(requestedExpressions,brief.streamerPresets,emotionPresets);
  for(const requested of expandedExpressions) {
    const emotion=typeof requested==='string'?requested:requested.id;
    let source=declared.find(e=>e.id===emotion);
    const preset=brief.streamerPresets&&emotionPresets.find(e=>e.id===emotion);
    if(!source&&preset)source={name:preset.label,values:Object.fromEntries(
      preset.values.flatMap((v,i)=>v?[[presetAxes[i],v]]:[]))};
    const mood=emotion==='smile'?'happy':emotion;
    if(!source&&['happy','angry','surprise'].includes(mood)) {
      const values={};
      for(const p of parameters)if(/^(brow\.|expression\.brow|eyes\.(emotion|smile)$|expression\.eye|mouth\.form$|expression\.mouth)/.test(p.semantic)) {
        if(p.semantic==='eyes.smile'&&mood!=='happy')continue;
        if(p.semantic.startsWith('expression.eye.')&&p.semantic!=='expression.eye.'+mood)continue;
        if(p.semantic==='eyes.emotion'&&mood==='surprise')continue;
        const brow=p.semantic.includes('brow'),eye=p.semantic.includes('eye');
        const amount=brow?(mood==='surprise'?.8:.45):eye?.6:.65;
        const direction=p.semantic==='expression.eye.'+mood||mood==='happy'||mood==='surprise'&&brow?1:-1;
        values[p.id]=p.default+(direction>0?p.max-p.default:p.default-p.min)*amount*direction;
      }
      const labels={happy:'开心',angry:'生气',surprise:'惊讶'};
      source={id:emotion,name:requested.label??labels[mood],values};
    }
    if(!source) {unresolved.push(problem('DYNAMICS_EXPRESSION_INCOMPLETE','缺少所需表情的真实目标编排：'+String(emotion)));continue;}
    const regions=new Set(),entries=[];
    for(const [id,value] of Object.entries(source.values??{})) {
      const p=byId.get(id);
      if(!p)throw new Fault('DYNAMICS_MAP_INVALID','表情引用不存在的参数');
      if(protectedSemantic(p.semantic)||!permits(p,'expression'))
        throw new Fault('DYNAMICS_OWNERSHIP_CONFLICT','表情不得占用正在跟踪的嘴眼头参数：'+id);
      if(!finite(value)||value<p.min||value>p.max)throw new Fault('DYNAMICS_MAP_INVALID','表情目标超出实际参数范围');
      if(!ready(p))continue;
      if(value===p.default)continue;
      if(p.semantic.startsWith('expression.brow')||p.semantic.startsWith('brow.'))regions.add('brow');
      if(p.semantic.startsWith('expression.eye')||['eyes.emotion','eyes.smile'].includes(p.semantic))regions.add('eye');
      if(p.semantic==='mouth.form'||p.semantic.startsWith('expression.mouth'))regions.add('mouth');
      entries.push({parameter:id,blend:'Add',value:value-p.default});
    }
    if(regions.size<3)unresolved.push(problem('DYNAMICS_EXPRESSION_INCOMPLETE',emotion+'缺少眉眼嘴的真实协调形变'));
    if(typeof emotion!=='string'||!/^[a-z][a-z0-9_-]{0,63}$/.test(emotion))throw new Fault('DYNAMICS_MAP_INVALID','非法表情资源ID');
    expressions.push({id:'dyn_'+emotion,name:source.name??requested.label??emotion,fade_in:0.15,fade_out:0.15,entries});
  }
  if(expressions.length===2&&JSON.stringify(expressions[0].entries)===JSON.stringify(expressions[1].entries))
    unresolved.push(problem('DYNAMICS_EXPRESSIONS_IDENTICAL','开心与生气目标完全相同'));
  const appearanceGroups={};
  for(const requested of intent.clothingVariants??[]) {
    const binding=map.dynamics?.appearances?.find(v=>v.id===requested.id),p=byId.get(binding?.parameter);
    if(!binding||!p||!p.semantic.startsWith('appearance.')) {
      unresolved.push(problem('DYNAMICS_APPEARANCE_UNAVAILABLE','缺少所需外观的独立部件绑定：'+requested.id));continue;
    }
    if(!/^[a-z][a-z0-9_-]{0,63}$/.test(requested.id)||!permits(p,'expression')||binding.off!==p.default||
      !finite(binding.on)||binding.on<p.min||binding.on>p.max||binding.on===binding.off||
      Object.values(appearanceGroups).includes(p.semantic))throw new Fault('DYNAMICS_MAP_INVALID','外观开关未绑定独立轴或无法还原');
    if(!ready(p))continue;
    const id='dyn_appearance_'+requested.id;
    appearanceGroups[id]=p.semantic;
    expressions.push({id,name:binding.name??requested.label??requested.id,fade_in:.12,fade_out:.12,
      entries:[{parameter:p.id,blend:'Add',value:binding.on-binding.off}]});
  }
  const breath=parameters.find(p=>p.semantic==='body.breath');
  const motions=[];
  if(!breath||!ready(breath))unresolved.push(problem('DYNAMICS_IDLE_UNAVAILABLE','待机缺少实际呼吸形变'));
  else {
    if(!permits(breath,'motion'))throw new Fault('DYNAMICS_OWNERSHIP_CONFLICT','呼吸参数未分配给motion');
    const a=breath.default,b=a+(breath.max-a)*0.28;
    if(a===b)unresolved.push(problem('DYNAMICS_IDLE_UNAVAILABLE','呼吸默认值没有可用正向幅度',breath.id));
    motions.push({id:'dyn_idle',name:'待机呼吸',loop:true,duration:4.5,fps:60,fade_in:0.25,fade_out:0.25,enabled:true,
      curves:[{parameter:breath.id,keys:[[0,a],[2,b],[4.5,a]].map(([time,value])=>({time,value,interpolation:'BEZIER'}))}]});
  }
  // Extra actions need 03-authored motion curves, never an invented translation of the whole arm.
  const requested=intent.actions??intent.motions??[];
  if(!Array.isArray(requested))throw new Fault('DYNAMICS_MAP_INVALID','动作需求必须为数组');
  const expandedActions=includeStreamerPresets(requested,brief.streamerPresets,gestureClips);
  for(const action of expandedActions) {
    const id=typeof action==='string'?action:action.id;
    if(['idle','breath','reset','待机','呼吸'].includes(id))continue;
    const clip=map.dynamics?.motions?.find(m=>m.id===id);
    if(!clip) {unresolved.push(problem('DYNAMICS_ACTION_UNAVAILABLE','尚未实现所需动作素材/绑定/曲线：'+String(id)));continue;}
    if(typeof id!=='string'||!/^[a-z][a-z0-9_-]{0,63}$/.test(id)||!finite(clip.duration)||clip.duration<=0||
      !Number.isInteger(clip.fps)||clip.fps<1||clip.fps>120||typeof clip.loop!=='boolean'||!clip.curves?.length)
      throw new Fault('DYNAMICS_MAP_INVALID','动作时长/FPS/曲线无效');
    const ids=new Set();
    for(const k of ['fade_in','fade_out'])if(clip[k]!==undefined&&(!finite(clip[k])||clip[k]<0||clip[k]>60))
      throw new Fault('DYNAMICS_MAP_INVALID','动作淡入淡出无效');
    for(const c of clip.curves) {
      const p=byId.get(c.parameter);
      if(!p||ids.has(c.parameter))throw new Fault('DYNAMICS_MAP_INVALID','动作曲线参数缺失或重复');ids.add(c.parameter);
      if(protectedSemantic(p.semantic)||!permits(p,'motion')||!p.semantic.startsWith('action.'))
        throw new Fault('DYNAMICS_OWNERSHIP_CONFLICT','预设动作只能写03分配的独立action轴');
      ready(p);
      if(!Array.isArray(c.keys)||c.keys.length<2||c.keys[0].time!==0||c.keys.at(-1).time!==clip.duration||
        c.keys.some((k,i)=>!finite(k.time)||!finite(k.value)||k.value<p.min||k.value>p.max||
          i>0&&k.time<=c.keys[i-1].time||!['LINEAR','BEZIER','STEPPED','INVERSE_STEPPED'].includes(k.interpolation??'BEZIER')))
        throw new Fault('DYNAMICS_MAP_INVALID','动作关键帧时间/范围无效');
      if(p.semantic.startsWith('action.wave')&&(clip.loop||c.keys[0].value!==p.default||
        c.keys.at(-1).value!==p.default||!c.keys.some(k=>k.value!==p.default)))
        throw new Fault('DYNAMICS_MAP_INVALID','打招呼须从默认姿态抬起、挥动并回到默认值');
      for(const k of c.keys)for(const h of [k.out,k.in].filter(v=>v!==undefined))if(!Array.isArray(h)||h.length!==2||!h.every(finite)||
        h[0]<0||h[0]>1||k.value+h[1]<p.min||k.value+h[1]>p.max)throw new Fault('DYNAMICS_MAP_INVALID','动作手柄越界');
    }
    const name=clip.name??action.label??id;
    // The built-in skeleton motion named “wave” is reserved even when its export is disabled.
    motions.push({id:'dyn_'+id,name:id==='wave'&&name.toLowerCase()==='wave'?name+' (custom)':name,duration:clip.duration,loop:clip.loop,fps:clip.fps,enabled:true,
      fade_in:clip.fade_in??.2,fade_out:clip.fade_out??.2,curves:clip.curves.map(c=>({parameter:c.parameter,
        keys:c.keys.map(k=>({time:k.time,value:k.value,interpolation:k.interpolation??'BEZIER',...(k.out?{out:k.out}:{}),...(k.in?{in:k.in}:{})}))}))});
  }
  for(const list of [expressions,motions])if(new Set(list.map(r=>r.id)).size!==list.length)throw new Fault('DYNAMICS_MAP_INVALID','资源ID重复');
  if(!outputs.some(p=>p.semantic.startsWith('accessory.')))warnings.push('参数表未登记可动物理饰品；没有凭空创建饰品参数');
  warnings.push('表情编排是候选；需实际核眉眼嘴方向及组合。运行器须释放眉/嘴形/情绪轴给表情，眼开合、开口和头部继续跟踪。');
  return {schemaVersion:1,recipeVersion:RECIPE_VERSION,physicsFps:60,parameters,physics,expressions,motions,appearanceGroups,
    ownership:{tracking:parameters.filter(p=>protectedSemantic(p.semantic)).map(p=>p.id),
      physics:physics.flatMap(g=>g.outputs.map(o=>o.parameter)),
      expression:[...new Set(expressions.flatMap(e=>e.entries.map(v=>v.parameter)))],
      motion:motions.flatMap(m=>m.curves.map(c=>c.parameter)),
      priority:['tracking supplies head/eye-open/mouth-open inputs','expression adds only allocated emotion axes','physics writes only its outputs','idle writes only breath']},
    unresolved,warnings};
}
