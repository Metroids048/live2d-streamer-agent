import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {parseArgs} from 'node:util';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {readInstalledRenderer,stagePath} from './leaf-isolated-assets.mjs';
import {inspectModel} from '../src/packaging/model.mjs';
import {digest} from '../src/packaging/files.mjs';
import {ffmpeg} from '../src/preview.mjs';
import {buildBroadcastPlayback,buildVideoOnlyPlayback} from '../src/dynamics/broadcast-preview.mjs';

// This renders the supplied MOC with the installed Leaf core. It never touches the desktop model or camera.
const {values:args}=parseArgs({options:{
  ...Object.fromEntries(['model','artwork','output','seconds','trajectory','task-root','request','video-profile'].map(k=>[k,{type:'string'}])),
  'compare-parent-track':{type:'boolean'},'live-style':{type:'boolean'},'video-only':{type:'boolean'}
}});
if(!args.model||!args.artwork||!args.output)throw Error('Use --model MODEL --artwork MANIFEST --output NEW_DIR [--seconds 12]');
const describe=bytes=>({bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
const requestBytes=args.request?await fs.readFile(args.request):null;
const sourceRequest=requestBytes?JSON.parse(requestBytes.toString('utf8')):null;
if(sourceRequest&&(!args['task-root']||!args.trajectory))throw Error('Packaging requires a registered task root and dynamics trajectory');
const compareParent=args['compare-parent-track']===true;
if(compareParent&&(sourceRequest||!args['task-root']||!args.trajectory))throw Error('A comparison requires a candidate root and parent trajectory; it cannot be a packaging render');
const liveStyle=args['live-style']===true;
if(liveStyle&&(!args.trajectory||sourceRequest))throw Error('Live-style preview requires a registered dynamics track');
const videoOnly=args['video-only']===true;
if(videoOnly&&(!args.trajectory||sourceRequest||liveStyle))throw Error('Video-only preview requires one registered dynamics track');
const videoProfile=args['video-profile']??'balanced';
if(!['balanced','teal','teal-cut-safe','silver','chestnut'].includes(videoProfile))throw Error('Invalid video-only profile');
if(!videoOnly&&args['video-profile'])throw Error('Video-only profile requires --video-only');
const studioPreview=liveStyle||videoOnly;
const trajectoryBytes=args.trajectory?await fs.readFile(args.trajectory):null;
const trajectory=trajectoryBytes?JSON.parse(trajectoryBytes.toString('utf8')):null;
let seconds=trajectory?.duration??Number(args.seconds??12);
const fps=trajectory?.fps??30;
if(!Number.isFinite(seconds)||seconds<=0||seconds>(trajectory?120:30)||fps!==30)throw Error('Invalid preview duration or FPS');
let playback=null;
if(trajectory){
  const {clip,frames,frameCount}=trajectory;
  if(!clip||clip.fps!==fps||clip.duration!==seconds||!Array.isArray(frames)||frames.length!==frameCount||
    frameCount!==Math.ceil(seconds*fps)+1||!Array.isArray(clip.curves)||!clip.curves.length)throw Error('Invalid registered dynamics trajectory');
  playback=frames.map((frame,i)=>{
    if(Math.abs(frame.time-Math.min(seconds,i/fps))>1e-6||typeof frame.phase!=='string')throw Error('Trajectory clock mismatch');
    return {time:frame.time,phase:frame.phase,values:Object.fromEntries(clip.curves.map(curve=>{
      const key=curve.keys?.[i];
      if(!curve.parameter||curve.keys.length!==frameCount||!Number.isFinite(key?.value)||Math.abs(key.time-frame.time)>1e-6)throw Error('Trajectory curve mismatch');
      return [curve.parameter,key.value];
    }))};
  });
}
const videoName=sourceRequest?'preview-1080p30.mp4':videoOnly?'video-only-1080p30.mp4':liveStyle?'live-style-1080p30.mp4':trajectory?'Hachi-full-1080p30.mp4':'Hachi-G1-1080p30.mp4';
const entry=await fs.realpath(args.model),dir=path.dirname(entry),name=path.basename(entry);
const artworkBytes=await fs.readFile(args.artwork),artwork=JSON.parse(artworkBytes.toString('utf8'));
let modelStage,revisionRoot;
if(trajectory){
  const trajectoryRoot=path.resolve(path.dirname(args.trajectory),'../..');
  revisionRoot=args['task-root']?path.resolve(args['task-root']):trajectoryRoot;
  const trackStage=JSON.parse(await fs.readFile(path.join(compareParent?trajectoryRoot:revisionRoot,'dynamics/stage.json'),'utf8'));
  modelStage=compareParent?JSON.parse(await fs.readFile(path.join(revisionRoot,'rigging/stage.json'),'utf8')):trackStage;
  const lineageKeys=['taskId','candidateId','inputSha256','descriptionSha256'];
  let fromAncestor=false;
  if(compareParent&&path.dirname(trajectoryRoot)===path.dirname(revisionRoot)&&
    Number.isSafeInteger(trackStage.revision)&&trackStage.revision>0&&
    path.basename(trajectoryRoot)==='r'+String(trackStage.revision).padStart(4,'0')&&
    lineageKeys.every(k=>trackStage[k]===artwork[k])){
    let revision=artwork.revision,parent=artwork.parentRevision;
    while(Number.isSafeInteger(parent)&&parent>=trackStage.revision&&parent<revision){
      if(parent===trackStage.revision){fromAncestor=true;break;}
      const source=JSON.parse(await fs.readFile(path.join(path.dirname(revisionRoot),
        'r'+String(parent).padStart(4,'0'),'artwork/stage.json'),'utf8'));
      if(source.stage!=='artwork'||source.revision!==parent||lineageKeys.some(k=>source[k]!==artwork[k]))break;
      revision=parent;
      parent=source.parentRevision;
    }
  }
  if(trackStage.stage!=='dynamics'||trackStage.previewCapture?.status!=='captured'||trackStage.pending||
    modelStage.stage!==(compareParent?'rigging':'dynamics')||modelStage.pending||
    ['taskId','candidateId','revision','parentRevision','inputSha256','descriptionSha256'].some(k=>modelStage[k]!==artwork[k])||
    path.resolve(revisionRoot,modelStage.modelPath)!==entry||
    compareParent&&(!fromAncestor||
      !modelStage.checks?.some(c=>c.name==='rigging_export_integrity'&&c.status==='passed')))
    throw Error('Trajectory or model is outside the registered candidate lineage');
  const trackPath=path.relative(compareParent?trajectoryRoot:revisionRoot,path.resolve(args.trajectory)).split(path.sep).join('/');
  const registered=trackStage.artifacts.find(a=>a.path===trackPath),actual=describe(trajectoryBytes);
  if(!registered||registered.sha256!==actual.sha256||registered.bytes!==actual.bytes)throw Error('Registered dynamics trajectory changed');
}
const face=artwork.parts.find(p=>p.tags?.includes('face'));
if(!face?.rect||!artwork.canvas)throw Error('Artwork lacks registered face coordinates');
const model=await inspectModel(dir,name),output=path.resolve(args.output);
const modelAssets=new Map(),modelFiles=[];
for(const file of model.files){
  const source=path.join(dir,file),bytes=await fs.readFile(source),actual=describe(bytes);
  if(modelStage){
    const relative=path.relative(revisionRoot,source).split(path.sep).join('/');
    const registered=modelStage.artifacts.find(a=>a.path===relative);
    if(!registered||registered.sha256!==actual.sha256||registered.bytes!==actual.bytes)throw Error('Registered dynamics model resource changed: '+relative);
  }
  modelAssets.set(file,bytes);modelFiles.push({file,...actual});
}
const physics=model.physics?JSON.parse(modelAssets.get(model.physics).toString('utf8')):null;
const physicsGroups=(physics?.PhysicsSettings??[]).map(g=>g.Id);
const physicsOutputs=(physics?.PhysicsSettings??[]).flatMap(g=>(g.Output??[]).map(o=>o.Destination?.Id));
const broadcast=sourceRequest?.presentation?.profile==='studio-live-style-v2';
if(studioPreview||broadcast){
  const body=sourceRequest?.presentation?.body??['ParamBodyAngleX','ParamBodyAngleY','ParamBodyAngleZ'];
  playback=videoOnly?buildVideoOnlyPlayback(playback,fps,body,physicsOutputs,videoProfile):buildBroadcastPlayback(playback,fps,body,physicsOutputs);
  seconds=playback.at(-1).time;
}
if(sourceRequest){
  if(sourceRequest.kind!=='parameter_playback'||sourceRequest.fps!==fps||sourceRequest.frameCount!==playback.length||
    ['taskId','candidateId','revision','parentRevision','inputSha256','descriptionSha256'].some(k=>sourceRequest[k]!==artwork[k])||
    path.resolve(revisionRoot,sourceRequest.modelPath)!==entry||
    path.resolve(revisionRoot,sourceRequest.artworkManifestPath)!==path.resolve(args.artwork)||
    path.resolve(revisionRoot,sourceRequest.trajectoryPath)!==path.resolve(args.trajectory)||
    !physicsGroups.length||!physicsOutputs.length||new Set(physicsOutputs).size!==physicsOutputs.length||
    JSON.stringify(sourceRequest.physics?.groups)!==JSON.stringify(physicsGroups)||
    JSON.stringify(sourceRequest.physics?.outputs)!==JSON.stringify(physicsOutputs)||
    playback.some(f=>physicsOutputs.some(id=>Object.hasOwn(f.values,id))))throw Error('Packaging source request or actual physics mismatch');
  for(const source of sourceRequest.sources){
    const registered=modelStage.artifacts.find(a=>a.path===source.path);
    const actual=await digest(path.join(revisionRoot,source.path));
    if(!registered||registered.sha256!==source.sha256||registered.bytes!==source.bytes||
      actual.sha256!==source.sha256||actual.bytes!==source.bytes)throw Error('Packaging registered source changed: '+source.path);
  }
}
await fs.mkdir(output); // Never overwrite an earlier render.
const {files,hashes}=await readInstalledRenderer();
const require=createRequire(import.meta.url);
let playwright;try{playwright=require('playwright');}catch{playwright=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}
const launchRenderer=angle=>playwright.chromium.launch({
  executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,
  args:['--use-gl=angle','--use-angle='+angle,'--disable-background-networking',
    ...(angle==='swiftshader'?['--enable-unsafe-swiftshader']:[])]});
let browser,graphicsBackend='swiftshader';
if(!playback&&process.platform==='darwin'&&process.arch==='arm64'){
  let metal;
  try{
    metal=await launchRenderer('metal');
    const probe=await metal.newPage();
    const usable=await probe.evaluate(()=>{
      const gl=document.createElement('canvas').getContext('webgl2',{failIfMajorPerformanceCaveat:true});
      return Boolean(gl&&!gl.isContextLost());
    });
    await probe.close();
    if(usable){browser=metal;graphicsBackend='metal';}
  }catch(error){
    process.stderr.write('Metal startup unavailable: '+error.message+'\n');
  }finally{
    if(metal&&!browser)await metal.close();
  }
}
browser??=await launchRenderer('swiftshader');
let encoder,encoderError='',frameCount=0;
try{
  const context=await browser.newContext({viewport:{width:1920,height:1080},deviceScaleFactor:1,serviceWorkers:'block',permissions:[]});
  const origin='http://live2d-preview.invalid';
  await context.route('**/*',async route=>{
    const u=new URL(route.request().url());
    if(route.request().method()!=='GET'||u.origin!==origin)return route.abort();
    if(u.pathname==='/')return route.fulfill({contentType:'text/html',body:'<html><head><style>*{margin:0}#body,#face{width:1080px;height:1080px}</style></head><body><div id="body"></div><div id="face"></div></body></html>'});
    if(files.has(u.pathname))return route.fulfill({contentType:'text/javascript',body:files.get(u.pathname)});
    if(u.pathname.startsWith('/model-file/')){
      const f=decodeURIComponent(u.pathname.slice(12));
      if(modelAssets.has(f))return route.fulfill({contentType:'application/octet-stream',body:modelAssets.get(f)});
    }
    return route.abort();
  });
  encoder=spawn(ffmpeg,['-hide_banner','-nostdin','-v','error','-f','image2pipe','-framerate',String(fps),'-vcodec','png','-i','pipe:0',
    '-an','-c:v','libx264','-preset','medium','-crf','17','-pix_fmt','yuv420p','-movflags','+faststart',path.join(output,videoName)],{stdio:['pipe','ignore','pipe']});
  encoder.stderr.on('data',b=>{encoderError+=b;});
  const finished=once(encoder,'close');
  const page=await context.newPage();
  await page.exposeFunction('writeFrame',async(frame,index,kind)=>{
    const bytes=Buffer.from(frame,'base64');
    if(kind){await fs.writeFile(path.join(output,kind+'.png'),bytes);return;}
    if(!encoder.stdin.write(bytes))await once(encoder.stdin,'drain');
    frameCount++;
    if(index%90===0)process.stdout.write(JSON.stringify({rendered:index+1,total:playback?.length??Math.ceil(seconds*fps)})+'\n');
  });
  await page.goto(origin);
  const result=await page.evaluate(async({stagePath,info,face,canvas,seconds,fps,playback,physicsGroups,physicsOutputs,packaging,compareParent,studioPreview,videoOnly,presentation})=>{
    const phaseLabel=id=>({neutral:'默认','head-nine-directions':'小幅转头','turn-and-speak':'转头与说话',
      'expression:dyn_happy':'开心','expression:dyn_angry':'生气','cancel-motion-preserve-expression':'取消动作，保留表情',
      'expression:dyn_smile':'微笑','expression:dyn_surprise':'惊讶',
      'motion:dyn_idle':'自然呼吸','cancel:dyn_idle':'停止待机动作','motion:dyn_wave':'挥手','cancel:dyn_wave':'收回手臂',
      'appearance-on:dyn_appearance_chest_bow':'摘下胸结','appearance-off:dyn_appearance_chest_bow':'戴回胸结',
      'combined-controls:dyn_wave:dyn_appearance_chest_bow':'生气、挥手与摘结组合',
      'cancel-motion-preserve-appearance:dyn_appearance_chest_bow':'收回手臂，保留表情与摘结',
      'reset-expression-preserve-appearance:dyn_appearance_chest_bow':'恢复表情，保留摘结',
      'reset-appearance-preserve-tracking:dyn_appearance_chest_bow':'戴回胸结，继续头眼嘴动作',
      'restore-baseline':'恢复原样','physics-slow-turn':'缓慢转头','physics-fast-stop':'快速转头与停住',
      'physics-reverse':'反向转头','physics-settle':'停下后的自然回落'})[id]??id;
    window.__TAURI_INTERNALS__={async invoke(command,args){
      if(command!=='read_model_resource'||args.id!==info.id||!info.files.includes(args.resource))throw Error('Unapproved resource read');
      const response=await fetch('/model-file/'+encodeURIComponent(args.resource));
      if(!response.ok)throw Error('Missing model resource');return response.arrayBuffer();
    }};
    const {A:AvatarStage,r:readSettings}=await import(stagePath);
    const faceCx=(face.left+face.width/2)/canvas.width,faceCy=(face.top+face.height/2)/canvas.height;
    const faceZoom=Math.min(9,.68*canvas.height/(face.height*.92));
    const settings=readSettings(null);
    Object.assign(settings,{autoBlink:false,idleMotion:'',motionSound:false,outputAspect:'auto',x:0,y:0,zoom:1,supersample:false,
      physicsStrength:1,physicsWind:0,physicsFps:0,physicsGroups:{}});
    const stage=new AvatarStage(document.getElementById('body'),()=>{throw Error('Context lost');});
    stage.display(settings);if(!await stage.load(info))throw Error('Model failed to load');
    const defaults=Object.fromEntries(stage.parameters.map(p=>[p.id,p.default]));
    for(const id of ['ParamAngleX','ParamEyeLOpen','ParamEyeROpen','ParamMouthOpenY'])if(!(id in defaults))throw Error('Required model parameter missing: '+id);
    // A source-hand comparison can retire digits from a replaced palm.
    // Keep every shared control and record exactly which old tracks could not apply.
    const retiredDigitTracks=compareParent?Object.keys(playback[0].values)
      .filter(id=>/^ParamGreetingFinger[1-5]$/.test(id)&&!(id in defaults)):[];
    let nativeEvaluations=0;
    if(packaging){
      const physics=stage.model?.internalModel?.physics;
      if(!physics||typeof physics.evaluate!=='function'||JSON.stringify(stage.physicsGroups.map(g=>g.id))!==JSON.stringify(physicsGroups))
        throw Error('Installed Leaf did not load the indexed physics groups');
      const evaluate=physics.evaluate.bind(physics);
      physics.evaluate=(...args)=>{nativeEvaluations++;return evaluate(...args);};
    }
    // One live context supplies both the model draw and the encoded frame.
    // Concurrent Leaf stages have produced a frozen body despite moving parameter readback.
    const bodyCapture=document.createElement('canvas');bodyCapture.width=bodyCapture.height=920;
    const bc=bodyCapture.getContext('2d');
    const waveAmount=values=>Math.abs((values.ParamWave??defaults.ParamWave??0)-(defaults.ParamWave??0));
    const peakWave=(playback??[]).reduce((max,f)=>Math.max(max,waveAmount(f.values)),0);
    let checkedWaveFrames=0,wavePoseObserved=false,baselinePixels;
    const studio=packaging||studioPreview;
    const broadcastFraming=studioPreview||presentation?.profile==='studio-live-style-v2';
    let size=Math.max(1200,Math.min(1470,canvas.height/face.height*340));
    let restingBottom;
    let topOffset=presentation?Math.round(-16-size*.093):-16;
    if(presentation&&(!['articulated-greeting-v1','studio-live-style-v2'].includes(presentation.profile)||presentation.body.length!==3||
      presentation.body.some(id=>!(id in defaults)||physicsOutputs.includes(id))))
      throw Error('Articulated greeting presentation has unbound body axes');
    const delayed=['ParamAngleX','ParamAngleY','ParamAngleZ'].map(id=>defaults[id]??0);
    const out=document.createElement('canvas');out.width=1920;out.height=1080;const c=out.getContext('2d');
    const backdrop=c.createRadialGradient(970,400,120,960,580,1180);
    backdrop.addColorStop(0,'#607a84');backdrop.addColorStop(.55,'#354e5c');backdrop.addColorStop(1,'#192b3a');
    const frames=[],samples=new Set([0,Math.round(fps*2),Math.round(fps*4),Math.round(fps*6),Math.round(fps*8),Math.round(fps*10),...(studioPreview?[playback.length-1]:[])]);
    const physicsReadback=physicsOutputs.map(parameter=>({parameter,min:Infinity,max:-Infinity,samples:0}));
    const phaseFrames=[];
    if(playback)for(let i=1;i<playback.length;i++)if(playback[i].phase!==playback[i-1].phase){samples.add(i);samples.add(i-1);}
    const ease=x=>(1-Math.cos(Math.PI*Math.max(0,Math.min(1,x))))/2;
    for(let i=0;i<(playback?.length??Math.ceil(seconds*fps));i++){
      const t=i/fps,u=i/Math.max(1,Math.ceil(seconds*fps)-1);
      // A held frontal start, visible left/right turn, several complete blinks and speaking pauses.
      const yaw=u<.15?0:u<.35?-10*ease((u-.15)/.2):u<.65?-10+20*ease((u-.35)/.3):10*(1-ease((u-.65)/.35));
      const pulse=(center,width)=>Math.max(0,Math.min(1,(width-Math.abs(t-center))/(width*.75)));
      const eye=1-Math.max(pulse(seconds*.2,.16),pulse(seconds*.5,.18),pulse(seconds*.8,.16));
      const speaking=u>.26&&u<.82,mouth=speaking?.12+.72*Math.pow(Math.sin(t*Math.PI*2.3),2):0;
      // Complete dynamics uses the actual motion_sample keys in the registered capture.
      // Leave physics-owned outputs absent so Leaf calculates its real pendulums.
      const pose=playback?{...playback[i].values}:{...defaults,ParamAngleX:yaw,ParamAngleY:2*Math.sin(u*Math.PI*2),ParamEyeLOpen:eye,ParamEyeROpen:eye,ParamMouthOpenY:mouth};
      if(presentation?.profile==='articulated-greeting-v1'){
        // Follow with the exported body rig. Keep all registered hand keys and
        // head/physics inputs; lag the body so shoulders do not snap with the face.
        const direction=['ParamAngleX','ParamAngleY','ParamAngleZ'];
        for(let j=0;j<direction.length;j++)delayed[j]+=((pose[direction[j]]??0)-delayed[j])*(1-Math.exp(-1/(fps*.26)));
        const [x,y,z]=delayed;
        const support=[x*.24,y*.25,z*.29+x*.14];
        for(const [j,id] of presentation.body.entries())pose[id]=Math.max(-6,Math.min(6,pose[id]*.64+support[j]));
      }
      for(const id of retiredDigitTracks)delete pose[id];
      const absent=Object.keys(pose).filter(id=>!(id in defaults));
      if(absent.length)throw Error('Trajectory references absent model parameters: '+absent.join(', '));
      const beforePhysics=nativeEvaluations;
      c.fillStyle=studio?backdrop:'#e5e8ed';c.fillRect(0,0,1920,1080);
      // Read Leaf's transparent output directly. A composited WebGL canvas
      // can return a stale image even when the model parameters have advanced.
      settings.parameterOverrides=pose;stage.draw(pose,1000/fps);
      const actual=stage.frame;
      if(Object.entries(pose).some(([id,value])=>!Number.isFinite(actual[id])||Math.abs(actual[id]-value)>.03))throw Error('Model readback does not match preview trajectory');
      if(packaging){
        if(nativeEvaluations<=beforePhysics)throw Error('Native physics did not evaluate this trajectory frame');
        for(const output of physicsReadback){
          const value=actual[output.parameter];
          if(!Number.isFinite(value))throw Error('Actual physics output readback missing: '+output.parameter);
          output.min=Math.min(output.min,value);output.max=Math.max(output.max,value);output.samples++;
        }
        const phase=playback[i].phase;
        if(!i||phase!==playback[i-1].phase)phaseFrames.push({phase,first:i,last:i});else phaseFrames.at(-1).last=i;
      }
      const {width:bodyWidth,height:bodyHeight}=bodyCapture;
      const bodyPixels=stage.transparentPixels(bodyWidth,bodyHeight);
      if(!bodyPixels||bodyPixels.length!==bodyWidth*bodyHeight*4)throw Error('Leaf body output is unavailable');
      if(i===0){
        baselinePixels=new Uint8Array(bodyPixels);
        if(broadcastFraming){
          // Frame the visible model, including the hands at rest, using a
          // fixed camera. Source canvases have different transparent margins.
          let top=bodyHeight,bottom=0;
          for(let y=0;y<bodyHeight;y++){
            let count=0;
            for(let x=0;x<bodyWidth;x++)if(bodyPixels[(y*bodyWidth+x)*4+3]>80)count++;
            if(count>=5){top=Math.min(top,y);bottom=y;}
          }
          if(bottom<=top)throw Error('Broadcast framing has no visible model');
          // Keep the fixed camera above the source's flat hem and retain the
          // horizontal room of the entire native stage during the greeting.
          size=Math.min(1880,Math.round(1035*bodyHeight/(bottom-top)));
          topOffset=Math.round(61-top*size/bodyHeight);
          restingBottom=Math.round(topOffset+bottom*size/bodyHeight);
          if(restingBottom<1080)throw Error('Broadcast crop would expose the resting lower edge');
        }
      }
      if(!wavePoseObserved&&peakWave>.05&&waveAmount(pose)>=peakWave*.7){
        let changed=0;
        // Below the face, compare the pixels actually sent to the encoder.
        for(let y=Math.floor(bodyHeight*.42);y<bodyHeight&&!wavePoseObserved;y+=4)
          for(let x=0;x<bodyWidth;x+=4){
            const k=(y*bodyWidth+x)*4;
            if(Math.abs(bodyPixels[k+3]-baselinePixels[k+3])>20&&++changed>=24){wavePoseObserved=true;break;}
          }
      }
      bc.putImageData(new ImageData(new Uint8ClampedArray(bodyPixels),bodyWidth,bodyHeight),0,0);
      if(studio){
        c.drawImage(bodyCapture,(1920-size)/2,topOffset,size,size);
      }else c.drawImage(bodyCapture,500,80);
      if(broadcastFraming&&waveAmount(pose)>.05||playback&&/^(motion|cancel):dyn_wave$/.test(playback[i].phase)){
        for(let y=0;y<bodyHeight;y++){
          if(bodyPixels[(y*bodyWidth)*4+3]>20||bodyPixels[((y+1)*bodyWidth-1)*4+3]>20)
            throw Error('Wave body view clips at a horizontal edge: frame '+i);
        }
        checkedWaveFrames++;
      }
      if(!compareParent&&!studio){
        c.fillStyle='#29313f';c.font='26px sans-serif';c.fillText('Live2D · 参数动作回放（非真人）',35,42);c.font='20px sans-serif';
        c.fillText(playback?`${phaseLabel(playback[i].phase)}  ${playback[i].time.toFixed(2)}s`:`转头 ${yaw.toFixed(1)}°   眼睛 ${Math.round(eye*100)}%   口型 ${Math.round(mouth*100)}%`,35,1042);
      }
      if(samples.has(i)){
        await window.writeFrame(out.toDataURL('image/png').split(',')[1],i,'pose-'+String(i).padStart(4,'0'));
        frames.push({frame:i,time:playback?.[i].time??t,...(playback?{phase:playback[i].phase}:{}),parameters:{...actual}});
      }
      await window.writeFrame(out.toDataURL('image/png').split(',')[1],i,null);
    }
    if(peakWave>.05&&!wavePoseObserved)throw Error('Rendered body stayed frozen during the registered wave');
    const parameters=stage.parameters;
    stage.destroy();
    const writeStill=async(kind,host,view)=>{
      const stillStage=new AvatarStage(host,()=>{throw Error('Still context lost');});
      stillStage.display({...settings,...view,parameterOverrides:defaults});
      if(!await stillStage.load(info))throw Error('Still model failed to load');
      stillStage.draw(defaults,1000/fps);
      const png=host.querySelector('canvas').toDataURL('image/png').split(',')[1];
      stillStage.destroy();await window.writeFrame(png,0,kind);
    };
    const faceFit=Math.min(1080/canvas.width,1080/canvas.height)*.92*faceZoom;
    await writeStill('face',document.getElementById('face'),{zoom:faceZoom,
      x:(.5-faceCx)*canvas.width*faceFit/1080,y:(.5-faceCy)*canvas.height*faceFit/1080});
    const stillHost=document.createElement('div');Object.assign(stillHost.style,{width:'2160px',height:'3840px'});document.body.appendChild(stillHost);
    await writeStill('full-body',stillHost,{zoom:1,x:0,y:0});
    return {renderer:'VTubeLeaf 1.3.1 installed Cubism WebGL core',nativeTracking:'not_run',desktopModelChanged:false,
      width:1920,height:1080,fps,seconds:studioPreview?(playback.length-1)/fps:seconds,faceZoom,bodyZoom:1,bodyFraming:{
        checkedWaveFrames,wavePoseObserved,topOffset,...(broadcastFraming?{size,restingBottom}:{})},
      ...(presentation?{presentation}:{}),
      samples:frames,parameters,...(retiredDigitTracks.length?{retiredDigitTracks}:{}),
      ...(packaging?{kind:'parameter_playback',phaseFrames,physics:{groups:physicsGroups,outputs:physicsReadback,
        observedFrames:playback.length,nativeEvaluations,stepMs:1000/fps,parameterOverrides:false}}:{}),
      ...(studioPreview?{scope:videoOnly?'video-only expressive head, body and greeting replay from registered model controls; no package mutation':compareParent?'fresh rig export with broadcast staging and parent wave samples; diagnostic only, no native Dynamics export':
        'broadcast-style head and body replay with registered Dynamics wave samples; no camera input',presentation:videoOnly?'video-only-natural-v2':'studio-live-style-v2'}:playback?{scope:compareParent?'fresh rig export replaying the parent dynamics trajectory; not a dynamics export or packaging render':
        'registered full dynamics trajectory; native expression release and live tracking remain separate checks',phases:[...new Set(playback.map(f=>f.phase))]}:{})};
  },{stagePath,info:{id:'parameter-preview-'+artwork.candidateId,name:'Live2D parameter playback',path:name,entry:name,files:model.files},
    face:face.rect,canvas:artwork.canvas,seconds,fps,playback,physicsGroups,physicsOutputs,packaging:!!sourceRequest,compareParent,studioPreview,videoOnly,
    presentation:sourceRequest?.presentation??null});
  encoder.stdin.end();const [code]=await finished;if(code!==0)throw Error('ffmpeg failed: '+encoderError);
  const stills=await Promise.all(['pose-0000.png','full-body.png','face.png'].map(async file=>({file,...await digest(path.join(output,file))})));
  await fs.writeFile(path.join(output,'render-provenance.json'),JSON.stringify({schemaVersion:2,
    ...Object.fromEntries(['taskId','candidateId','revision','parentRevision','inputSha256','descriptionSha256'].map(k=>[k,artwork[k]])),
    artworkManifest:describe(artworkBytes),entry,modelFiles,engineAssets:hashes,frameCount,graphicsBackend,
    ...(sourceRequest?{request:describe(requestBytes),sourceRequest}:{}),
    ...(trajectory?{trajectory:describe(trajectoryBytes)}:{}),...result,encodedDuration:frameCount/fps,
    video:{file:videoName,...await digest(path.join(output,videoName))},stills,visualAcceptance:'pending',userAcceptance:'pending'},null,2)+'\n',{flag:'wx'});
  process.stdout.write(JSON.stringify({output,frameCount,...result,parameters:result.parameters.length})+'\n');
}finally{if(encoder&&!encoder.killed)encoder.kill();await browser.close();}
