// Pixel extraction from the single registered HD mother image. Generated hidden
// skin / mouth / blink inputs remain immutable and are never represented as
// recovered source pixels. Logical Layout coordinates are independent of raster.
import {mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {decodePng,encodePng,alphaBounds,cropPng,composite} from './png.mjs';
import {repairEyeOwnership} from './hd-eye-ownership.mjs';

const hash=b=>createHash('sha256').update(b).digest('hex');
export function insidePolygon(x,y,p) {
  let yes=false;
  for(let i=0,j=p.length-1;i<p.length;j=i++) {
    const [a,b]=p[i],[c,d]=p[j];
    if((b>y)!==(d>y)&&x<(c-a)*(y-b)/(d-b)+a)yes=!yes;
  }
  return yes;
}
function polygonDistance(x,y,points) {
  let closest=Infinity;
  for(let i=0,j=points.length-1;i<points.length;j=i++) {
    const [ax,ay]=points[j],[bx,by]=points[i],dx=bx-ax,dy=by-ay;
    const t=Math.max(0,Math.min(1,((x-ax)*dx+(y-ay)*dy)/(dx*dx+dy*dy)));
    closest=Math.min(closest,Math.hypot(x-ax-t*dx,y-ay-t*dy));
  }
  return closest;
}
const box=(x,y,b)=>x>=b[0]&&y>=b[1]&&x<b[2]&&y<b[3];
const blank=(w,h)=>({width:w,height:h,data:Buffer.alloc(w*h*4)});
function copyPixel(to,ti,from,fi){from.data.copy(to.data,ti,fi,fi+4);}
export function extractPixels(source,accept) {
  const out=blank(source.width,source.height);
  for(let y=0;y<source.height;y++)for(let x=0;x<source.width;x++) {
    const i=(y*source.width+x)*4;
    if(source.data[i+3]&&accept(x,y,source.data.subarray(i,i+4)))copyPixel(out,i,source,i);
  }
  return out;
}
function sample(image,x,y) {
  x=Math.min(image.width-1,Math.max(0,Math.round(x)));y=Math.min(image.height-1,Math.max(0,Math.round(y)));
  return image.data.subarray((y*image.width+x)*4,(y*image.width+x)*4+4);
}
function fitLayer(image,width,height) {
  return composite({width,height},[{image,rect:{left:0,top:0,width,height}}]);
}
// Alpha-only cleanup: the image editor's transparent result contains saturated
// matte specks. Retain source RGB, remove isolated components and only the
// thin red/yellow fringe touching transparent background.
export function cleanAlpha(source) {
  const out={...source,data:Buffer.from(source.data)},w=source.width,h=source.height;
  const alpha=(x,y)=>x<0||y<0||x>=w||y>=h?0:source.data[(y*w+x)*4+3];
  for(let y=0;y<h;y++)for(let x=0;x<w;x++) {
    const i=(y*w+x)*4,[r,g,b,a]=source.data.subarray(i,i+4);
    if(!a)continue;
    const matte=(r>210&&g<85&&b<85&&r>g*2.3)||(r>210&&g>185&&b<75);
    const pale=r>235&&g>230&&b>230;
    let edge=false;
    const reach=matte?4:pale?1:0;
    for(let dy=-reach;dy<=reach&&!edge;dy++)for(let dx=-reach;dx<=reach;dx++)if(alpha(x+dx,y+dy)<80){edge=true;break;}
    const pureMatte=r>245&&((g<25&&b<25)||(g>245&&b<25));
    if(a<100||edge||pureMatte)out.data[i+3]=0;
  }
  const seen=new Uint8Array(w*h),queue=new Int32Array(w*h);
  for(let p=0;p<w*h;p++) {
    if(seen[p]||!out.data[p*4+3])continue;
    let n=1;queue[0]=p;seen[p]=1;
    for(let q=0;q<n;q++) {
      const at=queue[q],x=at%w,y=Math.floor(at/w);
      for(const [dx,dy]of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const xx=x+dx,yy=y+dy,next=yy*w+xx;
        if(xx<0||xx>=w||yy<0||yy>=h||seen[next]||!out.data[next*4+3])continue;
        seen[next]=1;queue[n++]=next;
      }
    }
    if(n<80)for(let q=0;q<n;q++)out.data[queue[q]*4+3]=0;
  }
  return out;
}
function overAt(target,source,rect) {
  return composite({width:target.width,height:target.height},[
    {image:target,rect:{left:0,top:0,width:target.width,height:target.height}},
    {image:source,rect}]);
}
export function composeRegisteredFace(cleanSkin,sourceFace) {
  const visible={...sourceFace,data:Buffer.from(sourceFace.data)};
  // Pale eye rims, the mouth rim and lower-lip shadow belong to moving
  // features too. Do not bake their neutral outlines into the fixed skin.
  for(const [x0,y0,x1,y1]of [[529,938,729,1044],[332,643,563,795],[694,643,944,795]]) {
    const left=x0-28,top=y0-28,width=x1-x0+57,height=y1-y0+57,support=new Float32Array(width*height);
    // Fade before the narrower inferred oval ends, preserving the real jaw.
    for(let y=0;y<height;y++)for(let x=0;x<width;x++)support[y*width+x]=cleanSkin.data[((y+top)*1254+x+left)*4+3]>=250?width:0;
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=y*width+x;support[i]=Math.min(support[i],x?support[i-1]+1:width,y?support[i-width]+1:width);}
    for(let y=height-1;y>=0;y--)for(let x=width-1;x>=0;x--){const i=y*width+x;support[i]=Math.min(support[i],x+1<width?support[i+1]+1:width,y+1<height?support[i+width]+1:width);}
    for(let y=top;y<top+height;y++)for(let x=left;x<left+width;x++) {
      const d=Math.max(x0-x,x-x1,y0-y,y-y1,0);
      const t=Math.min(1,d/28),s=Math.min(1,support[(y-top)*width+x-left]/24);
      const keep=1-(1-t*t*(3-2*t))*s*s*(3-2*s);
      visible.data[(y*1254+x)*4+3]=Math.round(visible.data[(y*1254+x)*4+3]*keep);
    }
  }
  return overAt(cleanSkin,visible,{left:0,top:0,width:1254,height:1254});
}
export function completeCleanEyeSupport(skin) {
  const source={...skin,data:Buffer.from(skin.data)};
  for(const [x0,y0,x1,y1]of [[305,625,580,805],[685,625,965,805]])for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++) {
    const i=(y*skin.width+x)*4;
    // The inferred oval is narrower than the neutral eye's outer corners.
    // Extend a stable interior texel from its own row, rather than following
    // the generated oval's noisy alpha edge and creating horizontal stripes.
    const from=(y*skin.width+(x0<600?430:810))*4;
    if(source.data[from+3]<250)throw Error('CLEAN_EYE_SKIN_SUPPORT_MISSING');
    const t=Math.min(1,Math.max(0,x0<600?(390-x)/30:(x-865)/30));
    const blend=source.data[i+3]<250?1:t*t*(3-2*t);
    if(!blend)continue;
    const edge=Math.min(1,Math.min(x-x0+1,x1-x,y-y0+1,y1-y)/8);
    for(let c=0;c<3;c++)skin.data[i+c]=Math.round(source.data[i+c]*(1-blend)+source.data[from+c]*blend);
    skin.data[i+3]=Math.max(source.data[i+3],Math.round(source.data[from+3]*edge));
  }
  return skin;
}
const poly={
  eyeRight:[[354,700],[367,686],[403,676],[444,674],[485,674],[516,684],[538,701],[542,716],[531,735],[508,750],[474,758],[431,755],[400,749],[380,734],[369,716]],
  eyeLeft:[[711,706],[730,687],[765,675],[801,674],[836,679],[873,693],[898,706],[900,724],[882,745],[854,756],[816,759],[776,754],[746,744],[725,729]],
  face:[[331,430],[925,430],[935,780],[910,866],[851,962],[759,1055],[629,1151],[523,1080],[418,980],[353,868],[328,780]],
  browRight:[[350,610],[380,599],[429,589],[475,590],[515,598],[533,609],[486,604],[432,602],[385,609],[351,620]],
  browLeft:[[703,611],[733,599],[780,590],[831,593],[878,607],[896,621],[849,610],[795,603],[747,607],[707,621]],
  mouthOpen:[[550,954],[577,948],[624,946],[674,948],[704,954],[698,976],[683,995],[659,1009],[629,1016],[597,1010],[574,997],[559,977]],
  blinkRight:[[319,633],[371,624],[455,623],[522,641],[563,677],[566,725],[554,785],[478,801],[399,795],[351,769],[326,729]],
  blinkLeft:[[690,638],[741,624],[831,627],[896,645],[944,671],[951,729],[931,784],[856,800],[772,796],[713,776],[689,732]],
  closedRight:[[348,711],[383,721],[433,722],[480,712],[519,711],[550,726],[562,743],[529,742],[483,757],[422,764],[375,758],[349,745]],
  closedLeft:[[712,716],[748,710],[787,716],[829,722],[869,721],[905,711],[907,745],[866,759],[807,765],[759,757],[714,744]],
};

export function extractClosedEyeContours(source,side) {
  const boundary=side==='right'?poly.closedRight:poly.closedLeft;
  const out=extractPixels(source,(x,y)=>insidePolygon(x,y,boundary));
  for(let y=0;y<out.height;y++)for(let x=0;x<out.width;x++) {
    const i=(y*out.width+x)*4,[r,g,b,a]=out.data.subarray(i,i+4);if(!a)continue;
    // Keep the edited mother's real dark lashes and pale warm eyelid crease.
    // The broad pink fill is redundant now that the fixed skin is featureless.
    const contrast=Math.min(1,Math.max(0,(205-g)/25));
    const edge=Math.min(1,polygonDistance(x,y,boundary)/2);
    out.data[i+3]=r>235&&g>180?0:Math.round(a*contrast*edge);
  }
  return out;
}

export function recoverDetachedEyeContours(masks) {
  const hair=masks['registered-hair-front'],w=hair.width,h=hair.height;
  const seen=new Uint8Array(w*h),queue=new Int32Array(w*h),recovered={right:0,left:0};
  for(let start=0;start<w*h;start++) {
    if(seen[start]||!hair.data[start*4+3])continue;
    let n=1,minx=w,miny=h,maxx=0,maxy=0;queue[0]=start;seen[start]=1;
    for(let q=0;q<n;q++) {
      const at=queue[q],x=at%w,y=Math.floor(at/w);
      minx=Math.min(minx,x);miny=Math.min(miny,y);maxx=Math.max(maxx,x);maxy=Math.max(maxy,y);
      for(const [xx,yy]of [[x+1,y],[x-1,y],[x,y+1],[x,y-1]]) {
        const next=yy*w+xx;
        if(xx<0||xx>=w||yy<0||yy>=h||seen[next]||!hair.data[next*4+3])continue;
        seen[next]=1;queue[n++]=next;
      }
    }
    // Only isolated neutral-eye fragments inside the eye's exposed area.
    // Root-connected bangs, side hair and the higher brow line remain intact.
    const side=minx>=354&&maxx<560?'right':minx>=705&&maxx<916?'left':null;
    if(!side||n>250||miny<631||maxy>=781)continue;
    const aperture=side==='right'?poly.eyeRight:poly.eyeLeft;
    if(Array.from(queue.subarray(0,n)).some(at=>polygonDistance(at%w,Math.floor(at/w),aperture)>45))continue;
    for(let q=0;q<n;q++) {
      const at=queue[q],y=Math.floor(at/w),id=y<665?`source-eye-rim-${side}`:y<727?`source-eye-lash-upper-${side}`:`source-eye-lash-lower-${side}`;
      copyPixel(masks[id],at*4,hair,at*4);hair.data[at*4+3]=0;recovered[side]++;
    }
  }
  return recovered;
}

function restoreOuterHairFromBlink(masks,blink) {
  const counts={right:0,left:0};
  // The precise blink edit retains the actual gray side strands behind the
  // neutral outer lashes. Use those same registered pixels to restore hair
  // that the old rectangular lash classifier had assigned to moving eyes.
  const hairEdges={right:[[305,625],[330,625],[334,675],[344,720],[361,760],[383,805],[305,805]],left:[[932,625],[965,625],[965,805],[870,805],[878,797],[905,752],[920,710],[928,665]]};
  for(const [side,x0,x1]of [['right',305,384],['left',870,965]])for(let y=625;y<805;y++)for(let x=x0;x<x1;x++) {
    const i=(y*1254+x)*4,[r,g,b,a]=blink.data.subarray(i,i+4);
    if(!a||!insidePolygon(x,y,hairEdges[side]))continue;
    copyPixel(masks['registered-hair-front'],i,blink,i);
    for(const type of ['white','iris','lash-upper','lash-lower','rim'])masks[`source-eye-${type}-${side}`].data[i+3]=0;
    counts[side]++;
  }
  return counts;
}

export async function materializeHdG1({directory,bodyPath,headPath,skinPath,mouthPath,blinkPath,identity,parentManifestPath,eyePreviewsOnly=false}) {
  await mkdir(path.join(directory,'parts'),{recursive:true});await mkdir(path.join(directory,'sources'),{recursive:true});
  const sources={};
  for(const [key,file]of Object.entries({body:bodyPath,head:headPath,skin:skinPath,mouth:mouthPath,...(blinkPath?{blink:blinkPath}:{})})) {
    const bytes=await readFile(file);const image=decodePng(bytes);const dest=`sources/${key}-master.png`;
    if(path.resolve(file)!==path.resolve(directory,dest))await copyFile(file,path.join(directory,dest));
    sources[key]={path:dest,sha256:hash(bytes),width:image.width,height:image.height,image};
  }
  const body=cleanAlpha(sources.body.image),head=cleanAlpha(sources.head.image),skin=sources.skin.image,mouth=sources.mouth.image;
  if(head.width!==1254||head.height!==1254||body.width!==941||body.height!==1672)throw Error('HD_MASTER_DIMENSIONS_CHANGED_REVIEW_GEOMETRY');
  const k=800/body.height,offset=(800-body.width*k)/2;
  const bodyTransform={left:offset,top:0,scaleX:k,scaleY:k};
  const headBody={left:313,top:0,width:313,height:292};
  const headTransform={left:offset+headBody.left*k,top:0,scaleX:headBody.width*k/head.width,scaleY:headBody.height*k/head.height};
  const pieces=[];
  const add=(id,name,image,transform,tags,options={})=>pieces.push({id,name,image,transform,tags,visible:true,opacity:1,...options});
  const bodyOwners=new Map();
  function bodyOwner(x,y) {
    if(y<265)return null;
    if(y<282&&(x<412||x>535))return null;
    if(y>=975)return x<470?'registered-leg-right':'registered-leg-left';
    if(y>=608)return 'registered-lower-body';
    if(x>=584&&y>=310)return 'source-gesture-wave-rest';
    if(x<346&&y>480)return 'registered-arm-right';
    if(y<320&&x>390&&x<545)return 'registered-neck';
    if(box(x,y,[423,390,516,457]))return 'source-appearance-chest_bow';
    return 'registered-upper-body';
  }
  const bodyInfo={
    'registered-leg-right':['leg:right',['leg','right']], 'registered-leg-left':['leg:left',['leg','left']],
    'registered-lower-body':['lower-body',['lower-body']], 'registered-upper-body':['upper-body',['upper-body']],
    'registered-neck':['neck',['neck']], 'registered-arm-right':['arm:right',['arm','right']],
    'source-gesture-wave-rest':['gesture:wave:rest',['gesture','wave','rest']],
    'source-appearance-chest_bow':['appearance:chest_bow',['appearance','chest_bow']],
  };
  for(const id of Object.keys(bodyInfo))bodyOwners.set(id,blank(body.width,body.height));
  for(let y=0;y<body.height;y++)for(let x=0;x<body.width;x++) {
    const id=bodyOwner(x,y),i=(y*body.width+x)*4;
    if(id&&body.data[i+3])copyPixel(bodyOwners.get(id),i,body,i);
  }
  for(const [id,[name,tags]]of Object.entries(bodyInfo))add(id,name,bodyOwners.get(id),bodyTransform,tags,{origin:'generated',inferredRegions:[]});

  const masks={};
  for(const id of ['registered-face','registered-brow-right','registered-brow-left','registered-nose',
    'source-eye-white-right','source-eye-iris-right','source-eye-lash-upper-right','source-eye-lash-lower-right','source-eye-rim-right',
    'source-eye-white-left','source-eye-iris-left','source-eye-lash-upper-left','source-eye-lash-lower-left','source-eye-rim-left',
    'source-mouth-closed','registered-hair-back','registered-hair-side-right','registered-hair-side-left','registered-hair-front','registered-hair-root'])masks[id]=blank(head.width,head.height);
  const dark=(r,g,b)=>r<170&&g<130&&b<140;
  function owner(x,y,[r,g,b]) {
    if(box(x,y,[536,946,723,998])&&(r<220&&g<150&&b<155||box(x,y,[618,974,642,978])))return 'source-mouth-closed';
    if(box(x,y,[611,823,649,897])&&(r-g>45||r>250&&g>230))return 'registered-nose';
    for(const side of ['right','left']) {
      const xr=side==='right'?[312,568]:[690,949],cx=side==='right'?462:798;
      const aperture=side==='right'?poly.eyeRight:poly.eyeLeft;
      const interior=insidePolygon(x,y,aperture);
      if(interior) {
        const iris=((x-cx)/57)**2+((y-717)/48)**2<1;
        if(iris)return `source-eye-iris-${side}`;
        return `source-eye-white-${side}`;
      }
      // The aperture's polygon misses a few pale native sclera pixels at the
      // lower inner corners. These must close with the eye, not stay in hair.
      if(box(x,y,[xr[0]+20,710,xr[1]-15,780])&&r>235&&g>225&&b>230&&polygonDistance(x,y,aperture)<=12)return `source-eye-white-${side}`;
      if(box(x,y,[xr[0],650,xr[1],731])&&dark(r,g,b))return `source-eye-lash-upper-${side}`;
      if(box(x,y,[xr[0],727,xr[1],785])&&dark(r,g,b))return `source-eye-lash-lower-${side}`;
      if(box(x,y,[xr[0]+15,631,xr[1]-9,664])&&r-g>45&&g<180)return `source-eye-rim-${side}`;
      if(insidePolygon(x,y,side==='right'?poly.browRight:poly.browLeft))return `registered-brow-${side}`;
    }
    if(insidePolygon(x,y,poly.face)&&r>150&&r-g>6&&r-b>13&&b>95)return 'registered-face';
    if(y<405)return 'registered-hair-root';
    if(y<780&&x>280&&x<980)return 'registered-hair-front';
    if(x<520)return 'registered-hair-side-right';
    if(x>735)return 'registered-hair-side-left';
    return 'registered-hair-back';
  }
  for(let y=0;y<head.height;y++)for(let x=0;x<head.width;x++) {
    const i=(y*head.width+x)*4;if(!head.data[i+3])continue;
    const id=owner(x,y,head.data.subarray(i,i+3));copyPixel(masks[id],i,head,i);
  }
  const recoveredEyeContourPixels=recoverDetachedEyeContours(masks);
  const restoredOuterHairPixels=sources.blink?restoreOuterHairFromBlink(masks,sources.blink.image):{right:0,left:0};
  // Keep six actual mother-image rows on both sides of this opaque hair cut.
  // Adjacent PNG borders otherwise sample transparent atlas padding separately.
  let hairRootOverlapPixels=0;
  for(let y=405;y<411;y++)for(let x=0;x<1254;x++) {
    const i=(y*1254+x)*4;
    if(masks['registered-hair-front'].data[i+3]) {
      copyPixel(masks['registered-hair-root'],i,masks['registered-hair-front'],i);hairRootOverlapPixels++;
    }
  }
  // The inferred skin is restricted to the actual visible cheek/chin mask, plus
  // forehead behind the hair. Source skin pixels replace the inferred colors.
  const sb=alphaBounds(skin),skinCrop=cropPng(skin,sb);
  const under=overAt(blank(1254,1254),skinCrop,{left:235,top:260,width:785,height:895});
  const face=masks['registered-face'];
  for(let y=0;y<1254;y++)for(let x=0;x<1254;x++) {
    const i=(y*1254+x)*4;
    const within=insidePolygon(x,y,poly.face);
    if(!within)under.data[i+3]=0;
  }
  completeCleanEyeSupport(under);
  masks['registered-face']=composeRegisteredFace(under,face);
  const eyeOwnership=sources.blink?repairEyeOwnership(masks,head,sources.blink.image):null;

  // Complete sclera behind the actual iris, using the neighboring same-eye
  // sclera colors. Only newly exposed pixels are inferred; default iris remains
  // copied at native resolution from the neutral master.
  for(const side of ['right','left']) {
    const white=masks[`source-eye-white-${side}`],iris=masks[`source-eye-iris-${side}`];
    for(let y=0;y<1254;y++)for(let x=0;x<1254;x++) {
      const i=(y*1254+x)*4;if(!iris.data[i+3])continue;
      const c=sample(head,side==='right'?388:889,Math.min(735,Math.max(705,y)));
      white.data[i]=Math.max(225,c[0]);white.data[i+1]=Math.max(222,c[1]);white.data[i+2]=Math.max(229,c[2]);white.data[i+3]=255;
    }
  }
  // Exact source order: back hair and inferred full face, then independent
  // details, then source front/side hair. IDs retain the production semantics.
  const headOrder=['registered-hair-back','registered-face','registered-brow-right','registered-brow-left','registered-nose',
    'source-eye-white-right','source-eye-iris-right','source-eye-lash-upper-right','source-eye-lash-lower-right','source-eye-rim-right',
    'source-eye-white-left','source-eye-iris-left','source-eye-lash-upper-left','source-eye-lash-lower-left','source-eye-rim-left',
    'source-mouth-closed','registered-hair-front','registered-hair-root','registered-hair-side-right','registered-hair-side-left'];
  function semantic(id) {
    if(id==='registered-face')return ['face'];if(id==='registered-nose')return ['nose'];
    return id.replace(/^(registered|source)-/,'').split('-');
  }
  for(const id of headOrder)add(id,semantic(id).join(':'),masks[id],headTransform,semantic(id),{origin:'generated',inferredRegions:id==='registered-face'?['skin beneath bangs and facial features','featureless eye and mouth surrounds replace fixed neutral outlines']:id.includes('white')?['sclera beneath iris']:[]});

  const mouthImage=mouth.width===1254&&mouth.height===1254?mouth:fitLayer(mouth,1254,1254);
  const mouthInterior=extractPixels(mouthImage,(x,y)=>insidePolygon(x,y,poly.mouthOpen));
  for(const [id,tags,test]of [
    ['source-mouth-open',['mouth','open'],(_x,y)=>y>=954&&y<1009],
    ['source-mouth-line-upper',['mouth','line','upper','open'],(_x,y)=>y<957],
    ['source-mouth-line-lower',['mouth','line','lower','open'],(_x,y)=>y>=1006],
  ])add(id,tags.filter(t=>t!=='open'||tags.length===2).join(':'),extractPixels(mouthInterior,test),headTransform,tags,{visible:false,variant:{type:'switch',parameter:'ParamMouthOpenY',switch_id:1},origin:'generated',inferredRegions:['speaking mouth derived from head master edit']});
  if(sources.blink) {
    const blink=sources.blink.image.width===1254&&sources.blink.image.height===1254?sources.blink.image:fitLayer(sources.blink.image,1254,1254);
    for(const side of ['right','left'])add(`source-eye-closed-${side}`,`eye:closed:${side}`,
      extractClosedEyeContours(blink,side),headTransform,['eye','closed',side],
      {visible:false,variant:{type:'switch',parameter:side==='left'?'ParamEyeLOpen':'ParamEyeROpen',switch_id:0},origin:'generated',inferredRegions:['true closed eyelashes and light eyelid crease from the same head edit; redundant broad skin patch removed']});
  }

  const layers=[],parts=[];
  for(const p of pieces) {
    const bounds=alphaBounds(p.image);if(!bounds.opaquePixels)continue;
    const image=cropPng(p.image,bounds),relative=`parts/${p.id}.png`,bytes=encodePng(image);await writeFile(path.join(directory,relative),bytes);
    const rect={left:p.transform.left+bounds.left*p.transform.scaleX,top:p.transform.top+bounds.top*p.transform.scaleY,width:image.width*p.transform.scaleX,height:image.height*p.transform.scaleY};
    const layer={id:p.id,name:p.name,image:{path:relative,width:image.width,height:image.height},rect,tags:p.tags,visible:p.visible,opacity:1,reference:false,...(p.variant?{variant:p.variant}:{})};layers.push(layer);
    parts.push({...layer,path:relative,sha256:hash(bytes),pixelSha256:hash(image.data),origin:p.origin,inferredRegions:p.inferredRegions??[],side:p.tags.includes('left')?'left':p.tags.includes('right')?'right':'unspecified',layoutLayerId:p.id,occlusion:{status:p.inferredRegions?.length?'inferred_unreviewed':'source_visible',note:'Native mother-image extraction; source and inferred regions documented separately.'}});
  }
  const layout={format:'psd2live-layout',version:1,name:`Hachi HD G1 revision ${identity.revision}`,canvas:{width:800,height:800},groups:[],layers};
  await writeFile(path.join(directory,'layout.json'),JSON.stringify(layout,null,2));
  await writeFile(path.join(directory,'layout-3200.json'),JSON.stringify({...layout,canvas:{width:3200,height:3200},layers:layers.map(l=>({...l,rect:Object.fromEntries(Object.entries(l.rect).map(([k,v])=>[k,v*4]))}))},null,2));
  const layoutBytes=await readFile(path.join(directory,'layout.json'));
  const manifest={schemaVersion:1,...identity,status:'blocked',backend:{id:'builtin-imagegen-head-edit-and-native-pixel-extraction',version:'hd-g1-mouth-clean-20261104',modelVersion:'built-in-imagegen'},canvas:layout.canvas,
    coordinateSystem:'800 logical canvas; each raster retained at native source resolution; top-left origin',layoutPath:'layout.json',parentManifestPath,
    faceComposition:{cleanSkinSource:'sources/skin-master.png',cleanSkinRegistration:{left:235,top:260,width:785,height:895},mouthCleanCore:{left:529,top:938,width:201,height:107},eyeCleanCores:[{left:332,top:643,width:232,height:153},{left:694,top:643,width:251,height:153}],featherNativePixels:28,cleanSourceSupportFeather:24,eyeSupportCompletion:'Same-row stable interior clean-skin pixels extend fixed skin beneath outer eye corners; no movable eye pixels covered',closedMouthNativeHighlight:{left:618,top:974,width:24,height:4},recoveredEyeContourPixels,restoredOuterHairPixels,outerHairCompletionSource:'sources/blink-master.png',closedEyeComposition:'Original closed lash and light crease pixels only; redundant broad skin alpha removed',hairRootOverlap:{source:'sources/head-master.png',top:405,rows:6,pixels:hairRootOverlapPixels},reason:'Do not overlay neutral eye rims, mouth rim or lower-lip shadow onto the featureless skin mother; detached native eye contours retain their RGB in the moving eye layers.'},
    eyeOwnership,sourceMapping:{method:'single-hd-mother-image-coordinate-registration',verified:false},sources:Object.fromEntries(Object.entries(sources).map(([k,{image,...s}])=>[k,s])),parts,
    quality:{scope:'G1 only; full-body mother plus same-identity head edit; not G2 gesture/chest variants',defaultComposite:'pending visual review',engineImport:'not_run',identity:'pending visual review',userAcceptance:'not_run'},
    checks:[{name:'hd-native-raster','layer':'automated',status:'passed',note:'1254×1254 native head mother; face/eye parts extracted without downsampling.'},{name:'hd-g1-visual','layer':'visual',status:'not_run'},{name:'psd2live-import','layer':'runtime',status:'not_run'}]};
  manifest.artworkFingerprint=hash(Buffer.from(JSON.stringify({layoutSha256:hash(layoutBytes),parts:parts.map(p=>({id:p.id,sha256:p.sha256,rect:p.rect}))})));
  await writeFile(path.join(directory,'artwork-manifest.json'),JSON.stringify(manifest,null,2));
  const render=async(width,height,headOnly=false,states={})=>{
    const mouthOpen=states.mouthOpen??(states.mouth?1:0),mouthPivotY=967*headTransform.scaleY;
    const visible=layers.filter(l=>!headOnly||!bodyOwners.has(l.id)).map(l=>{
      let v=l.visible,rect=l.rect;
      if(l.tags.includes('mouth')) {
        v=mouthOpen>0?l.tags.includes('open'):l.tags.includes('closed');
        if(v&&mouthOpen>0&&mouthOpen<1)rect={...rect,top:mouthPivotY+(rect.top-mouthPivotY)*mouthOpen,height:rect.height*mouthOpen};
      }
      if(l.tags.includes('eye')) {
        if(states.blink)v=l.tags.includes('closed');
        else if(states.eyeOpen!==undefined&&!l.tags.includes('closed'))rect={...rect,top:717*headTransform.scaleY+(rect.top-717*headTransform.scaleY)*states.eyeOpen,height:rect.height*states.eyeOpen};
      }
      return {...l,rect,visible:v};
    });
    const frame=headOnly?{left:headTransform.left,top:0,width:headTransform.scaleX*1254,height:headTransform.scaleY*1254}:{left:offset,top:0,width:body.width*k,height:800};
    const im=composite({width,height},await Promise.all(visible.map(async l=>({image:decodePng(await readFile(path.join(directory,l.image.path))),visible:l.visible,rect:{left:(l.rect.left-frame.left)/frame.width*width,top:(l.rect.top-frame.top)/frame.height*height,width:l.rect.width/frame.width*width,height:l.rect.height/frame.height*height}}))));
    return encodePng(im);
  };
  if(!eyePreviewsOnly)await writeFile(path.join(directory,'default-fullbody-2160x3840.png'),await render(2160,3840));
  await writeFile(path.join(directory,'default-head-native.png'),await render(1254,1254,true));
  if(!eyePreviewsOnly)await writeFile(path.join(directory,'open-mouth-head-native.png'),await render(1254,1254,true,{mouth:true}));
  if(!eyePreviewsOnly)await writeFile(path.join(directory,'half-open-mouth-head-native.png'),await render(1254,1254,true,{mouthOpen:.5}));
  await writeFile(path.join(directory,'mouth-037-head-native.png'),await render(1254,1254,true,{mouthOpen:.37}));
  if(!eyePreviewsOnly)await writeFile(path.join(directory,'mouth-080-head-native.png'),await render(1254,1254,true,{mouthOpen:.8}));
  await writeFile(path.join(directory,'half-closed-eyes-head-native.png'),await render(1254,1254,true,{eyeOpen:.5}));
  if(sources.blink)await writeFile(path.join(directory,'closed-eyes-head-native.png'),await render(1254,1254,true,{blink:true}));
  return {manifest,layout};
}
