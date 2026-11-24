// Read the exported MOC with the installed Cubism Core; no desktop or camera.
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {setTimeout as delay} from 'node:timers/promises';
import {readInstalledRenderer} from './leaf-isolated-assets.mjs';
import {inspectModel} from '../src/packaging/model.mjs';
import {digest} from '../src/packaging/files.mjs';

const [modelPath,outputPath,extraCasesPath]=process.argv.slice(2);
if(!modelPath?.endsWith('.model3.json')||!outputPath)throw Error('Use MODEL.model3.json NEW_REPORT.json');
const entry=await fs.realpath(modelPath),dir=path.dirname(entry),info=await inspectModel(dir,path.basename(entry));
const refs=JSON.parse(await fs.readFile(entry)).FileReferences,{files,hashes}=await readInstalledRenderer();
const context=vm.createContext({console:{log(){},warn(){},error(){}},setTimeout,clearTimeout,TextDecoder,TextEncoder,atob,btoa,WebAssembly,document:{currentScript:{src:''}},window:{},performance});
vm.runInContext(files.get('/runtime/live2dcubismcore.min.js').toString(),context);
const bytes=await fs.readFile(path.join(dir,refs.Moc));let moc;
for(let i=0;i<50&&!moc;i++){try{moc=context.Live2DCubismCore.Moc.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));}catch(error){if(i===49)throw error;await delay(50);}}
const model=context.Live2DCubismCore.Model.fromMoc(moc),parameters=model.parameters,raw=model.drawables;
const defaults=Array.from(parameters.defaultValues),index=new Map(parameters.ids.map((id,i)=>[id,i]));
function pose(values){parameters.values.set(defaults);for(const [id,value]of Object.entries(values)){if(!index.has(id))throw Error('Missing parameter '+id);const i=index.get(id);if(!Number.isFinite(value)||value<parameters.minimumValues[i]||value>parameters.maximumValues[i])throw Error('Out-of-range parameter '+id+': '+value);parameters.values[i]=value;}model.update();}
pose({});const rest=raw.vertexPositions.map(v=>Array.from(v));
const area=(v,a,b,c)=>(v[b*2]-v[a*2])*(v[c*2+1]-v[a*2+1])-(v[b*2+1]-v[a*2+1])*(v[c*2]-v[a*2]);
const baseline=raw.indices.map((ix,i)=>Array.from({length:ix.length/3},(_,k)=>area(rest[i],ix[k*3],ix[k*3+1],ix[k*3+2])));
const cases=[];
for(const x of [-15,-10,-5,0,5,10,15])for(const y of [-10,-5,0,5,10])for(const eye of [0,.25,.5,.75,1])for(const mouth of [0,.25,.5,.75,1])
  cases.push({name:`face:${x}:${y}:${eye}:${mouth}`,values:{ParamAngleX:x,ParamAngleY:y,ParamEyeLOpen:eye,ParamEyeROpen:eye,ParamMouthOpenY:mouth}});
if(index.has('ParamWave'))for(const wave of [0,.25,.5,.75,1])for(const lift of [0,.25,.5,.75,1])for(const wrist of [-1,-.5,0,.5,1])
  cases.push({name:`wave:${wave}:${lift}:${wrist}`,values:{ParamWave:wave,ParamWaveLift:lift,ParamWaveWrist:wrist}});
if(extraCasesPath){const extra=JSON.parse(await fs.readFile(extraCasesPath,'utf8'));if(!Array.isArray(extra)||extra.some(p=>!Array.isArray(p)||typeof p[0]!=='string'||!p[1]||Object.values(p[1]).some(v=>!Number.isFinite(v))))throw Error('Invalid additional MOC cases');for(const [name,values] of extra)cases.push({name,values});}
const failures=[],minByLayer=raw.ids.map(id=>({id,minAreaRatio:Infinity,pose:null}));let visibleTriangles=0;
for(const sample of cases){
  pose(sample.values);
  for(let i=0;i<raw.ids.length;i++){
    if(raw.opacities[i]<=.001)continue;
    const v=raw.vertexPositions[i],ix=raw.indices[i];
    for(let k=0;k<ix.length;k+=3){
      const a=area(v,ix[k],ix[k+1],ix[k+2]),base=baseline[i][k/3],ratio=a/base;visibleTriangles++;
      if(!Number.isFinite(ratio)||ratio<=1e-5){if(failures.length<100)failures.push({pose:sample.name,id:raw.ids[i],triangle:k/3,area:a,base,ratio});}
      if(ratio<minByLayer[i].minAreaRatio)Object.assign(minByLayer[i],{minAreaRatio:ratio,pose:sample.name});
    }
  }
}
pose({});let resetMax=0;
for(let i=0;i<rest.length;i++)for(let j=0;j<rest[i].length;j++)resetMax=Math.max(resetMax,Math.abs(raw.vertexPositions[i][j]-rest[i][j]));
const report={entry,scope:extraCasesPath?'Actual MOC key/intermediate and explicitly supplied physics-output parameter samples. Geometry only; excludes dynamic simulation, tracking and visual acceptance.':'Actual MOC key and intermediate parameter samples. Geometry only; excludes physics, tracking and visual acceptance.',
 additionalCases:extraCasesPath?{path:path.resolve(extraCasesPath),...await digest(extraCasesPath)}:null,
 modelFiles:await Promise.all(info.files.map(async file=>({file,...await digest(path.join(dir,file))}))),engineAssets:hashes,
 cases:cases.length,visibleTriangles,resetMax,minByLayer,failures,passed:failures.length===0&&resetMax===0};
await fs.writeFile(outputPath,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({outputPath,cases:cases.length,resetMax,failures:failures.length,passed:report.passed}));
if(!report.passed)process.exitCode=1;
