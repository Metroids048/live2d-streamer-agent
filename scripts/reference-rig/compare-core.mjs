import fs from 'node:fs/promises';
import vm from 'node:vm';
import {setTimeout as delay} from 'node:timers/promises';
import {createHash} from 'node:crypto';
import {readInstalledRenderer} from '../leaf-isolated-assets.mjs';
const [aPath,bPath,posesPath,outPath,adaptationPath]=process.argv.slice(2);
const adapted=new Set(adaptationPath?JSON.parse(await fs.readFile(adaptationPath,'utf8')).layers.map(l=>l.target):[]);
const installed=await readInstalledRenderer();
function makeCore(){const ctx=vm.createContext({console:{log(){},warn(){},error(){}},setTimeout,clearTimeout,TextDecoder,TextEncoder,atob,btoa,WebAssembly,document:{currentScript:{src:''}},window:{},performance});
vm.runInContext(installed.files.get('/runtime/live2dcubismcore.min.js').toString(),ctx);
return ctx.Live2DCubismCore;}
async function load(p){const core=makeCore();const b=await fs.readFile(p);let moc;for(let i=0;i<50&&!moc;i++){try{moc=core.Moc.fromArrayBuffer(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));}catch(e){if(i===49)throw e;await delay(50);}}if(!moc)throw Error('MOC load failed');return{moc,model:core.Model.fromMoc(moc),sha256:createHash('sha256').update(b).digest('hex')};}
const a=await load(aPath),b=await load(bPath),poses=JSON.parse(await fs.readFile(posesPath,'utf8'));
const meshIndex=new Map(Array.from(b.model.drawables.ids,(id,i)=>[id,i]));
const parameters=m=>Array.from(m.parameters.ids,(id,i)=>({id,min:m.parameters.minimumValues[i],max:m.parameters.maximumValues[i],default:m.parameters.defaultValues[i]})).sort((x,y)=>x.id.localeCompare(y.id));
const report={a:a.sha256,b:b.sha256,parametersEqual:JSON.stringify(parameters(a.model))===JSON.stringify(parameters(b.model)),adaptedMeshIds:[...adapted],frames:[],scope:'Core geometry at explicit parameter samples. Adapted meshes are explicitly excluded from unchanged-geometry tolerance; no physics, motion controller or texture rendering verification.'};
for(const [name,pose] of poses){
 for(const {model}of[a,b]){model.parameters.values.set(model.parameters.defaultValues);for(const[id,v]of Object.entries(pose)){const i=model.parameters.ids.indexOf(id);if(i>=0)model.parameters.values[i]=v;}model.update();}
 let maxPositionError=0,maxOpacityError=0,topologyDifferences=0,maskDifferences=0,orderDifferences=0,worstMesh=null,adaptedMeshes=[];
 const da=a.model.drawables,db=b.model.drawables;
 for(let i=0;i<da.count;i++){const j=meshIndex.get(da.ids[i]);if(j===undefined)throw Error('Missing '+da.ids[i]);
  const av=da.vertexPositions[i],bv=db.vertexPositions[j];if(av.length!==bv.length||String(da.indices[i])!==String(db.indices[j]))topologyDifferences++;
  if(!Array.from(bv).every(Number.isFinite))throw Error('Non-finite geometry '+da.ids[i]);
  if(adapted.has(da.ids[i])){if(av.length!==bv.length||String(da.indices[i])!==String(db.indices[j]))topologyDifferences--;adaptedMeshes.push({id:da.ids[i],vertices:bv.length/2,opacity:db.opacities[j],masks:Array.from(db.masks[j],k=>db.ids[k])});continue;}
  const ma=Array.from(da.masks[i],k=>da.ids[k]).sort(),mb=Array.from(db.masks[j],k=>db.ids[k]).sort();if(String(ma)!==String(mb))maskDifferences++;
  if(av.length===bv.length)for(let k=0;k<av.length;k++){const e=Math.abs(av[k]-bv[k]);if(e>maxPositionError){maxPositionError=e;worstMesh=da.ids[i];}}
  maxOpacityError=Math.max(maxOpacityError,Math.abs(da.opacities[i]-db.opacities[j]));if(da.renderOrders[i]!==db.renderOrders[j])orderDifferences++;
 }
 report.frames.push({name,maxPositionError,maxPositionErrorCanvasPixels:maxPositionError*a.model.canvasinfo.PixelsPerUnit,maxOpacityError,topologyDifferences,maskDifferences,orderDifferences,worstMesh,adaptedMeshes});
}
report.withinTolerance=report.parametersEqual&&report.frames.every(f=>f.maxPositionErrorCanvasPixels<.1&&f.maxOpacityError<1e-4&&!f.topologyDifferences&&!f.maskDifferences&&!f.orderDifferences);
await fs.writeFile(outPath,JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
for(const x of[a,b]){x.model.release();x.moc._release();}
