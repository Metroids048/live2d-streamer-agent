// Audit the actual exported neutral MOC mesh against its registered source pixels.
// Usage: node scripts/rig-import-coverage.mjs layout.model3.json import-layout/layout.json [original/artwork/layout.json] > coverage.json
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {setTimeout as delay} from 'node:timers/promises';
import {readInstalledRenderer} from './leaf-isolated-assets.mjs';
import {decodePng} from '../src/artwork/png.mjs';
import {safePath} from '../src/rigging/files.mjs';
import {needsMeshTraceSupport} from '../src/rigging/import-face.mjs';

const [modelPath,layoutPath,sourcePath]=process.argv.slice(2);
if(!layoutPath||!modelPath?.endsWith('.model3.json'))throw Error('Expected model3.json and the corresponding import layout.json');
const modelDir=path.dirname(modelPath),layoutDir=path.dirname(layoutPath);
const json=async filename=>JSON.parse(await fs.readFile(filename,'utf8'));
const refs=(await json(modelPath)).FileReferences,layout=await json(layoutPath);
const originals=sourcePath?new Map((await json(sourcePath)).layers.map(p=>[p.id,p])):null;
const metadata=await json(modelPath.replace(/\.model3\.json$/,'.psd2live.json'));
const installed=await readInstalledRenderer();
const ctx=vm.createContext({console:{...console,log:console.error},setTimeout,clearTimeout,TextDecoder,TextEncoder,atob,btoa,WebAssembly,document:{currentScript:{src:''}},window:{},performance});
vm.runInContext(installed.files.get('/runtime/live2dcubismcore.min.js').toString(),ctx);
const core=ctx.Live2DCubismCore,bytes=await fs.readFile(await safePath(modelDir,refs.Moc));
let moc;
for(let i=0;i<50&&!moc;i++) {
  try{moc=core.Moc.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));}
  catch(error){if(i===49)throw error;await delay(50);}
}
const model=core.Model.fromMoc(moc);model.update();
const rig=model.drawables,canvas=model.canvasinfo;
const atlases=await Promise.all(refs.Textures.map(async name=>decodePng(await fs.readFile(await safePath(modelDir,name)))));
const scale=5;
const clamp=(value,lo,hi)=>Math.max(lo,Math.min(hi,value));
const rows=[];
for(const part of layout.layers) {
  if(part.reference)continue;
  const entry=metadata.layers.find(l=>l.source===part.name),i=rig.ids.indexOf(entry?.drawable);
  if(i<0)throw Error('Missing drawable '+part.id);
  const restored=originals&&needsMeshTraceSupport(part);
  const image=restored?originals.get(part.id):part;
  if(!image)throw Error('Missing original artwork '+part.id);
  const source=decodePng(await fs.readFile(await safePath(restored?path.dirname(sourcePath):layoutDir,image.image.path)));
  const positions=rig.vertexPositions[i],uv=rig.vertexUvs[i],indices=rig.indices[i],atlas=atlases[rig.textureIndices[i]];
  const u=[],v=[];
  for(let k=0;k<uv.length;k+=2) {
    u.push(uv[k]*atlas.width);v.push((1-uv[k+1])*atlas.height);
  }
  const {width:w,height:h}=source;
  // HD source pixels and canvas units have different scales. Locate the actual
  // atlas tile by exact source pixels rather than by a neutral world position.
  const painted=[];
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(source.data[4*(y*w+x)+3])painted.push([x,y]);
  if(!painted.length)throw Error('Empty source '+part.id);
  const samples=Array.from({length:Math.min(49,painted.length)},(_,i)=>painted[Math.floor(i*(painted.length-1)/Math.max(1,Math.min(49,painted.length)-1))]);
  const matches=[];
  // A layer may have a large transparent margin after source repartition. UV minima
  // then follow the painted contour, not the tile origin. Bound candidate origins
  // with both UV extrema and the complete source dimensions; still require exact pixels.
  const minX=Math.max(0,Math.floor(Math.max(...u))-w-64),maxX=Math.min(atlas.width-w,Math.ceil(Math.min(...u))+64);
  const minY=Math.max(0,Math.floor(Math.max(...v))-h-64),maxY=Math.min(atlas.height-h,Math.ceil(Math.min(...v))+64);
  for(let oy=minY;oy<=maxY;oy++)for(let ox=minX;ox<=maxX;ox++) {
    if(samples.every(([x,y])=>{const s=4*(y*w+x),a=4*((oy+y)*atlas.width+ox+x);return [0,1,2,3].every(c=>source.data[s+c]===atlas.data[a+c]);}))matches.push([ox,oy]);
  }
  if(matches.length!==1)throw Error('Source atlas registration is not unique: '+part.id+' matches='+matches.length);
  const [x0,y0]=matches[0];
  let maxAlphaDiff=0,maxVisibleColorDiff=0;
  if(x0<0||y0<0||x0+w>atlas.width||y0+h>atlas.height)throw Error('Atlas offset outside texture '+part.id);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++) {
    const s=4*(y*w+x),a=4*((y0+y)*atlas.width+x0+x);
    maxAlphaDiff=Math.max(maxAlphaDiff,Math.abs(source.data[s+3]-atlas.data[a+3]));
    if(source.data[s+3])for(let c=0;c<3;c++)maxVisibleColorDiff=Math.max(maxVisibleColorDiff,Math.abs(source.data[s+c]-atlas.data[a+c]));
  }
  if(maxAlphaDiff||maxVisibleColorDiff)throw Error('Source not exactly registered in atlas: '+part.id+' alpha='+maxAlphaDiff+' RGB='+maxVisibleColorDiff);
  const mask=new Uint8Array(w*h*scale*scale);
  for(let k=0;k<indices.length;k+=3) {
    const ids=indices.slice(k,k+3);
    const xs=Array.from(ids,id=>(u[id]-x0)*scale),ys=Array.from(ids,id=>(v[id]-y0)*scale);
    const cross=(ax,ay,bx,by)=>ax*by-ay*bx;
    const sign=Math.sign(cross(xs[1]-xs[0],ys[1]-ys[0],xs[2]-xs[0],ys[2]-ys[0]));
    if(!sign)continue;
    const left=Math.max(0,Math.floor(Math.min(...xs))),right=Math.min(w*scale-1,Math.ceil(Math.max(...xs)));
    const top=Math.max(0,Math.floor(Math.min(...ys))),bottom=Math.min(h*scale-1,Math.ceil(Math.max(...ys)));
    for(let y=top;y<=bottom;y++)for(let x=left;x<=right;x++) {
      let inside=true;
      for(let n=0;n<3&&inside;n++){const m=(n+1)%3;inside=sign*cross(xs[m]-xs[n],ys[m]-ys[n],x+.5-xs[n],y+.5-ys[n])>=-1e-6;}
      if(inside)mask[y*w*scale+x]=1;
    }
  }
  const alpha=(x,y)=>source.data[4*(clamp(y,0,h-1)*w+clamp(x,0,w-1))+3]/255;
  let missing=0,mass=0;
  for(let y=0;y<h*scale;y++)for(let x=0;x<w*scale;x++) {
    const sx=(x+.5)/scale-.5,sy=(y+.5)/scale-.5,ix=Math.floor(sx),iy=Math.floor(sy),fx=sx-ix,fy=sy-iy;
    const a=(1-fy)*((1-fx)*alpha(ix,iy)+fx*alpha(ix+1,iy))+fy*((1-fx)*alpha(ix,iy+1)+fx*alpha(ix+1,iy+1));
    mass+=a;if(!mask[y*w*scale+x])missing+=a;
  }
  const centerCoverage=Object.fromEntries([['gt0',1],['gte128',128],['eq255',255]].map(([name,threshold])=>{
    let pixels=0,outside=0;
    for(const [x,y]of painted)if(source.data[4*(y*w+x)+3]>=threshold){pixels++;if(!mask[(y*scale+2)*w*scale+x*scale+2])outside++;}
    return [name,{pixels,outside}];
  }));
  rows.push({id:part.id,opacity:rig.opacities[i],atlasTile:[x0,y0,w,h],maxAlphaDiff,maxVisibleColorDiff,centerCoverage,missingFraction:+(missing/mass).toFixed(4),missingOpaqueEquivalents:+(missing/(scale*scale)).toFixed(2)});
}
console.log(JSON.stringify({method:'5x subpixel triangle inclusion over verified atlas alpha. Neutral pose only.',layers:rows},null,2));
