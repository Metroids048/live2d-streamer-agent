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

const x=await load(aPath),m=x.model,d=m.drawables,poses=JSON.parse(await fs.readFile(posesPath,'utf8'));const get=id=>d.vertexPositions[d.ids.indexOf(id)];
function center(v,ix){return ix.reduce((a,i)=>[a[0]+v[2*i]/ix.length,a[1]+v[2*i+1]/ix.length],[0,0])}
function band(v,top,f){let ys=Array.from(v).filter((v,i)=>i%2),lo=Math.min(...ys),hi=Math.max(...ys);return ys.flatMap((v,i)=>(top?v>hi-(hi-lo)*f:v<lo+(hi-lo)*f)?[i]:[])}
m.parameters.values.set(m.parameters.defaultValues);m.update();let neutral=Object.fromEntries(['ArtMesh626','ArtMesh659','ArtMesh628','ArtMesh293','ArtMesh209','ArtMesh684','ArtMesh247'].map(id=>[id,Array.from(get(id))]));
let output=[];for(const[name,pose]of poses){m.parameters.values.set(m.parameters.defaultValues);for(const[id,v]of Object.entries(pose)){let i=m.parameters.ids.indexOf(id);if(i>=0)m.parameters.values[i]=v;}m.update();let o={name};for(const id of Object.keys(neutral))o[id]={top:center(get(id),band(neutral[id],true,.16)),bottom:center(get(id),band(neutral[id],false,.14))};output.push(o)}await fs.writeFile(outPath,JSON.stringify({ppu:m.canvasinfo.PixelsPerUnit,output},null,2));m.release();x.moc._release();
