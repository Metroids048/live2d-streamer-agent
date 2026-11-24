import {readFile} from 'node:fs/promises';
import {safePath, sha256} from './files.mjs';
import {composite, cropPng, decodePng} from './png.mjs';

export const LOCAL_ARTWORK_ID='local-layer-layout';
export const LOCAL_ARTWORK_MANIFEST='local-artwork/manifest.json';

export async function loadLocalArtwork(taskRoot, marker, input) {
  const bytes=await readFile(await safePath(taskRoot,LOCAL_ARTWORK_MANIFEST));
  const digest=sha256(bytes);
  if(digest!==marker.manifestSha256)throw new Error('本地拆层清单哈希已变化');
  const m=JSON.parse(bytes);
  const expected={taskId:input.taskId,candidateId:input.candidateId,revision:input.revision,
    inputSha256:input.inputSha256,descriptionSha256:input.descriptionSha256,normalizedSha256:input.sourceImage.sha256};
  if(m.schemaVersion!==1||Object.entries(expected).some(([k,v])=>v==null||m[k]!==v))throw new Error('本地拆层与原任务、原图或原话不匹配');
  if(!Array.isArray(m.parts)||m.parts.length<1||m.parts.length>128)throw new Error('本地拆层数量无效');
  const parts=await Promise.all(m.parts.map(async ({sha256:expectedHash,...p})=>{
    if(!/^[a-z0-9-]+$/.test(p.id))throw new Error('本地拆层 ID 无效');
    const png=await readFile(await safePath(taskRoot,'local-artwork/parts/'+p.id+'.png'));
    if(sha256(png)!==expectedHash)throw new Error('本地拆层像素哈希已变化：'+p.id);
    return {...p,png};
  }));
  const sourceBytes=await readFile(await safePath(taskRoot,'input/source.png'));
  if(sha256(sourceBytes)!==input.inputSha256)throw new Error('原图已变化');
  const source=decodePng(sourceBytes),{left,top,width,height}=m.sourceCrop??{};
  const {width:canvasWidth,height:canvasHeight}=m.canvas??{};
  const {left:placedLeft,top:placedTop}=m.sourcePlacement??{left:0,top:0};
  if(![left,top,width,height,placedLeft,placedTop,canvasWidth,canvasHeight].every(Number.isInteger)||
    left<0||top<0||placedLeft<0||placedTop<0||placedLeft+width>canvasWidth||placedTop+height>canvasHeight||
    (!m.sourcePlacement&&(width!==canvasWidth||height!==canvasHeight))||
    width<1||height<1||left+width>source.width||top+height>source.height)throw new Error('本地拆层裁切区域无效');
  const neutral=composite(m.canvas,parts.map(({png,...p})=>({...p,image:decodePng(png)})));
  const crop=cropPng(source,m.sourceCrop);
  // RGB below transparent pixels is undefined; compare the visible RGBA.
  const visibleBytes=im=>{const b=Buffer.from(im.data);for(let i=0;i<b.length;i+=4)if(b[i+3]===0)b.fill(0,i,i+3);return b;};
  const rendered=visibleBytes(neutral),original=visibleBytes(m.sourcePlacement
    ?composite(m.canvas,[{image:crop,rect:{left:placedLeft,top:placedTop,width,height}}]):crop);
  let opaqueDitherPixels=0;
  if(!rendered.equals(original)) {
    if(!m.animePortrait?.processorSha256)throw new Error('本地拆层的中立合成与原图裁切不一致');
    const sourceHasFullAlpha=original.some((value,index)=>index%4===3&&value===255);
    const enclosedAlpha=i=>{
      if(sourceHasFullAlpha)return original[i+3]===254;
      const x=(i/4)%canvasWidth,y=Math.floor(i/4/canvasWidth);
      if(x<2||x>=canvasWidth-2||y<2||y>=canvasHeight-2)return false;
      for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++)
        if(original[i+4*(dy*canvasWidth+dx)+3]<240)return false;
      return true;
    };
    for(let i=0;i<original.length;i+=4) {
      if(original[i]!==rendered[i]||original[i+1]!==rendered[i+1]||original[i+2]!==rendered[i+2]||
        original[i+3]!==rendered[i+3]&&!(rendered[i+3]===255&&enclosedAlpha(i)))
        throw new Error('本地拆层改变了可见原图颜色或边缘透明度');
      if(original[i+3]!==rendered[i+3])opaqueDitherPixels++;
    }
  }
  const jobId='local-'+digest;
  const normalizedBytes=await readFile(await safePath(taskRoot,input.sourceImage.path));
  if(sha256(normalizedBytes)!==input.sourceImage.sha256)throw new Error('规范化输入已变化');
  const normalized=decodePng(normalizedBytes);
  const registered=normalized.width===source.width&&normalized.height===source.height&&
    visibleBytes(cropPng(normalized,m.sourceCrop)).equals(visibleBytes(crop));
  const profile=m.productionProfile;
  if(profile!==undefined&&(!profile||typeof profile.continuousWave!=='boolean'||
    !Array.isArray(profile.noLowerLash)||new Set(profile.noLowerLash).size!==profile.noLowerLash.length||
    !profile.noLowerLash.every(side=>['left','right'].includes(side))||
    typeof profile.basis!=='string'||!profile.basis.trim()||profile.basis.length>400))
    throw new Error('本地制作配方缺少可审查的原画依据');
  const result={canvas:m.canvas,parts,quality:{originalCropMatch:true,sourceCrop:m.sourceCrop,opaqueDitherPixels,
    sourceSha256:m.inputSha256,manifestSha256:digest,...(profile?{productionProfile:profile}:{}),...(registered?{sourceCanvasMapping:{method:'source-pixels',verified:true,
      normalizedSha256:m.normalizedSha256,crop:m.sourceCrop,...(m.sourcePlacement?{placement:m.sourcePlacement}:{})}}:{})}};
  const completed={status:'completed',jobId,result};
  return {id:LOCAL_ARTWORK_ID,version:'1',modelVersion:'local-pixels',productionProfile:profile,recipe:{manifestSha256:digest,...(profile?{productionProfile:profile}:{})},
    submit:async()=>completed,recover:async()=>completed,query:async id=>id===jobId?completed:{status:'blocked',code:'LOCAL_ARTWORK_RECEIPT_MISMATCH'}};
}
