// Actual exported MOC keyframes, isolated installed Leaf core; no desktop control.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {readInstalledRenderer,stagePath} from './leaf-isolated-assets.mjs';
import {inspectModel} from '../src/packaging/model.mjs';
import {digest} from '../src/packaging/files.mjs';
const [modelPath,manifestPath,outputPath,posesPath,seamsPath,view='face']=process.argv.slice(2);
const requestedPoses=posesPath?JSON.parse(await fs.readFile(posesPath,'utf8')):null;
const seamSamples=seamsPath?JSON.parse(await fs.readFile(seamsPath,'utf8')):[];
const entry=await fs.realpath(modelPath),dir=path.dirname(entry),name=path.basename(entry),output=path.resolve(outputPath);
const model=await inspectModel(dir,name),artwork=JSON.parse(await fs.readFile(manifestPath,'utf8'));
const face=artwork.parts.find(p=>p.tags?.includes('face')).rect;
const {files,hashes}=await readInstalledRenderer(),require=createRequire(import.meta.url);
let playwright;try{playwright=require('playwright');}catch{playwright=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}
await fs.mkdir(output);
const browser=await playwright.chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,
 args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-background-networking']});
try{
 const context=await browser.newContext({viewport:{width:1080,height:1080},deviceScaleFactor:1,serviceWorkers:'block',permissions:[]});
 const origin='http://hachi-g1-keyframes.invalid';
 await context.route('**/*',async route=>{
  const u=new URL(route.request().url());if(route.request().method()!=='GET'||u.origin!==origin)return route.abort();
  if(u.pathname==='/')return route.fulfill({contentType:'text/html',body:'<style>*{margin:0}#stage{width:1080px;height:1080px}</style><div id="stage"></div>'});
  if(files.has(u.pathname))return route.fulfill({contentType:'text/javascript',body:files.get(u.pathname)});
  if(u.pathname.startsWith('/model-file/')){const f=decodeURIComponent(u.pathname.slice(12));if(model.files.includes(f))return route.fulfill({body:await fs.readFile(path.join(dir,f))});}
  return route.abort();
 });
 const page=await context.newPage();
 await page.goto(origin);
 const result=await page.evaluate(async({stagePath,info,face,canvas,requestedPoses,seamSamples,view})=>{
  window.__TAURI_INTERNALS__={async invoke(command,args){if(command!=='read_model_resource'||args.id!==info.id||!info.files.includes(args.resource))throw Error('Unapproved read');return(await fetch('/model-file/'+encodeURIComponent(args.resource))).arrayBuffer();}};
  const {A:AvatarStage,r:readSettings}=await import(stagePath),stage=new AvatarStage(document.getElementById('stage'),()=>{throw Error('Context lost');});
  const settings=readSettings(null),zoom=Math.min(9,.68*canvas.height/(face.height*.92));
  const fit=Math.min(1080/canvas.width,1080/canvas.height)*.92*zoom;
  Object.assign(settings,{autoBlink:false,idleMotion:'',motionSound:false,outputAspect:'auto',x:(canvas.width/2-face.left-face.width/2)*fit/1080,
    y:(canvas.height/2-face.top-face.height/2)*fit/1080,zoom,supersample:false});stage.display(settings);
  if(view==='body'){Object.assign(settings,{x:0,y:0,zoom:1});stage.display(settings);}
  if(!await stage.load(info))throw Error('MOC load failed');
  const defaults=Object.fromEntries(stage.parameters.map(p=>[p.id,p.default]));let core=stage.model.internalModel.coreModel.getModel(),raw=core.drawables;
  const poses=requestedPoses??[['front',{}],['closed',{ParamEyeLOpen:0,ParamEyeROpen:0}],['mouth-open',{ParamMouthOpenY:.8}],
    ['left',{ParamAngleX:-10}],['right',{ParamAngleX:10}],['blink-talk',{ParamEyeLOpen:.5,ParamEyeROpen:.5,ParamMouthOpenY:.65}]];
  // Capture each consecutive pose before yielding the WebGL task. An awaited
  // host callback between draws lets the browser discard the backing buffer.
  const frames=[],images=[];
  // Interpolate the actual MOC triangles at the same source position on adjacent
  // layers. A shared parameter name alone does not prove their motion coincides.
  const at=sample=>{
    const i=raw.ids.indexOf(sample.id);if(i<0)throw Error('Unknown seam mesh '+sample.id);
    const uv=raw.vertexUvs[i],v=raw.vertexPositions[i],ix=raw.indices[i],[x,y]=sample.uv;
    for(let k=0;k<ix.length;k+=3){const a=ix[k]*2,b=ix[k+1]*2,c=ix[k+2]*2;
      const det=(uv[b+1]-uv[c+1])*(uv[a]-uv[c])+(uv[c]-uv[b])*(uv[a+1]-uv[c+1]);if(Math.abs(det)<1e-14)continue;
      const p=((uv[b+1]-uv[c+1])*(x-uv[c])+(uv[c]-uv[b])*(y-uv[c+1]))/det;
      const q=((uv[c+1]-uv[a+1])*(x-uv[c])+(uv[a]-uv[c])*(y-uv[c+1]))/det,r=1-p-q;
      if(Math.min(p,q,r)>=-1e-5)return {...sample,x:p*v[a]+q*v[b]+r*v[c],y:p*v[a+1]+q*v[b+1]+r*v[c+1]};
    }return {...sample,outsideMesh:true};
  };
  for(const [name,pose]of poses){
    // Keep the same model and allow native asynchronous work between frames.
    settings.parameterOverrides={...defaults,...pose};
    for(let frame=0;frame<90;frame++){
      stage.draw(settings.parameterOverrides,16.6667);
      if(frame<89)await new Promise(requestAnimationFrame);
    }
    for(const [id,value]of Object.entries(pose))if(Math.abs(stage.frame[id]-value)>.025)throw Error('Readback mismatch '+id);
    images.push({name,png:document.querySelector('canvas').toDataURL('image/png').split(',')[1]});
    frames.push({name,parameters:{...stage.frame},seamSamples:seamSamples.map(at),drawableCentroids:raw.ids.map((id,i)=>{const v=raw.vertexPositions[i];let x=0,y=0;for(let j=0;j<v.length;j+=2){x+=v[j];y+=v[j+1];}return{id,x:x/(v.length/2),y:y/(v.length/2),opacity:raw.opacities[i],bounds:(()=>{let l=Infinity,t=Infinity,r=-Infinity,b=-Infinity;for(let k=0;k<v.length;k+=2){l=Math.min(l,v[k]);t=Math.min(t,v[k+1]);r=Math.max(r,v[k]);b=Math.max(b,v[k+1]);}return[l,t,r,b];})()};})});
  }
  const bounds=v=>{let l=Infinity,t=Infinity,r=-Infinity,b=-Infinity;for(let j=0;j<v.length;j+=2){l=Math.min(l,v[j]);t=Math.min(t,v[j+1]);r=Math.max(r,v[j]);b=Math.max(b,v[j+1]);}return[l,t,r,b];};
  return {images,frames,canvasInfo:core.canvasinfo?{CanvasWidth:core.canvasinfo.CanvasWidth,CanvasHeight:core.canvasinfo.CanvasHeight,PixelsPerUnit:core.canvasinfo.PixelsPerUnit}:null,
    uvBounds:raw.ids.map((id,i)=>({id,texture:raw.textureIndices[i],uvBounds:bounds(raw.vertexUvs[i])})),
    scope:'Actual exported MOC keyframes, one continuous stage with 90 requestAnimationFrame ticks per pose, with installed Leaf core; no continuous dynamics, desktop, tracking, native publication or user acceptance.'};
 },{stagePath,info:{id:'hachi-g1-keyframes',name:'Hachi G1 keyframes',path:name,entry:name,files:model.files},face,canvas:artwork.canvas,requestedPoses,seamSamples,view});
 for(const {name,png} of result.images)await fs.writeFile(path.join(output,name+'.png'),Buffer.from(png,'base64'));delete result.images;
 await fs.writeFile(path.join(output,'provenance.json'),JSON.stringify({entry,view,modelFiles:await Promise.all(model.files.map(async file=>({file,...await digest(path.join(dir,file))}))),engineAssets:hashes,...result},null,2)+'\n');
 console.log(JSON.stringify({output,frames:result.frames.map(f=>f.name)}));
}finally{await browser.close();}
