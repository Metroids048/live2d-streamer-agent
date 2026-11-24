// Read-only, in-memory counts from the already installed verified Cubism Core.
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {setTimeout as delay} from 'node:timers/promises';
import {createHash} from 'node:crypto';
import {readInstalledRenderer} from './leaf-isolated-assets.mjs';
const [label,filename]=process.argv.slice(2);
const bytes=filename?await fs.readFile(filename):Buffer.concat(await Array.fromAsync(process.stdin));
const installed=await readInstalledRenderer();
const ctx=vm.createContext({console:{log(){},warn(){},error(){}},setTimeout,clearTimeout,TextDecoder,TextEncoder,atob,btoa,WebAssembly,document:{currentScript:{src:''}},window:{},performance});
vm.runInContext(installed.files.get('/runtime/live2dcubismcore.min.js').toString(),ctx);
const core=ctx.Live2DCubismCore;
let moc;
for(let i=0;i<50&&!moc;i++){
  try{moc=core.Moc.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));}
  catch(error){if(i===49)throw error;await delay(50);}
}
if(!moc)throw Error('MOC not initialized');
const model=core.Model.fromMoc(moc);model.update();
const d=model.drawables;
const sum=a=>Array.from(a||[]).reduce((n,v)=>n+v,0);
const vertices=Array.from(d.vertexCounts||d.vertexPositions.map(v=>v.length/2));
const result={label,mocBytes:bytes.length,mocSha256:createHash('sha256').update(bytes).digest('hex'),coreResourceSha256:installed.hashes['/runtime/live2dcubismcore.min.js'],coreVersion:core.Version.csmGetVersion(),parameters:model.parameters.count,parts:model.parts.count,drawables:d.count,totalMeshVertices:sum(vertices),totalMeshTriangles:sum(d.indexCounts||d.indices.map(v=>v.length))/3,minVerticesPerDrawable:Math.min(...vertices),maxVerticesPerDrawable:Math.max(...vertices),clippedDrawables:Array.from(d.masks||[]).filter(a=>a.length>0).length,mouthParameterIds:Array.from(model.parameters.ids).filter(s=>/mouth|tongue|cheek|^lip|^paramlip/i.test(s)),...(label==='Hachi-r10'?{parameterIds:Array.from(model.parameters.ids)}:{})};
result.parameterDefinitions=Array.from(model.parameters.ids,(id,i)=>({id,min:model.parameters.minimumValues[i],max:model.parameters.maximumValues[i],default:model.parameters.defaultValues[i]}));
result.canvas={width:model.canvasinfo.CanvasWidth,height:model.canvasinfo.CanvasHeight,ppu:model.canvasinfo.PixelsPerUnit};
result.meshes=Array.from(d.ids,(id,i)=>({id,texture:d.textureIndices[i],uv:Array.from(d.vertexUvs[i]),vertices:Array.from(d.vertexPositions[i]),indices:Array.from(d.indices[i]),masks:Array.from(d.masks[i]),opacity:d.opacities[i],order:d.renderOrders[i],renderOrder:d.renderOrders[i],drawOrder:d.drawOrders[i],multiplyColor:Array.from(d.multiplyColors.slice(i*4,i*4+4)),screenColor:Array.from(d.screenColors.slice(i*4,i*4+4))}));
result.canvasInfo={CanvasWidth:model.canvasinfo.CanvasWidth,CanvasHeight:model.canvasinfo.CanvasHeight,PixelsPerUnit:model.canvasinfo.PixelsPerUnit};
result.frames=[{name:'reset',parameters:Object.fromEntries(Array.from(model.parameters.ids,(id,i)=>[id,model.parameters.values[i]]))}];
result.scope='Core evaluation at model defaults. Neutral geometry for layer projection; no WebGL, motion or visual acceptance.';
model.release();moc._release();
process.stdout.write(JSON.stringify(result)+'\n');
