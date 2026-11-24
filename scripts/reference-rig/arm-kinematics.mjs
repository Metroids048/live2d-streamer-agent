import fs from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {readInstalledRenderer} from '../leaf-isolated-assets.mjs';
const [entry,record,out]=process.argv.slice(2),manifest=JSON.parse(await fs.readFile(entry)),installed=await readInstalledRenderer();
const ctx=vm.createContext({console:{log(){},warn(){},error(){}},setTimeout,clearTimeout,TextDecoder,TextEncoder,atob,btoa,WebAssembly,document:{currentScript:{src:''}},window:{},performance});
vm.runInContext(installed.files.get('/runtime/live2dcubismcore.min.js').toString(),ctx);
const core=ctx.Live2DCubismCore,b=await fs.readFile(path.join(path.dirname(entry),manifest.FileReferences.Moc));let moc;
for(let i=0;i<50&&!moc;i++){try{moc=core.Moc.fromArrayBuffer(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength))}catch{await delay(50)}}
const model=core.Model.fromMoc(moc),d=model.drawables,info=model.canvasinfo;model.update();
const ids=['ArtMesh209','ArtMesh247','ArtMesh343','ArtMesh597','ArtMesh684','ArtMesh625','ArtMesh699'];
const landmarks=ids.map(id=>{const i=d.ids.indexOf(id),v=d.vertexPositions[i],ys=Array.from(v).filter((_,k)=>k%2),lo=Math.min(...ys),hi=Math.max(...ys);return{id,i,top:ys.map((y,k)=>y>hi-(hi-lo)*.12?k:-1).filter(k=>k>=0),bottom:ys.map((y,k)=>y<lo+(hi-lo)*.12?k:-1).filter(k=>k>=0)}});
const point=(v,indices)=>[indices.reduce((s,k)=>s+v[k*2],0)/indices.length*info.PixelsPerUnit+info.CanvasOriginX,info.CanvasOriginY-indices.reduce((s,k)=>s+v[k*2+1],0)/indices.length*info.PixelsPerUnit];
const source=JSON.parse(await fs.readFile(record)),frames=[];let state=Object.fromEntries(Array.from(model.parameters.ids,(id,i)=>[id,model.parameters.defaultValues[i]]));
for(const f of source.frames){Object.assign(state,f.held,f.parameters);model.parameters.values.set(model.parameters.defaultValues);for(const[id,v]of Object.entries(state)){const i=model.parameters.ids.indexOf(id);if(i>=0)model.parameters.values[i]=v}model.update();frames.push({index:f.index,step:f.step,meshes:landmarks.map(l=>{const v=d.vertexPositions[l.i],top=point(v,l.top),bottom=point(v,l.bottom);return{id:l.id,opacity:d.opacities[l.i],top,bottom,angle:Math.atan2(bottom[1]-top[1],bottom[0]-top[0])*180/Math.PI,length:Math.hypot(bottom[0]-top[0],bottom[1]-top[1])}})});}
await fs.writeFile(out,JSON.stringify({entry,record,landmarks,frames},null,2));model.release();moc._release();
console.log(JSON.stringify({out,frames:frames.length}));
