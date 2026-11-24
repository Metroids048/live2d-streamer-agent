// Isolated installed Leaf controller. Never touches desktop models or camera.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {readInstalledRenderer,stagePath} from './leaf-isolated-assets.mjs';
const [modelPath,outPath,saveFrames='false',showcase='false',continuity='false',viewPath]=process.argv.slice(2);
const framing=viewPath?JSON.parse(await fs.readFile(viewPath,'utf8')):null;
const entry=await fs.realpath(modelPath),dir=path.dirname(entry),output=path.resolve(outPath);
const resources=(await fs.readdir(dir,{recursive:true})).filter(f=>/\.(json|moc3|png)$/.test(f));
const motions=[];
for(const file of resources.filter(f=>f.endsWith('.motion3.json'))){const data=JSON.parse(await fs.readFile(path.join(dir,file)));motions.push({file,name:path.basename(file),duration:data.Meta.Duration});}
const expressions=resources.filter(f=>f.endsWith('.exp3.json')).map(file=>({file,name:path.basename(file)}));
const vt=JSON.parse(await fs.readFile(path.join(dir,'大肥鱼.vtube.json')));
const sequence=[];
for(const match of ['默认手切举手','举手切默认手','竖手指切出来','竖手指切回默认','狗尾草切换出来','狗尾草切回默认手']){
 const motion=motions.find(m=>m.name.startsWith(match));if(!motion)throw Error('Missing '+match);
 const hotkey=vt.Hotkeys.find(h=>h.File?.replaceAll('\\','/').endsWith(motion.name));if(!hotkey)throw Error('Missing hotkey '+motion.name);
 sequence.push({...motion,id:'vts:'+motion.file,mode:hotkey.StopsOnLastFrame?'hold':'once',fade:hotkey.FadeSecondsAmount,label:hotkey.Name,seconds:motion.duration+1});
}
const require=createRequire(import.meta.url);let playwright;try{playwright=require('playwright');}catch{playwright=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}
const {files,hashes}=await readInstalledRenderer();await fs.mkdir(output);if(saveFrames==='true')await fs.mkdir(path.join(output,'frames'));
const browser=await playwright.chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-background-networking']});
try{
 const context=await browser.newContext({viewport:{width:1080,height:1080},deviceScaleFactor:1,serviceWorkers:'block',permissions:[]});
 const origin='http://reference-motions.invalid';
 await context.route('**/*',async route=>{const u=new URL(route.request().url());if(route.request().method()!=='GET'||u.origin!==origin)return route.abort();
  if(u.pathname==='/')return route.fulfill({contentType:'text/html',body:'<style>*{margin:0}#stage{width:1080px;height:1080px}</style><div id="stage"></div>'});
  if(files.has(u.pathname))return route.fulfill({contentType:'text/javascript',body:files.get(u.pathname)});
  if(u.pathname.startsWith('/model-file/')){const f=decodeURIComponent(u.pathname.slice(12));if(resources.includes(f))return route.fulfill({body:await fs.readFile(path.join(dir,f))});}return route.abort();
 });
 const page=await context.newPage();await page.exposeFunction('saveFrame',async(index,png,label)=>{if(saveFrames==='true')await fs.writeFile(path.join(output,'frames',String(index).padStart(5,'0')+'.png'),Buffer.from(png,'base64'));if(label)await fs.writeFile(path.join(output,label+'.png'),Buffer.from(png,'base64'));});
 await page.goto(origin);
 const report=await page.evaluate(async({stagePath,info,sequence,showcase,continuity,framing})=>{
  window.__TAURI_INTERNALS__={async invoke(command,args){if(command!=='read_model_resource'||args.id!==info.id||!info.files.includes(args.resource))throw Error('Unapproved read');return(await fetch('/model-file/'+encodeURIComponent(args.resource))).arrayBuffer();}};
  const {A:AvatarStage,r:readSettings}=await import(stagePath),stage=new AvatarStage(document.getElementById('stage'),()=>{throw Error('Context lost');});
  const settings=readSettings(null);Object.assign(settings,{autoBlink:false,idleMotion:'',motionSound:false,outputAspect:'auto',x:0,y:0,zoom:1,supersample:false,parameterOverrides:{}});
  if(framing){
   const {canvas,rect}=framing,zoom=Math.min(9,.68*canvas.height/(rect.height*.92));
   const fit=Math.min(1080/canvas.width,1080/canvas.height)*.92*zoom;
   Object.assign(settings,{zoom,x:(canvas.width/2-rect.left-rect.width/2)*fit/1080,y:(canvas.height/2-rect.top-rect.height/2)*fit/1080});
  }
  for(const step of sequence)settings.hotkeyOptions['motion:'+step.id]={fadeSeconds:step.fade};stage.display(settings);
  if(!await stage.load(info))throw Error('MOC load failed');
  // Leaf resets every parameter before each motion update. On a held -> return
  // transition this discards the held pose and fades the return from neutral.
  // Restore the previous evaluated values before Cubism applies its authored
  // curves/fades, as its usual saved-parameter playback does. No curve edits.
  if(continuity)stage.model.internalModel.on('beforeMotionUpdate',()=>{
   for(const id of stage.playing?.ids??[]){
    const value=stage.frame[id];
    if(Number.isFinite(value))stage.model.internalModel.coreModel.setParameterValueById(id,value);
   }
  });
  const frames=[],ends=[];let index=0;
  for(let i=0;i<60;i++)stage.draw({},1000/30);
  for(const step of sequence){
   const motion=stage.motions.find(m=>m.id===step.id);if(!motion)throw Error('Controller did not register '+step.id);
   const ids=motion.data.Curves.filter(c=>c.Target==='Parameter').map(c=>c.Id);
   stage.playMotion(step.id,step.mode);
   const count=Math.ceil(step.seconds*30);
   for(let f=0;f<count;f++){
    stage.draw({},1000/30);
    frames.push({index,step:step.label,t:f/30,parameters:Object.fromEntries(ids.map(id=>[id,stage.frame[id]])),held:{...stage.held},playing:stage.currentMotion??null});
    const label=f===count-1?step.label:null;
    const png=stage.canvas.toDataURL('image/png').split(',')[1];
    await window.saveFrame(index++,png,label);
    await new Promise(requestAnimationFrame);
   }
   ends.push({label:step.label,mode:step.mode,held:{...stage.held},playing:stage.currentMotion??null});
  }
  const facialFrames=[];
  if(showcase){
   const defaults=Object.fromEntries(stage.parameters.map(p=>[p.id,p.default]));
   const blush=stage.expressions.find(e=>e.name?.includes('脸红'));
   for(let f=0;f<420;f++){
    const t=f/30,zoomIn=Math.min(1,t/2),zoomOut=Math.min(1,(14-t)/2),focus=Math.min(zoomIn,zoomOut);
    settings.zoom=1+1.4*focus;settings.y=.54*focus;stage.display(settings);
    const active=t>2&&t<12,phase=active?(t-2)/10:0;
    const blink=active&&((t>4.2&&t<4.5)||(t>8.1&&t<8.4))?0:1;
    const pose={...defaults,ParamAngleX:active?24*Math.sin(phase*2*Math.PI):0,ParamAngleY:active?10*Math.sin(phase*4*Math.PI):0,
      ParamEyeLOpen:blink,ParamEyeROpen:blink,ParamMouthOpenY:active&&t<10?Math.max(0,Math.sin(t*7))*.75:0};
    if(blush&&f===180)stage.setExpression(blush.id,true,undefined,.2);
    if(blush&&f===270)stage.setExpression(blush.id,false,undefined,.2);
    // Facial samples deliberately exercise the live MOC, after the original
    // motion comparison. They are not represented as camera tracking.
    settings.parameterOverrides=pose;stage.draw(pose,1000/30);
    facialFrames.push({index,t,parameters:Object.fromEntries(['ParamAngleX','ParamAngleY','ParamEyeLOpen','ParamEyeROpen','ParamMouthOpenY'].map(id=>[id,stage.frame[id]]))});
    await window.saveFrame(index++,stage.canvas.toDataURL('image/png').split(',')[1],f===419?'showcase-reset':null);
    await new Promise(requestAnimationFrame);
   }
  }
  return{frames,ends,facialFrames,registeredMotions:stage.motions.length,registeredExpressions:stage.expressions.length};
 },{stagePath,info:{id:'reference-motion-probe',name:'Isolated reference motion probe',path:path.basename(entry),entry:path.basename(entry),files:resources,vtsResources:{motions,expressions}},sequence,showcase:showcase==='true',continuity:continuity==='true',framing});
 const hashesOfInputs=[];for(const f of resources){const b=await fs.readFile(path.join(dir,f));hashesOfInputs.push({file:f,sha256:createHash('sha256').update(b).digest('hex')});}
 await fs.writeFile(path.join(output,'motion-probe.json'),JSON.stringify({entry,sequence,framing,engineAssets:hashes,inputs:hashesOfInputs,continuityAdapter:continuity==='true',...report,scope:'Installed Leaf controller with explicitly recorded optional saved-parameter continuity adapter; original motion files and hold/fade configuration, fixed 30fps offline playback. No native hotkey UI, camera, VTS executable or user acceptance.'},null,2));
 console.log(JSON.stringify({output,frames:report.frames.length,ends:report.ends}));
}finally{await browser.close();}
