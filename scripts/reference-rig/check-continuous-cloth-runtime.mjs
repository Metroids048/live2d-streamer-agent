// Check actual Cubism runtime geometry over every recorded motion frame.
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {createHash} from 'node:crypto';
import {readInstalledRenderer} from '../leaf-isolated-assets.mjs';
const [beforeEntry,afterEntry,recordPath,specPath,outPath]=process.argv.slice(2);
const installed=await readInstalledRenderer(),record=JSON.parse(await fs.readFile(recordPath));
const spec=JSON.parse(await fs.readFile(specPath));
const expected=new Set([...spec.hide,...spec.groups.flatMap(g=>[g.upper,...g.lowerTargets.map(t=>t.id)])]);
async function load(entry){
 const manifest=JSON.parse(await fs.readFile(entry)),dir=path.dirname(entry),bytes=await fs.readFile(path.join(dir,manifest.FileReferences.Moc));
 const ctx=vm.createContext({console:{log(){},warn(){},error(){}},setTimeout,clearTimeout,TextDecoder,TextEncoder,atob,btoa,WebAssembly,document:{currentScript:{src:''}},window:{},performance});
 vm.runInContext(installed.files.get('/runtime/live2dcubismcore.min.js').toString(),ctx);
 const core=ctx.Live2DCubismCore;let moc;
 for(let i=0;i<50&&!moc;i++){try{moc=core.Moc.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));}catch(e){if(i===49)throw e;await delay(50);}}
 return{moc,model:core.Model.fromMoc(moc),sha256:createHash('sha256').update(bytes).digest('hex')};
}
const a=await load(beforeEntry),b=await load(afterEntry),da=a.model.drawables,db=b.model.drawables;
const definitions=m=>Array.from(m.parameters.ids,(id,i)=>[id,m.parameters.minimumValues[i],m.parameters.maximumValues[i],m.parameters.defaultValues[i]]);
assert.deepEqual(definitions(a.model),definitions(b.model));
assert.equal(String(da.ids),String(db.ids));
for(let i=0;i<da.count;i++)if(!expected.has(da.ids[i]))for(const key of ['indices','vertexUvs','masks'])assert.equal(String(da[key][i]),String(db[key][i]),`${da.ids[i]} ${key}`);
const changes=new Map(),flips=[];let maxOutside=0,maxOpacityError=0,maxSeamError=0,maxStyleOpacityError=0,state={};
function area(v,t,k){const i=t[k]*2,j=t[k+1]*2,l=t[k+2]*2;return(v[j]-v[i])*(v[l+1]-v[i+1])-(v[j+1]-v[i+1])*(v[l]-v[i]);}
for(const frame of record.frames){
 Object.assign(state,frame.held,frame.parameters);
 for(const {model}of[a,b]){model.parameters.values.set(model.parameters.defaultValues);for(const[id,v]of Object.entries(state)){const i=model.parameters.ids.indexOf(id);if(i>=0)model.parameters.values[i]=v;}model.update();}
 for(const g of spec.groups){const u=db.vertexPositions[db.ids.indexOf(g.upper)];let opacity=0;for(const t of g.lowerTargets){const j=db.ids.indexOf(t.id),v=db.vertexPositions[j];opacity+=db.opacities[j];for(let k=360;k<378;k++)maxSeamError=Math.max(maxSeamError,Math.abs(u[k]-v[k])*b.model.canvasinfo.PixelsPerUnit);}maxStyleOpacityError=Math.max(maxStyleOpacityError,Math.abs(opacity-1));}
 for(let i=0;i<da.count;i++){
  const id=da.ids[i],av=da.vertexPositions[i],bv=db.vertexPositions[i];let e=0;
  if(!expected.has(id))maxOpacityError=Math.max(maxOpacityError,Math.abs(da.opacities[i]-db.opacities[i]));assert.equal(da.renderOrders[i],db.renderOrders[i],id+' order');
  for(let k=0;k<bv.length;k++)assert(Number.isFinite(bv[k]),id);
  for(let k=0;k<Math.min(av.length,bv.length);k++){assert(Number.isFinite(bv[k]),id);e=Math.max(e,Math.abs(av[k]-bv[k])*a.model.canvasinfo.PixelsPerUnit);}
  if(e>0)changes.set(id,Math.max(changes.get(id)||0,e));
  if(!expected.has(id))maxOutside=Math.max(maxOutside,e);
  if(expected.has(id)&&!spec.hide.includes(id)&&db.opacities[i]>.05){const t=db.indices[i];let positive=0,negative=0;for(let k=0;k<t.length;k+=3){const ar=area(bv,t,k);if(ar>1e-8)positive++;if(ar< -1e-8)negative++;}if(positive&&negative)flips.push({frame:frame.index,id,positive,negative});}
 }
}
const result={before:a.sha256,after:b.sha256,frames:record.frames.length,parameterDefinitionsEqual:true,unmodifiedMeshesTopologyUvsMasksEqual:true,maxSeamErrorCanvasPixels:maxSeamError,maxStyleOpacityError,maxOpacityError,orderEqual:true,changedMeshes:Object.fromEntries(changes),maxChangeOutsideSpecifiedMeshesCanvasPixels:maxOutside,additionalTriangleWindingChanges:flips,scope:'All recorded original-motion poses evaluated in actual Cubism Core; winding changes are diagnostics, not naturalness acceptance.'};
await fs.writeFile(outPath,JSON.stringify(result,null,2));
for(const x of[a,b]){x.model.release();x.moc._release();}
console.log(JSON.stringify({frames:result.frames,changedMeshes:result.changedMeshes,maxOutside,maxSeamError,maxStyleOpacityError,windingChangeFrames:flips.length}));
assert(maxOutside<.001,'Cloth repair changed another mesh');
assert(maxOpacityError<1e-6,'Opacity changed beyond interpolation roundoff');

assert(maxSeamError<.1,'Shared cloth seam separated');
assert(maxStyleOpacityError<.001,'Sleeve style opacity does not sum to one');
assert(flips.length===0,'Continuous cloth contains flipped triangles');
