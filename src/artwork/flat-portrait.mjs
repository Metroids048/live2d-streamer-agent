import * as fs from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import path from 'node:path';
import {loadLocalArtwork,LOCAL_ARTWORK_MANIFEST} from './local-artwork.mjs';
import {readJson,safePath,sha256,writeBound,writeJson} from './files.mjs';

const exec=promisify(execFile),script=fileURLToPath(new URL('flat-portrait.py',import.meta.url));
const localPhrase='请全程在本机制作';
export const wantsFlatPortrait=description=>description?.includes(localPhrase)&&description.includes('色块插画');
const profile={continuousWave:true,noLowerLash:['left','right'],
  basis:'从上传的透明色块插画按色域、眼口形态和袖管截面计算区域；眼形没有独立下睫线。'};
const textSupport=new Map([
  ['请把这张色块插画做成半身直播角色',['framing']],
  ['保留原来的头发和服装',[]],['能转头、眨眼、看向两侧、张嘴说话和闭嘴',[]],
  ['给我微笑和惊讶两个表情',['expressions']],['抬手挥一挥，再放下回原位',['wave']],
  ['给我 VTubeLeaf 1.3.1 可以导入的模型、可重开的工程和分层 PSD，再加一段预览和导入说明',[]],
  ['图片是这次原创的，我允许使用和修改，也允许交付制作文件',[]],
  [localPhrase,[]],
]);

export function flatPortraitIntake(taskRoot) {
  const describeImage=async request=>{
    const {description,inputSha256,descriptionSha256,taskId,candidateId,revision,image}=request;
    const identity={taskId,candidateId,revision,inputSha256,descriptionSha256,normalizedSha256:image.sha256};
    const processorSha256=sha256(await fs.readFile(script));
    const clauses=description.trim().split(/[。！]/).map(s=>s.trim()).filter(Boolean);
    const unsupported=clauses.filter(s=>!textSupport.has(s)).map(quote=>({request:quote,quote,reason:'本地色块配方尚不能安全解释这句要求'}));
    const match=key=>clauses.find(s=>textSupport.get(s)?.includes(key));
    const tagged=(data,quote)=>({...data,source:quote?'user':'default',quote:quote??''});
    const result={schemaVersion:1,inputSha256,descriptionSha256,originalDescription:description,
      imageObservation:{framing:'unknown',characterCount:0,appearance:[],visibleParts:[],occludedParts:[],uncertainties:[],materialRegions:[]},
      intent:{framing:tagged({value:match('framing')?'half_body':'preserve_source'},match('framing')),preserve:[],appearanceChanges:[],
        headMotion:tagged({yawDegrees:15,pitchDegrees:10,rollDegrees:10}),eyes:tagged({blink:true,gaze:true}),mouth:tagged({speech:true,closeOnSilence:true,shapes:[]}),
        expressions:match('expressions')?[tagged({id:'smile',label:'微笑'},'微笑'),tagged({id:'surprise',label:'惊讶'},'惊讶')]:[],
        actions:match('wave')?[tagged({id:'wave',label:'抬手挥一挥'},'抬手挥一挥')]:[],clothingVariants:[],targetRuntimes:[],deliverables:[]},
      inferences:[],unresolved:[],unsupported};
    if(unsupported.length)return result;
    let cache=await readJson(taskRoot,LOCAL_ARTWORK_MANIFEST);
    if(cache&&Object.entries(identity).some(([k,v])=>cache[k]!==v))throw Error('本地缓存与当前图文不一致');
    if(!cache){
      const temp=await fs.mkdtemp(path.join(taskRoot,'flat-portrait-'));
      try {
        let data;
        try {
          const output=await exec('/usr/bin/python3',[script,image.path,temp],{timeout:30000,signal:request.signal,maxBuffer:65536});
          data=JSON.parse(output.stdout);
        } catch(e) {
          const detail=e.stderr?.trim().split('\n').at(-1);
          result.unresolved.push({code:'LOCAL_FLAT_PORTRAIT_UNSUPPORTED',question:detail||'本机无法完成色块分离，请核对输入和 Pillow/NumPy。',quote:''});
          return result;
        }
        const parts=[];
        for(const p of data.parts){
          const png=await fs.readFile(path.join(temp,p.id+'.png'));
          await writeBound(taskRoot,'local-artwork/parts/'+p.id+'.png',png);
          parts.push({...p,sha256:sha256(png)});
        }
        cache={schemaVersion:1,...identity,canvas:data.canvas,sourceCrop:{left:0,top:0,...data.canvas},
          parts,productionProfile:profile,flatPortrait:{processorSha256,regions:data.regions,anchors:data.anchors}};
        await writeJson(taskRoot,LOCAL_ARTWORK_MANIFEST,cache);
      } finally {await fs.rm(temp,{recursive:true,force:true});}
    }
    result.imageObservation={framing:'half_body',characterCount:1,appearance:[],
      visibleParts:['色块脸部','双眼','嘴','前后发','衣身','单侧完整袖臂'],occludedParts:['额头底色','虹膜下眼白','袖下衣料'],
      uncertainties:[],materialRegions:cache.flatPortrait.regions};
    result.inferences.push(tagged({region:'遮挡区',proposal:'用相邻原图色块填补额头、眼白及袖下衣料，闭眼线和闭口线按可见边缘生成。',
      changesIdentity:false,accepted:false}));
    return result;
  };
  return {describeImage,recoverDescription:async request=>({status:'completed',response:await describeImage(request)})};
}

export async function loadFlatPortrait(taskRoot,input){
  const bytes=await fs.readFile(await safePath(taskRoot,LOCAL_ARTWORK_MANIFEST));
  const marker={manifestSha256:sha256(bytes)};
  const {flatPortrait}=JSON.parse(bytes);
  if(!flatPortrait?.processorSha256)throw Error('缺少自动分层处理器来源');
  const backend=await loadLocalArtwork(taskRoot,marker,input);
  return {...backend,modelVersion:'flat-portrait-1',recipe:{...backend.recipe,processorSha256:flatPortrait.processorSha256},marker};
}
