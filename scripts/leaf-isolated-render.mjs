// Serialized into a new browser profile. The desktop bridge is limited to whitelisted model bytes.
export async function renderCheck({stagePath, info, controls, drawables=[], eyeSweep=false, turnOnly=false, turnInput='ParamAngleX'}) {
  const reads = new Set();
  window.__TAURI_INTERNALS__ = {async invoke(command, args) {
    if (command !== 'read_model_resource' || args.id !== info.id || !info.files.includes(args.resource))
      throw Error('未允许的本地资源读取');
    const response = await fetch('/model-file/'+encodeURIComponent(args.resource));
    if (!response.ok) throw Error('模型文件读取失败 '+args.resource);
    reads.add(args.resource);
    return response.arrayBuffer();
  }};

  const {A: AvatarStage, r: readSettings} = await import(stagePath);
  const host = document.getElementById('stage');
  if(turnOnly) {host.style.width='800px';host.style.height='800px';}
  const stage = new AvatarStage(host, () => { throw Error('WebGL 上下文丢失'); });
  const settings = readSettings(null);
  Object.assign(settings, {autoBlink:false, idleMotion:'', motionSound:false, outputAspect:'auto',
    x:0, y:0, zoom:1, supersample:false});
  stage.display(settings);
  if (!await stage.load(info)) throw Error('模型加载未完成');

  const params = stage.parameters;
  const tracked = Object.fromEntries([['ParamAngleX',5],['ParamAngleY',0],['ParamMouthOpenY',0.3]]
    .filter(([id]) => params.some(p => p.id===id)));
  const draw = frames => { for(let i=0;i<frames;i++) stage.draw(tracked,1000/30); };
  const near = (a,b) => Math.abs(a-b) < 0.025;
  const diff = (a,b) => {
    let changed=0;
    for(let i=0;i<a.length;i+=4) {
      if (Math.max(Math.abs(a[i]-b[i]),Math.abs(a[i+1]-b[i+1]),Math.abs(a[i+2]-b[i+2]),Math.abs(a[i+3]-b[i+3]))>10) changed++;
    }
    return changed;
  };
  const canvas = host.querySelector('canvas');
  const pixels = () => new Uint8Array(stage.transparentPixels(canvas.width,canvas.height));
  const notes=[], images=[];
  const raw=stage.model.internalModel.coreModel.getModel().drawables;
  const indices=drawables.map(id=>{
    const index=raw.ids.indexOf(id);
    if(index<0) throw Error('实际 MOC 缺少指定 drawable '+id);
    return [id,index];
  });
  function capture() {
    const state={...stage.frame};
    const frame=document.createElement('canvas');
    frame.width=canvas.width; frame.height=canvas.height;
    frame.getContext('2d').drawImage(canvas,0,0);
    const actual=pixels();
    let visible=0;
    for(let i=3;i<actual.length;i+=4) if(actual[i]>12) visible++;
    if(visible<16) throw Error('画布没有可观察的非透明图元');
    const geometry=Object.fromEntries(indices.map(([id,index])=>{
      const vertices=raw.vertexPositions[index], xs=[],ys=[];
      for(let i=0;i<vertices.length;i+=2){xs.push(vertices[i]);ys.push(vertices[i+1]);}
      return [id,{opacity:raw.opacities[index],vertexCount:xs.length,drawOrder:raw.drawOrders[index],
        renderOrder:raw.renderOrders[index],bounds:[Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)]}];
    }));
    return {state,frame,visible,motion:stage.currentMotion,expressions:[...stage.activeExpressions],geometry};
  }
  function snapshot(title, previous, ids=[], observed=capture()) {
    const {state,frame,visible,motion,expressions,geometry}=observed;
    let contribution=null;
    if(previous && ids.length) {
      // Re-render the identical pose twice with frozen parameters, changing only this control's parameters.
      // Official parameterOverrides are applied immediately before coreModel.update().
      const saved=settings.parameterOverrides;
      try {
        settings.parameterOverrides={...state};
        stage.draw(tracked,1);
        const on=pixels();
        for(const id of ids) settings.parameterOverrides[id]=previous[id];
        stage.draw(tracked,1);
        const off=pixels();
        if(!ids.every(id=>near(stage.frame[id],previous[id]))) throw Error('同姿态差分未能设置参考参数 '+title);
        contribution=diff(on,off);
      } finally {
        settings.parameterOverrides=saved;
        stage.draw(tracked,1);
      }
    }
    const note={title,visiblePixels:visible,controlledPixels:contribution,motion,
      expressions,parameters:state,...(indices.length?{drawables:geometry}:{})};
    images.push(frame); notes.push(note);
    return note;
  }

  if(turnOnly){
    const yaw=params.find(p=>p.id===turnInput);
    if(!yaw || yaw.min>-12 || yaw.max<12) throw Error('模型不支持小幅左右转头');
    const defaults=Object.fromEntries(params.map(p=>[p.id,p.default]));
    const poseFrames={}, counts=[];
    for(const [label,angle] of [['default',0],['left',-12],['right',12],['restored',0]]){
      // Hold other authored parameters at their actual defaults to inspect registration and yaw alone.
      // Some VTS-authored characters feed yaw through their own physics input before ParamAngleX.
      const input={...defaults,[turnInput]:angle},steps=turnInput==='ParamAngleX'?1:90;
      for(let i=0;i<steps;i++)stage.draw(input,1000/30);
      const seen=capture();
      counts.push({label,angle,inputReadback:seen.state[turnInput],readback:seen.state.ParamAngleX,visiblePixels:seen.visible,
        ...(indices.length?{drawables:seen.geometry}:{})});
      poseFrames[label]=seen.frame.toDataURL('image/png').split(',')[1];
      images.push(seen.frame);
    }
    const toBytes=canvas=>canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
    const base=toBytes(images[0]);
    for(let i=0;i<images.length;i++) counts[i].changedPixels=diff(base,toBytes(images[i]));
    const sheet=document.createElement('canvas');sheet.width=1000;sheet.height=280;
    const c=sheet.getContext('2d');c.fillStyle='#222c38';c.fillRect(0,0,sheet.width,sheet.height);
    c.fillStyle='white';c.font='16px sans-serif';
    images.forEach((frame,i)=>{c.drawImage(frame,i*250,0,250,250);c.fillText(counts[i].label,i*250+5,268);});
    return {renderer:'VTubeLeaf 1.3.1 AvatarStage / Chromium WebGL',core:window.Live2DCubismCore.Version.csmGetVersion(),
      resourceReads:[...reads].sort(),controlsObserved:'not_run',motionReturned:'not_run',restored:'not_run',
      turnCheck:{inputParameter:turnInput,passed:counts.every(c=>near(c.angle,c.readback)) && counts[1].changedPixels>0 && counts[2].changedPixels>0 &&
        counts[3].changedPixels===0,frames:counts},poseFrames,contactSheet:sheet.toDataURL('image/png').split(',')[1]};
  }

  draw(30); const baseline=snapshot('Neutral');
  const controlsSeen=[], appearanceReturns=[];
  const expressions=controls.expressions.map(c=>({...c,item:stage.expressions.find(e=>e.id===c.leafId)}));
  const motion=stage.motions.find(m=>m.id===controls.motion.leafId);
  if (expressions.some(e=>!e.item) || !motion) throw Error('实际引擎缺少指定 Leaf 入口');
  const ownedBy = e => e.item.data.Parameters.map(p=>p.Id).filter(id=>Object.hasOwn(baseline.parameters,id));
  let emotion;
  for(const e of expressions.filter(e=>e.kind==='emotion')) {
    if(emotion) stage.toggleExpression(emotion.leafId);
    stage.toggleExpression(e.leafId); draw(60);
    const before=notes.at(-1);
    const ids=ownedBy(e), moved=[...new Set([...ids,...(emotion?ownedBy(emotion):[])])];
    const on=snapshot(e.name??e.id,before.parameters,moved);
    controlsSeen.push(on.controlledPixels>0 && on.expressions.length===1 && on.expressions.includes(e.leafId) &&
      ids.some(id=>!near(on.parameters[id],baseline.parameters[id])));
    emotion=e;
  }

  const before=notes.at(-1);
  const motionIds=[...new Set(motion.data.Curves.filter(c=>c.Target==='Parameter').map(c=>c.Id))]
    .filter(id=>Object.hasOwn(before.parameters,id));
  const frames=Math.ceil(motion.data.Meta.Duration*30);
  if(!Number.isSafeInteger(frames) || frames<1 || frames>900 || !motionIds.length) throw Error('动作缺少可检查的参数或时长');
  const motionPeak={};
  const samples=new Map(),ranges=Object.fromEntries(params.map(p=>[p.id,p.max-p.min||1]));
  let peak;
  stage.playMotion(motion.id,'once');
  for(let i=0;i<frames+33;i++) {
    draw(1);
    for(const id of motionIds) {
      const delta=Math.abs(stage.frame[id]-before.parameters[id]);
      motionPeak[id]=Math.max(motionPeak[id]??0,delta);
    }
    if(stage.currentMotion===motion.id){
      const score=motionIds.reduce((n,id)=>n+Math.abs(stage.frame[id]-before.parameters[id])/ranges[id],0);
      const atCheckpoint=i===Math.floor(frames*.33) || i===Math.floor(frames*.66);
      if(!peak || score>peak.score || atCheckpoint){
        const observed=capture();
        if(!peak || score>peak.score) peak={i,score,observed};
        if(atCheckpoint) samples.set(i,observed);
      }
    }
  }
  if(peak) samples.set(peak.i,peak.observed);
  for(const [i,observed] of [...samples].sort(([a],[b])=>a-b))
    snapshot(motion.id+' '+(i+1),before.parameters,motionIds,observed);
  const end=snapshot('Motion end');
  const motionReturned=notes.some(s=>s.motion===motion.id && s.controlledPixels>0) &&
    !end.motion && motionIds.every(id=>near(end.parameters[id],before.parameters[id]));
  for(const e of expressions.filter(e=>e.kind==='appearance')) {
    const before=notes.at(-1), ids=ownedBy(e);
    stage.toggleExpression(e.leafId); draw(60);
    const on=snapshot(e.name??e.id,before.parameters,ids);
    stage.toggleExpression(e.leafId); draw(60);
    const off=snapshot((e.name??e.id)+' off',on.parameters,ids);
    const preserved=!emotion || [on,off].every(frame=>frame.expressions.includes(emotion.leafId) &&
      ownedBy(emotion).every(id=>near(frame.parameters[id],before.parameters[id])));
    controlsSeen.push(on.controlledPixels>0 && on.expressions.includes(e.leafId));
    appearanceReturns.push(off.controlledPixels>0 && !off.expressions.includes(e.leafId) &&
      ids.every(id=>near(off.parameters[id],before.parameters[id])) && preserved);
  }

  // Exercise each release through Leaf's own controls while the other controls stay active.
  const independentResets=[];
  for(const appearance of expressions.filter(e=>e.kind==='appearance')) {
    if(!emotion) continue;
    const emotionIds=ownedBy(emotion), appearanceIds=ownedBy(appearance);
    const equal=(ids,a,b)=>ids.every(id=>near(a[id],b[id]));
    const advanceToGesture=()=>{stage.playMotion(motion.id,'once');draw(Math.max(1,Math.floor(frames*.33)));};
    stage.setExpression(appearance.leafId,true,undefined,0); draw(2);
    advanceToGesture();
    const expressionBefore=snapshot('Before expression release');
    stage.setExpression(emotion.leafId,false,undefined,0); draw(2);
    const expressionAfter=snapshot('Expression released independently',expressionBefore.parameters,emotionIds);
    independentResets.push({control:'expression',passed:expressionAfter.controlledPixels>0 &&
      !expressionAfter.expressions.includes(emotion.leafId) && expressionAfter.expressions.includes(appearance.leafId) &&
      expressionAfter.motion===motion.id && equal(emotionIds,expressionAfter.parameters,baseline.parameters) &&
      equal(appearanceIds,expressionAfter.parameters,expressionBefore.parameters)});

    stage.setExpression(emotion.leafId,true,undefined,0); draw(2);
    const motionBefore=snapshot('Before gesture release');
    stage.stopMotion(); draw(2);
    const motionAfter=snapshot('Gesture released independently',motionBefore.parameters,motionIds);
    independentResets.push({control:'gesture',passed:motionAfter.controlledPixels>0 && !motionAfter.motion &&
      motionAfter.expressions.includes(emotion.leafId) && motionAfter.expressions.includes(appearance.leafId) &&
      equal(motionIds,motionAfter.parameters,baseline.parameters) && equal(emotionIds,motionAfter.parameters,motionBefore.parameters) &&
      equal(appearanceIds,motionAfter.parameters,motionBefore.parameters)});

    advanceToGesture();
    const appearanceBefore=snapshot('Before appearance release');
    stage.setExpression(appearance.leafId,false,undefined,0); draw(2);
    const appearanceAfter=snapshot('Appearance released independently',appearanceBefore.parameters,appearanceIds);
    independentResets.push({control:'appearance',passed:appearanceAfter.controlledPixels>0 &&
      !appearanceAfter.expressions.includes(appearance.leafId) && appearanceAfter.expressions.includes(emotion.leafId) &&
      appearanceAfter.motion===motion.id && equal(appearanceIds,appearanceAfter.parameters,baseline.parameters) &&
      equal(emotionIds,appearanceAfter.parameters,appearanceBefore.parameters)});
  }

  stage.restoreDefaultAppearance(settings); draw(60);
  const last=snapshot('Restored');
  const owned=[...new Set(expressions.flatMap(ownedBy))];
  const trackingPreserved=notes.every(note=>Object.entries(tracked)
    .filter(([id])=>!note.motion || !motionIds.includes(id)).every(([id,v])=>near(note.parameters[id],v)));
  const restored=trackingPreserved && !last.motion && !last.expressions.length && owned.every(id=>near(last.parameters[id],baseline.parameters[id])) &&
    Object.entries(tracked).every(([id,v])=>near(last.parameters[id],v));

  if(eyeSweep) {
    const eyes=['ParamEyeLOpen','ParamEyeROpen'];
    if(!eyes.every(id=>Object.hasOwn(baseline.parameters,id))) throw Error('探针不含双眼开度');
    for(const open of [1,.5,.3,0]){
      const pose={...tracked,ParamEyeLOpen:open,ParamEyeROpen:open};
      stage.draw(pose,1000/30);
      snapshot('EyeOpen '+open,baseline.parameters,eyes);
    }
  }
  const sheet=document.createElement('canvas');
  const cols=Math.min(4,images.length), w=245,h=282;
  sheet.width=cols*w; sheet.height=Math.ceil(images.length/cols)*h;
  const ctx=sheet.getContext('2d'); ctx.fillStyle='#222c38';ctx.fillRect(0,0,sheet.width,sheet.height);
  ctx.fillStyle='white';ctx.font='13px sans-serif';
  images.forEach((frame,i)=>{
    const x=i%cols*w,y=Math.floor(i/cols)*h;
    ctx.drawImage(frame,x,y,w,h-25);ctx.fillText(notes[i].title,x+6,y+h-8,w-10);
  });
  return {renderer:'VTubeLeaf 1.3.1 AvatarStage / Chromium WebGL',core:window.Live2DCubismCore.Version.csmGetVersion(),
    controlsObserved:controlsSeen.every(Boolean)&&appearanceReturns.every(Boolean)&&independentResets.every(r=>r.passed),motionReturned,restored,
    independentResets:independentResets.length?independentResets:'not_run',
    syntheticTracking:tracked,trackingPreserved,resourceReads:[...reads].sort(),parameters:params.length,
    modelExpressions:stage.expressions.map(e=>({id:e.id,name:e.name})),modelMotions:stage.motions.map(m=>({id:m.id,name:m.name})),
    motionPeak,frames:notes,contactSheet:sheet.toDataURL('image/png').split(',')[1]};
}
