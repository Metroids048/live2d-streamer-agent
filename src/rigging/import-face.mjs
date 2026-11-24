import * as fs from 'node:fs/promises';
import path from 'node:path';
import {composite, decodePng, encodePng} from '../artwork/png.mjs';
import {alphaGeometry} from './geometry.mjs';
import {safePath} from './files.mjs';

function adjacentRasters(lower,upper) {
  return lower&&upper&&[lower,upper].every(p=>!p.reference&&p.visible!==false&&(p.opacity??1)===1&&
    (!p.variant||p.variant.type==='none')&&p.group===lower.group&&Object.values(p.rect).every(Number.isInteger)&&
    p.rect.width===p.image.width&&p.rect.height===p.image.height);
}
// Every production layer can contain disconnected or low-alpha contours, including
// hidden alternates. Semantic tags must not decide which source pixels survive tracing.
export const needsMeshTraceSupport=({reference})=>!reference;

// 3.6.7 simplifies disconnected or subpixel-thin contours. Temporarily expand only the
// mesh tracing mask within the layer bounds. Production restores the original image with
// rebuild_mesh=false before posing, saving, or exporting any artwork.
function support(image,radius) {
  const {width:w,height:h,data}=image,mask=new Uint8Array(w*h);
  for(let y=0;y<h;y++)for(let x=0;x<w;) {
    if(!data[(y*w+x)*4+3]){x++;continue;}
    const start=x;
    while(x<w&&data[(y*w+x)*4+3])x++;
    for(let dy=Math.max(-radius,-y);dy<=Math.min(radius,h-1-y);dy++) {
      const row=(y+dy)*w,spread=Math.floor(Math.sqrt(radius*radius-dy*dy));
      mask.fill(255,row+Math.max(0,start-spread),row+Math.min(w,x+spread));
    }
  }
  const traced=Buffer.from(data);
  for(let i=0;i<mask.length;i++)traced[i*4+3]=mask[i];
  return {...image,data:traced};
}

function backCrown(fringe,temples,frontPng,rootPng,canvas) {
  // The portrait split cuts across the crown, not along an inked strand. Back
  // that joint with its neighboring hair pixels so relative motion cannot show skin.
  const radius=Math.max(2,Math.round(fringe.rect.width*.07));
  const {left,top,width,height}=fringe.rect;
  const x0=Math.max(0,left-radius),y0=Math.max(0,top-radius);
  const rect={left:x0,top:y0,width:Math.min(canvas.width,left+width+radius)-x0,height:top+height-y0};
  const png=composite(rect,[{image:frontPng,rect:{left:left-x0,top:top-y0,width,height}}]);
  const nearby=support(png,radius);
  const outer=temples.rect;
  let changed=false;
  const endY=Math.min(top+Math.ceil(height*.48),outer.top+outer.height);
  const endX=Math.min(x0+rect.width,outer.left+outer.width);
  for(let y=Math.max(y0,outer.top);y<endY;y++)for(let x=Math.max(x0,outer.left);x<endX;x++){
    const offset=((y-y0)*rect.width+x-x0)*4;
    const neighbor=((y-outer.top)*outer.width+x-outer.left)*4;
    if(!nearby.data[offset+3]||png.data[offset+3]===255)continue;
    if(rootPng.data[neighbor+3]===255){
      png.data.set(rootPng.data.subarray(neighbor,neighbor+4),offset);
      changed=true;
    }
  }
  if(changed)return {rect,png};
}

function blendLockEnds(temples,rear,rootPng,rearPng) {
  // Only fade the synthetic bottom of the temple layer where opaque rear hair
  // already supports it. Keep the actual outside silhouette and upper strands.
  const {left,top,width,height}=temples.rect,back=rear.rect;
  const depth=Math.min(height,Math.max(3,Math.round(width*.05)));
  const endY=Math.min(top+height,back.top+back.height);
  const endX=Math.min(left+width,back.left+back.width);
  const data=Buffer.from(rootPng.data);
  let changed=false;
  for(let y=Math.max(top+height-depth,back.top);y<endY;y++){
    const t=(top+height-y-1)/depth,weight=t*t*(3-2*t);
    for(let x=Math.max(left,back.left);x<endX;x++){
      const a=((y-top)*width+x-left)*4+3;
      const behind=((y-back.top)*back.width+x-back.left)*4+3;
      if(data[a]&&rearPng.data[behind]>=250){
        data[a]=Math.round(data[a]*weight);
        changed=true;
      }
    }
  }
  if(changed)return {...rootPng,data};
}

export async function prepareRigFaceImport(source,root,dir,{replacements=[],mergePortraitFringe=false}={}) {
  const {layout}=source,layers=layout.layers;
  const index=layers.findIndex(p=>p.tags?.length===1&&p.tags[0]==='face');
  const face=layers[index],chin=layers[index+1];
  const join=chin?.tags?.includes('chin-overlap')&&chin.tags.includes('face')&&adjacentRasters(face,chin);
  if(!join&&!layers.some(needsMeshTraceSupport))return source;
  const sourceDir=path.dirname(source.layoutFile),importDir=path.join(dir,'import-layout');
  await fs.mkdir(importDir,{recursive:true});
  if(await fs.realpath(importDir)!==importDir)throw new Error('RIGGING_DIRECTORY_SYMLINK');
  const read=async layer=>decodePng(await fs.readFile(await safePath(sourceDir,layer.image.path)));
  const fringeIndex=layers.findIndex(p=>p.id==='hair-front'&&p.tags?.includes('front'));
  const fringe=layers[fringeIndex],temples=layers[fringeIndex+1];
  const split=temples?.id==='hair-temples'&&temples.tags?.includes('root')&&adjacentRasters(fringe,temples);
  // These complementary rasters show the skin plate through a subpixel join
  // on the exported mesh. Sample their exact composite once on one mesh.
  const portraitFringe=mergePortraitFringe&&source.manifest?.backend?.modelVersion==='anime-source-pixels-1';
  const joinedFringe=split&&(portraitFringe||fringe.tags.includes('shared-forehair-join'));
  const joinedReplacements=replacements.filter(({layerId})=>joinedFringe&&(layerId===fringe.id||layerId===temples.id));
  const readFringe=async layer=>{
    const replacement=joinedReplacements.find(item=>item.layerId===layer.id);
    return replacement?decodePng(await fs.readFile(replacement.image)):read(layer);
  };
  const roots=split?await readFringe(temples):null;
  const front=split?await readFringe(fringe):null;
  let crown=split&&!joinedFringe?backCrown(fringe,temples,front,roots,layout.canvas):null;
  if(joinedFringe) {
    const a=fringe.rect,b=temples.rect,left=Math.min(a.left,b.left),top=Math.min(a.top,b.top);
    const rect={left,top,width:Math.max(a.left+a.width,b.left+b.width)-left,height:Math.max(a.top+a.height,b.top+b.height)-top};
    crown={rect,png:composite(rect,[[front,a],[roots,b]].map(([image,r])=>({image,rect:{...r,left:r.left-left,top:r.top-top}})))};
  }
  const rear=layers.slice(0,Math.max(0,fringeIndex)).find(p=>p.id==='hair-back'&&p.tags?.includes('back'));
  const lockEnds=split&&!joinedFringe&&adjacentRasters(rear,temples)?blendLockEnds(temples,rear,roots,await read(rear)):null;
  let merged,rect;
  if(join) {
    // These adjacent layers jointly carry one rigid patch of skin. Their complementary
    // boundaries must be composed before resampling, or the underlying neck leaks in.
    const left=Math.min(face.rect.left,chin.rect.left),top=Math.min(face.rect.top,chin.rect.top);
    const width=Math.max(...[face,chin].map(p=>p.rect.left+p.rect.width))-left;
    const height=Math.max(...[face,chin].map(p=>p.rect.top+p.rect.height))-top;
    rect={left,top,width,height};
    const inputs=[];
    for(const p of [face,chin])inputs.push({
      image:await read(p),
      rect:{...p.rect,left:p.rect.left-left,top:p.rect.top-top}
    });
    merged=composite({width,height},inputs);
  }
  const documentRadius=3*Math.max(1,Math.max(layout.canvas.width,layout.canvas.height)/2048);
  const updated=[],meshRestores=[];
  let newFace,newFacePath,newFringe;
  for(const [i,layer] of layers.entries()) {
    if(join&&layer===chin||joinedFringe&&layer===temples)continue;
    const filename='layer-'+i+'.png',destination=path.join(importDir,filename);
    const image={...layer.image,path:filename};
    if(join&&layer===face) {
      const original=path.join(importDir,'layer-'+i+'-source.png');
      await fs.writeFile(original,encodePng(merged));
      const radius=Math.min(Math.max(merged.width,merged.height),Math.ceil(documentRadius));
      await fs.writeFile(destination,encodePng(support(merged,radius)));
      meshRestores.push({layerId:layer.id,path:original});
      newFace={...face,rect,image:{...image,width:rect.width,height:rect.height}};
      newFacePath=path.relative(root,original);
      updated.push(newFace);
    } else if(crown&&layer===fringe) {
      const original=path.join(importDir,'layer-'+i+'-source.png');
      await fs.writeFile(original,encodePng(crown.png));
      await fs.writeFile(destination,encodePng(support(crown.png,Math.ceil(documentRadius))));
      meshRestores.push({layerId:layer.id,path:original});
      const {width,height}=crown.rect;
      const imported={...layer,rect:crown.rect,image:{...image,width,height}};
      updated.push(imported);
      newFringe={...imported,imagePath:path.relative(root,original),
        geometry:alphaGeometry({...crown.png,rgba:crown.png.data},crown.rect)};
    } else if(lockEnds&&layer===temples) {
      const original=path.join(importDir,'layer-'+i+'-source.png');
      await fs.writeFile(original,encodePng(lockEnds));
      await fs.writeFile(destination,encodePng(support(roots,Math.ceil(documentRadius))));
      meshRestores.push({layerId:layer.id,path:original});
      updated.push({...layer,image});
    } else {
      const sourcePath=await safePath(sourceDir,layer.image.path);
      if(needsMeshTraceSupport(layer)) {
        const png=decodePng(await fs.readFile(sourcePath));
        // Layout keeps raster pixels independent of document units. Preserve the same
        // tracing margin when HD pixels cover a smaller rect; never resample the image.
        const pixelScale=Math.max(png.width/layer.rect.width,png.height/layer.rect.height);
        const radius=Math.min(Math.max(png.width,png.height),Math.ceil(documentRadius*pixelScale));
        await fs.writeFile(destination,encodePng(support(png,radius)));
        meshRestores.push({layerId:layer.id,path:sourcePath});
      } else await fs.copyFile(sourcePath,destination);
      updated.push({...layer,image});
    }
  }
  const importLayout={...layout,layers:updated},layoutFile=path.join(importDir,'layout.json');
  await fs.writeFile(layoutFile,JSON.stringify(importLayout,null,2)+'\n');
  const parts=join||newFringe||split?source.parts.filter(p=>(!join||p.id!==chin.id)&&(!joinedFringe||p.id!==temples.id)).map(p=>{
    if(join&&p.id===face.id)return {...p,...newFace,imagePath:newFacePath,
      geometry:alphaGeometry({...merged,rgba:merged.data},rect),sourceLayerIds:[face.id,chin.id]};
    if(newFringe&&p.id===fringe.id)return {...p,...newFringe};
    if(split&&p.id===temples.id)return {...p,sharesFringeJoin:true};
    return p;
  }):source.parts;
  return {...source,layout:importLayout,layoutFile,meshRestores,parts,
    composedReplacementIds:joinedReplacements.map(({layerId})=>layerId)};
}
