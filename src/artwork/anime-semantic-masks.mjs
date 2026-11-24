import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {artifact,readJson,safePath,sha256,writeBound,writeJson} from './files.mjs';

const exec=promisify(execFile);
const script=fileURLToPath(new URL('anime-semantic-masks.py',import.meta.url));
const eyeScript=fileURLToPath(new URL('anime-eye-details.py',import.meta.url));
const checkpointSha256='dda82b916f6c340bc5a6c3a077ff1214f9906906abe3707b1076d55b508f253f';
const checkoutCommit='ed94d5fe4b1750b34ce73d2ffde1abbd1ef766cc';
// SHA256 over sorted relative paths and file hashes of the pinned commit.
// Native workers must not invoke git or require access to repository metadata.
const checkoutTreeSha256='e89c74c371f01074dd922d745be26367a77141f72fd014a823a70db3e446e4db';
const receiptPath='artwork/semantic-masks/receipt.json';

export async function animeModelTreeDigest(checkout) {
  const files=[];
  async function scan(relative='') {
    for(const entry of await fs.readdir(path.join(checkout,relative),{withFileTypes:true})) {
      if(!relative&&entry.name==='.git')continue;
      const name=relative?`${relative}/${entry.name}`:entry.name;
      if(entry.isDirectory())await scan(name);
      else if(entry.isFile())files.push(name);
      else throw Error('本机分割实现包含非普通文件：'+name);
    }
  }
  await scan();
  const hash=createHash('sha256');
  for(const file of files.sort())hash.update(`${file}\0${sha256(await fs.readFile(path.join(checkout,file)))}\n`);
  return hash.digest('hex');
}

export async function analyzeVisibleAnimeParts(root,taskRoot,input,{cacheOnly=false}={}) {
  const model=path.join(root,'.local/anime-part-model');
  const checkpoint=path.join(model,'checkpoint-18000.pt');
  const checkout=path.join(model,'paper-doll-studio');
  const identity={taskId:input.taskId,candidateId:input.candidateId,revision:input.revision,inputSha256:input.inputSha256,
    descriptionSha256:input.descriptionSha256,normalizedSha256:input.sourceImage.sha256,checkpointSha256,checkoutCommit,
    processorSha256:sha256(await fs.readFile(script))};
  const previous=await readJson(taskRoot,receiptPath);
  if(previous){
    if(Object.entries(identity).some(([key,value])=>previous[key]!==value))throw Error('本机分割回执与当前任务或处理器不匹配');
    for(const part of previous.parts){
      if((await artifact(taskRoot,part.path,'visible_semantic_mask')).sha256!==part.sha256)throw Error('已保存的部件像素变更');
    }
    return {...previous,cacheHit:true,receiptPath};
  }
  if(cacheOnly)throw Error('本机缓存回归缺少已登记语义分割，不重新推理');
  const source=await safePath(taskRoot,input.sourceImage.path);
  if(sha256(await fs.readFile(source))!==identity.normalizedSha256)throw Error('规范化图像已变更');
  const hash=createHash('sha256');
  for await(const bytes of createReadStream(checkpoint))hash.update(bytes);
  if(hash.digest('hex')!==checkpointSha256)throw Error('本机分割权重哈希不匹配');
  if(await animeModelTreeDigest(checkout)!==checkoutTreeSha256)throw Error('本机分割实现与固定版本不符');
  const temp=await fs.mkdtemp(path.join(taskRoot,'semantic-masks-'));
  try {
    const shared=path.join(os.homedir(),'Desktop/网页教程录制Agent/.local/local-model.lock');
    const lock=await fs.access(shared).then(()=>shared,()=>path.join(model,'local-model.lock'));
    const {stdout}=await exec(path.join(model,'venv-cached/bin/python'),[script,checkout,checkpoint,source,temp,lock],
      {timeout:360000,maxBuffer:128*1024,env:{...process.env,PYTORCH_ENABLE_MPS_FALLBACK:'1',PYTHONDONTWRITEBYTECODE:'1'}})
      .catch(e=>{throw Error('本机语义分割未完成：'+(e.killed?'分割或资源等待超时（360 秒）':
        String(e.stderr||e.signal||e.code||e.message).trim().slice(-650)),{cause:e});});
    const {canvas,parts}=JSON.parse(stdout);
    const verified=[];
    for(const part of parts){
      if(!/^[a-z]+$/.test(part.id))throw Error('本机分割返回无效部件 ID');
      const relative='artwork/semantic-masks/'+part.id+'.png';
      await writeBound(taskRoot,relative,await fs.readFile(path.join(temp,part.id+'.png')));
      verified.push({...part,...await artifact(taskRoot,relative,'visible_semantic_mask')});
    }
    const receipt={schemaVersion:1,...identity,checkoutTreeSha256,canvas,parts:verified,usableForBinding:false};
    await writeJson(taskRoot,receiptPath,receipt);
    return {...receipt,cacheHit:false,receiptPath};
  } finally {await fs.rm(temp,{recursive:true,force:true});}
}

export async function refineVisibleEyes(taskRoot,input,masks) {
  const eyes=masks.parts.find(part=>part.id==='eyes');
  if(!eyes)return null;
  const source=await safePath(taskRoot,input.sourceImage.path);
  if(sha256(await fs.readFile(source))!==masks.normalizedSha256||
    (await artifact(taskRoot,eyes.path,'visible_semantic_mask')).sha256!==eyes.sha256)throw Error('眼部来源与分割回执不匹配');
  const temp=await fs.mkdtemp(path.join(taskRoot,'eye-details-'));
  try {
    const {stdout}=await exec('/usr/bin/python3',[eyeScript,source,await safePath(taskRoot,eyes.path),temp],
      {timeout:10000,maxBuffer:65536,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
    const {regions,parts}=JSON.parse(stdout);
    const verified=[];
    for(const part of parts){
      if(!/^[a-z-]+$/.test(part.id))throw Error('眼部细分返回无效部件 ID');
      const relative='artwork/eye-details/'+part.id+'.png';
      await writeBound(taskRoot,relative,await fs.readFile(path.join(temp,part.id+'.png')));
      verified.push({...part,...await artifact(taskRoot,relative,'source_facial_detail')});
    }
    const receiptPath='artwork/eye-details/receipt.json';
    const receipt={taskId:input.taskId,candidateId:input.candidateId,revision:input.revision,
      normalizedSha256:masks.normalizedSha256,eyeMaskSha256:eyes.sha256,
      processorSha256:sha256(await fs.readFile(eyeScript)),
      regionProcessorSha256:sha256(await fs.readFile(new URL('anime_eye_regions.py',import.meta.url))),
      extractorSha256:sha256(await fs.readFile(new URL('facial_materials.py',import.meta.url))),
      regions,parts:verified};
    await writeJson(taskRoot,receiptPath,receipt);
    return {...receipt,receiptPath};
  } finally {await fs.rm(temp,{recursive:true,force:true});}
}
