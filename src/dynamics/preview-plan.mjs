import {Fault} from '../rpc.mjs';
import {hasMovingShape} from './recipe.mjs';

export function registeredWaveFrames(playback) {
  const start=playback.findIndex(frame=>frame.phase==='motion:dyn_wave');
  if(start===-1)return [];
  const end=playback.findIndex((frame,i)=>i>start&&!/^(motion|cancel):dyn_wave$/.test(frame.phase));
  const axes=Object.keys(playback[start].values).filter(id=>/^(ParamWave|ParamWaveLift|ParamWaveWrist|ParamGreetingWrist|ParamGreetingBalance|ParamGreetingFinger[1-5])$/.test(id));
  return playback.slice(start,end===-1?undefined:end)
    .map(frame=>Object.fromEntries(axes.map(id=>[id,frame.values[id]])));
}

export function previewRasterSize(recipe,frameCount) {
  // 3.6.7 holds all RGBA frames in memory, in addition to its renderer and the loaded model.
  const rect=recipe.parameters.map(p=>p.motionEvidence?.[0]?.defaultMetadata?.canvasRect).find(r=>
    r?.left===0&&r.top===0&&Number.isFinite(r.right)&&Number.isFinite(r.bottom)&&r.right>0&&r.bottom>0);
  const width=rect?.right??1024,height=rect?.bottom??1024,long=Math.max(width,height);
  const ratio=Math.min(width,height)/long;
  const retainedPixels=256*1024*1024;
  return Math.max(16,Math.floor(Math.min(1024,long,Math.sqrt(retainedPixels/(frameCount*ratio)))));
}

// A transient test trajectory, not camera tracking or a runtime expression adapter.
export function planDynamicsPreview(recipe,brief,{fps=30,continuousTracking=true,expressionFades=true}={}) {
  if(!Number.isInteger(fps)||fps<24||fps>60)throw new Fault('DYNAMICS_PREVIEW_INVALID','预览FPS须为24..60');
  const params=recipe.parameters,defaults=Object.fromEntries(params.map(p=>[p.id,p.default]));
  const need=(semantic)=>{
    const p=params.find(p=>p.semantic===semantic);
    if(!p||!hasMovingShape(p))throw new Fault('DYNAMICS_PREVIEW_SHAPE_MISSING','缺少真实组合形变：'+semantic);
    return p;
  };
  const range=p=>{
    const r=p.authoredRange;
    if(!Array.isArray(r)||r.length!==2||!r.every(Number.isFinite)||r[0]>p.default||r[1]<p.default||r[0]<p.min||r[1]>p.max)
      throw new Fault('DYNAMICS_PREVIEW_RANGE_MISSING','需要03实际authoredRange：'+p.id);
    return r;
  };
  const head=brief?.intent?.headMotion;
  if(!head||!['yawDegrees','pitchDegrees','rollDegrees'].every(k=>Number.isFinite(head[k])&&head[k]>=0))
    throw new Fault('DYNAMICS_PREVIEW_RANGE_MISSING','需要原brief头角范围，不静默缩小');
  const axes=[['head.yaw',head.yawDegrees],['head.pitch',head.pitchDegrees],['head.roll',head.rollDegrees]]
    .filter(([,n])=>n>0).map(([s,n])=>{
      const p=need(s),r=range(p);
      if(p.unit!=='degree'||r[0]>-n||r[1]<n)throw new Fault('DYNAMICS_PREVIEW_RANGE_MISSING','请求头角超出已验证范围：'+s);
      return {p,extent:n};
    });
  const yaw=axes.find(a=>a.p.semantic==='head.yaw');
  if(!yaw||!recipe.physics.length)throw new Fault('DYNAMICS_PREVIEW_INVALID','物理验证需要头部X输入及真实物理组');
  const mouth=need('mouth.open'),eyes=[need('eye.left.open'),need('eye.right.open')];
  for(const p of [mouth,...eyes])if(range(p)[0]>p.min||range(p)[1]<p.max)
    throw new Fault('DYNAMICS_PREVIEW_RANGE_MISSING','眼嘴开合范围尚未完整验证：'+p.id);
  const phases=[];let duration=0;
  const add=(id,seconds,extra={})=>{phases.push({id,from:duration,to:duration+seconds,...extra});duration+=seconds;};
  const idle=recipe.motions.find(m=>m.id==='dyn_idle');
  const appearances=recipe.expressions.filter(e=>recipe.appearanceGroups?.[e.id]);
  const continuous=continuousTracking&&(appearances.length>0||recipe.motions.some(m=>m.id!=='dyn_idle'));
  const articulatedGreeting=recipe.motions.some(m=>m.id==='dyn_wave'&&m.curves.some(c=>c.parameter==='ParamGreetingWrist'));
  const body=articulatedGreeting?['X','Y','Z'].map(a=>params.find(p=>p.semantic==='body.angle'+a&&hasMovingShape(p))):[];
  const emotions=recipe.expressions.filter(e=>!recipe.appearanceGroups?.[e.id]);
  const fadeEmotions=expressionFades&&emotions.some(e=>e.fade_in>0||e.fade_out>0);
  if(!idle||emotions.length<2)throw new Fault('DYNAMICS_PREVIEW_INVALID','需要真实待机及至少两项表情');
  add('neutral',1);
  if(continuous)add('head-nine-directions',5.4,{combine:true});
  if(appearances.length)add('turn-and-speak',2,{combine:true});
  for(const e of emotions)add('expression:'+e.id,2,{expressionId:e.id,motionId:idle.id,combine:true});
  const last=emotions.at(-1);
  add('cancel-motion-preserve-expression',1,{expressionId:last.id});
  for(const m of recipe.motions.filter(m=>m.id!==idle.id)) {
    const preset=m.id.startsWith('dyn_preset_');
    add('motion:'+m.id,m.duration,{motionId:m.id,expressionId:last.id,combine:!preset,...(preset?{isolatedPreset:true}:{})});
    add('cancel:'+m.id,1,{expressionId:last.id,...(preset?{isolatedPreset:true}:{})});
  }
  for(const e of appearances) {
    add('appearance-on:'+e.id,1.5,{expressionId:last.id,appearanceId:e.id,combine:true});
    add('appearance-off:'+e.id,1.5,{expressionId:last.id,combine:true});
  }
  const action=recipe.motions.find(m=>m.id!=='dyn_idle');
  if(action)for(const e of appearances) {
    add('combined-controls:'+action.id+':'+e.id,action.duration,{motionId:action.id,expressionId:last.id,appearanceId:e.id,combine:true});
    add('cancel-motion-preserve-appearance:'+e.id,1,{expressionId:last.id,appearanceId:e.id,combine:true});
    add('reset-expression-preserve-appearance:'+e.id,1,{appearanceId:e.id,combine:true});
    add('reset-appearance-preserve-tracking:'+e.id,1,{combine:true});
  }
  add('restore-baseline',1);
  add('physics-slow-turn',4);add('physics-fast-stop',1);add('physics-reverse',1);add('physics-settle',3);
  // Schedule the terminal pose once. Summing decimal phase durations can place
  // a nominal frame boundary a few ulps above the grid; PSD2Live merges such keys.
  const intervals=Math.ceil(duration*fps-1e-9);
  duration=intervals/fps;
  // The engine parses duration and multiplies by fps in Float32 before ceil.
  const nativeDuration=Math.fround(duration);
  if(Math.fround(nativeDuration*fps)>intervals)
    duration=Math.fround(nativeDuration*(1-2**-24));
  if(intervals+1>3600||intervals+1>4096)
    throw new Fault('DYNAMICS_PREVIEW_INVALID','完整验证超过引擎逐帧限制，需明确拆分样片，不截断需求');
  const frames=[];
  const firstPreset=phases.findIndex(p=>p.isolatedPreset);
  const idleStart=phases.find(p=>p.motionId===idle.id).from;
  const idleRelease=.25;
  const ease=value=>{const x=Math.max(0,Math.min(1,value));return x*x*(3-2*x);};
  const conversation=(t,i)=>[
    .66*Math.sin(t*1.5)+.15*Math.sin(t*2.7+.6),
    .24*Math.sin(t*1.07-.45)+.1*Math.sin(t*2.24+.7),
    .48*Math.sin(t*1.47-.82)+.12*Math.sin(t*2.35)
  ][i];
  for(let i=0;i<=intervals;i++) {
    const time=i===intervals?duration:i/fps;
    const phaseIndex=phases.findIndex(p=>time<p.to);
    const phase=phases[phaseIndex]??phases.at(-1),local=time-phase.from;
    const values={...defaults};
    if(!phase.isolatedPreset&&(phase.combine||(continuous&&phase.id!=='neutral'&&!phase.id.startsWith('physics-')))) {
      const trackingTime=continuous?time-phases[0].to:local;
      // Finish the tracking demonstration smoothly before the independent physics-only sweep.
      let weight=continuous&&phase.id==='restore-baseline'?Math.min(1,(phase.to-time)/.3):1;
      if(firstPreset>0) {
        const enter=phases[firstPreset],exit=phases.find(p=>p.from>=enter.to&&!p.isolatedPreset);
        if(phase===phases[firstPreset-1])weight*=Math.min(1,(enter.from-time)/.4);
        if(phase===exit)weight*=Math.min(1,local/.35);
      }
      // Walk the complete 3×3 boundary from and back to neutral. Independent
      // half-amplitude sines never exercised the requested pitch corners.
      if(continuous&&articulatedGreeting&&phase.id!=='head-nine-directions') {
        const t=trackingTime-5.4;
        weight*=ease(t/.42);
        for(const {p,extent} of axes) {
          const i=['head.yaw','head.pitch','head.roll'].indexOf(p.semantic);
          values[p.id]=weight*extent*conversation(t,i);
        }
        for(const [i,p] of body.entries())if(p) {
          const amount=weight*conversation(t-.19,i)*[2.8,1.8,2.4][i],r=range(p);
          values[p.id]=Math.max(r[0],Math.min(r[1],p.default+amount));
        }
        const phrase=ease((Math.sin(t*2.32-.2)+.38)/.85);
        const syllable=.10+.49*Math.abs(Math.sin(t*8.5+Math.sin(t*2.9)))**1.7;
        values[mouth.id]=mouth.min+(mouth.max-mouth.min)*weight*phrase*syllable;
        for(const [i,p] of eyes.entries()) {
          const clock=t+.12*Math.sin(t*1.1)-i*.012;
          const offset=(((clock-.62)%2.37+2.37)%2.37+1.185)%2.37-1.185;
          const blink=ease(1-Math.abs(offset)/(offset<0?.11:.17));
          values[p.id]=p.default+(p.min-p.default)*weight*blink;
        }
      } else {
        const path=[[0,0],[-1,-1],[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[0,0]];
        const position=((trackingTime%5.4)+5.4)%5.4/.6,index=Math.min(8,Math.floor(position)),mix=(1-Math.cos((position-index)*Math.PI))/2;
        const handoff=fadeEmotions&&continuous&&articulatedGreeting&&phase.id==='head-nine-directions'
          ?ease((phase.to-time)/.55):1;
        for(const {p,extent} of axes) {
          const axis=p.semantic==='head.yaw'?0:p.semantic==='head.pitch'?1:null;
          values[p.id]=weight*extent*(axis===null?handoff*Math.sin(trackingTime*Math.PI):path[index][axis]*(1-mix)+path[index+1][axis]*mix);
        }
        values[mouth.id]=mouth.min+(mouth.max-mouth.min)*.8*weight*handoff*Math.max(0,Math.sin(trackingTime*Math.PI*3));
        const blinkTime=continuous?trackingTime%2:local,blink=Math.max(0,1-Math.abs(blinkTime-.7)/.12);
        for(const p of eyes)values[p.id]=p.default+(p.min-p.default)*weight*handoff*blink;
      }
    }
    if(phase.id==='physics-slow-turn')values[yaw.p.id]=yaw.extent*Math.sin(local*Math.PI/2);
    if(phase.id==='physics-fast-stop')values[yaw.p.id]=yaw.extent*Math.min(1,local/.15);
    if(phase.id==='physics-reverse')values[yaw.p.id]=yaw.extent*(1-2*Math.min(1,local/.15));
    // A new emotion fades in as the preceding emotion fades out. Continuing
    // the same emotion through motion cancellation must not restart its fade.
    const emotion=emotions.find(e=>e.id===phase.expressionId);
    const previous=emotions.find(e=>e.id===phases[phaseIndex-1]?.expressionId);
    const appearance=appearances.find(e=>e.id===phase.appearanceId);
    const switching=fadeEmotions&&previous!==emotion;
    const fade=(seconds)=>seconds>0?.5-.5*Math.cos(Math.PI*Math.max(0,Math.min(1,local/seconds))):1;
    const additions=new Map();
    for(const [expression,weight] of [[emotion,switching?fade(emotion?.fade_in):1],
      [previous,switching?1-fade(previous?.fade_out):0],[appearance,1]]) {
      if(!expression||weight===0)continue;
      for(const e of expression.entries) {
        if(e.blend!=='Add')throw new Fault('DYNAMICS_PREVIEW_INVALID','预览不支持此表情混合方式');
        additions.set(e.parameter,(additions.get(e.parameter)??0)+weight*e.value);
      }
    }
    for(const [id,add] of additions) {
      const p=params.find(p=>p.id===id);
      values[id]=Math.max(p.min,Math.min(p.max,values[id]+add));
    }
    for(const id of recipe.ownership.physics)delete values[id]; // Native renderer owns the pendulums.
    let motion=phase.motionId?{id:phase.motionId,time:local}:undefined;
    if(fadeEmotions&&idle.loop!==false) {
      const releasing=phase.id==='cancel-motion-preserve-expression'&&local<idleRelease;
      if(phase.motionId===idle.id||releasing) {
        const clock=(time-idleStart)%idle.duration;
        motion={id:idle.id,time:clock,...(releasing?{weight:1-ease(local/idleRelease)}:{})};
      }
    }
    frames.push({time,phase:phase.id,values,...(motion?{motion}:{})});
  }
  return {schemaVersion:1,fps,duration,frameCount:frames.length,phases,frames,...(continuous?{trackingClock:'continuous'}:{}),
    ...(fadeEmotions?{expressionClock:'registered-fades'}:{}),
    method:'native raster export, independent physics session; expression values and motion samples replayed in a temporary clip',
    limitations:['制作预览，非真人跟随；表情/取消/复位是已知中性基线的参数回放，不证明运行器原生资源释放',
      '实际motion_sample按预览FPS重采样为线性帧；引擎独立计算物理，不能据此认定Cubism运行兼容或跟随延迟']};
}

export async function previewClip(plan,recipe,sample) {
  const frames=[];
  for(const f of plan.frames) {
    const values={...f.values};
    if(f.motion) {
      const m=recipe.motions.find(m=>m.id===f.motion.id),v=await sample(m,f.motion.time);
      if(Object.keys(v).some(id=>!m.curves.some(c=>c.parameter===id))||m.curves.some(c=>!Number.isFinite(v[c.parameter])))
        throw new Fault('DYNAMICS_PREVIEW_INVALID','实际动作采样缺失或包含未分配轴');
      for(const [id,n] of Object.entries(v)) {
        const p=recipe.parameters.find(p=>p.id===id);
        // PSD2Live samples its cubic Bezier in Float, including a constant 1 plateau.
        const limit=Math.max(p.min,Math.min(p.max,n));
        const rounding=Math.max(1,Math.abs(limit))*2**-23;
        if(Math.abs(n-limit)>rounding)throw new Fault('DYNAMICS_PREVIEW_INVALID','实际动作采样越界：'+id);
        values[id]=f.motion.weight===undefined?limit:p.default+(limit-p.default)*f.motion.weight;
      }
    }
    frames.push({...f,values});
  }
  const ids=Object.keys(frames[0].values);
  return {id:'dyn_verification_preview',name:'制作验证回放（非真人跟随）',duration:plan.duration,fps:plan.fps,loop:false,
    enabled:true,fade_in:0,fade_out:0,curves:ids.map(parameter=>({parameter,
      keys:frames.map(f=>({time:f.time,value:f.values[parameter],interpolation:'LINEAR'}))}))};
}
