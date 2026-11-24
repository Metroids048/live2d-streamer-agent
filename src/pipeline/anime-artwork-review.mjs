import {execFile} from 'node:child_process';
import * as fs from 'node:fs/promises';
import {promisify} from 'node:util';
import {createCodexVision} from './codex-vision.mjs';
import {artifact,safePath,sha256,writeBound} from '../artwork/files.mjs';
import {decodePng} from '../artwork/png.mjs';
import {artworkReviewDescriptor,recordArtworkReview} from '../artwork/visual-review.mjs';
import {identityKeys} from './lease.mjs';

const exec=promisify(execFile);
export const makeSheet=String.raw`
import io,sys
from pathlib import Path
from PIL import Image,ImageDraw
groups=sys.argv[1:]
w,h=650,610
sheet=Image.new("RGB",(w*3,h*((len(groups)+2)//3)),"#272933")
draw=ImageDraw.Draw(sheet)
for i,file in enumerate(groups):
    im=Image.open(file).convert("RGBA")
    bbox=im.getbbox()
    if bbox: im=im.crop(bbox)
    im.thumbnail((w-18,h-43))
    x,y=i%3*w,i//3*h
    draw.text((x+12,y+10),str(i+1)+". "+Path(file).name, fill="#ffffff")
    sheet.paste(im,(x+(w-im.width)//2,y+29+(h-43-im.height)//2),im)
sheet.save(sys.stdout.buffer,format="PNG")
`;

export async function reviewAnimeArtwork(bundle,ctx) {
  const root=ctx.taskRoot;
  const identity=Object.fromEntries(identityKeys.map(k=>[k,bundle[k]]));
  const reviewCtx={...ctx,...identity};
  const {paths,criteria}=await artworkReviewDescriptor(bundle,reviewCtx,{checkAll:true});
  const files=[...new Set(Object.values(paths).flat())];
  const stageSha256=(await artifact(root,'artwork/stage.json','artwork_stage')).sha256;
  const operationKey='artwork-review-'+sha256(JSON.stringify({stageSha256,recipe:'codex-anime-static-1'}));
  const file='artwork/review-sheet-'+stageSha256+'.png';
  const target=await safePath(root,file,{mkdirParents:true});
  try {await fs.access(target);} catch(e) {
    if(e.code!=='ENOENT')throw e;
    const absolute=await Promise.all(files.map(f=>safePath(root,f)));
    const {stdout}=await exec('/usr/bin/python3',['-c',makeSheet,...absolute],
      {encoding:'buffer',timeout:25000,maxBuffer:20*1024*1024});
    await writeBound(root,file,stdout);
  }
  const bytes=await fs.readFile(target),{width,height}=decodePng(bytes);
  const vision=createCodexVision({taskRoot:root,scope:'artwork_review'});
  const answer=await vision.describeImage({...identity,operationKey,description:'',
    image:{path:target,sha256:sha256(bytes),width,height,mimeType:'image/png'},
    outputSchema:{type:'object',additionalProperties:false,required:['observations'],properties:{observations:{type:'array',
      items:{type:'object',additionalProperties:false,required:['criterion','status','note'],properties:{
        criterion:{type:'string',enum:criteria},status:{type:'string',enum:['passed','failed']},note:{type:'string'}}}}}},
    instructions:[
      'Judge only the supplied static artwork, never runtime or motion. Return exactly one observation per criterion and use specific visible evidence.',
      'Fail if the face changes identity, exposed regions show holes or residual old eye/mouth/hair, half blink exposes unrelated pixels, or the shoulder sleeve is disconnected or includes unrelated body pixels. Unclear evidence must fail. Allow minor drawing texture differences in reconstructed hidden pixels. Explain in Simplified Chinese.',
      'Use all listed tiles per criterion (1-indexed): '+JSON.stringify(Object.fromEntries(Object.entries(paths).map(([key,list])=>[key,list.map(f=>1+files.indexOf(f))]))),
      'The face comparison tile is original, neutral, bangs removed, half blink, open mouth, bangs moved, in row-major order.'
    ].join('\n')});
  if(!Array.isArray(answer.observations)||answer.observations.some(o=>!Object.hasOwn(paths,o.criterion)))throw Error('Codex 返回未登记的静态判读项');
  return recordArtworkReview(bundle,{id:'codex-anime-'+stageSha256.slice(0,16),
    reviewer:{kind:'model',name:'Codex 静态拆层审查'},stageSha256,
    observations:answer.observations.map(o=>({...o,from:0,to:0,evidencePaths:paths[o.criterion]}))},reviewCtx);
}
