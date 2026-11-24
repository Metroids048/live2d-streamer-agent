// Operator-only recovery. Never expose this ownership change to a chat tool.
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ROOT} from '../src/controller.mjs';
import {Store} from '../src/store.mjs';
import {alive,Maker} from '../src/maker.mjs';
import {safePath,sha256,readJson,writeBound,writeJson} from '../src/artwork/files.mjs';
import {loadLocalArtwork,LOCAL_ARTWORK_MANIFEST} from '../src/artwork/local-artwork.mjs';
import {correctionOperation} from '../src/pipeline/flash-correction.mjs';

const [proofPath,layoutDir,materialsPath]=process.argv.slice(2);
const json=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const proof=await json(proofPath);
const materials=await json(materialsPath);
const id=proof.id;
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const sessionKey=proof.sessionKey;
if(![id,proof.originalSessionId,proof.parentCandidateId].every(i=>uuid.test(i??''))||
  !sessionKey?.startsWith('agent:live2d-streamer:dashboard:')||!uuid.test(sessionKey.split(':').at(-1)))throw new Error('恢复证据身份无效');
const sessions=path.join(os.homedir(),'.openclaw/agents/live2d-streamer/sessions');
const activeSession=async()=>(await json(path.join(sessions,'sessions.json')))[sessionKey]?.sessionId;
const currentSessionId=await activeSession();
if(!uuid.test(currentSessionId??'')||currentSessionId===proof.originalSessionId)throw new Error('未核实会话 rollover');
const files=(await fs.readdir(sessions)).filter(f=>f.startsWith(proof.originalSessionId+'.jsonl.reset.'));
if(files.length!==1)throw new Error('旧会话归档不唯一');
const archive=(await fs.readFile(path.join(sessions,files[0]),'utf8')).trim().split('\n').map(l=>JSON.parse(l));
const originals=archive.filter(e=>e.id===proof.originalMessageEntryId&&e.message?.role==='user');
if(archive[0]?.type!=='session'||archive[0].id!==proof.originalSessionId||originals.length!==1)throw new Error('未找到唯一原消息');
const original=originals[0], {content,MediaPath,MediaPaths}=original.message;
if(typeof content!=='string'||typeof MediaPath!=='string'||MediaPaths?.length!==1||MediaPath!==MediaPaths[0]||
  sha256(content)!==proof.originalDescriptionSha256||sha256(await fs.readFile(MediaPath))!==proof.originalInputSha256)throw new Error('原图或原话未通过校验');
const store=new Store(ROOT);
await store.lock(async()=>{
  const job=await store.read('make-'+id),active=await store.read('maker-active');
  if(!job||job.kind!=='single_image'||job.id!==id||job.candidateId!==proof.parentCandidateId||job.revision!==proof.parentRevision||
    job.output!==path.join(ROOT,'openclaw-workspace','outputs',id)||job.sessionContext?.sessionKey!==sessionKey||
    job.sessionContext?.sessionId!==proof.originalSessionId||job.session!==store.session(job.sessionContext)||
    job.request?.description!==content||job.localArtwork||job.status!=='blocked'||job.stage!=='artwork'||
    job.error?.code!=='FLASH_UPLOAD_CONSENT_REQUIRED'||job.pending||job.pid&&alive(job.pid)||await store.read('engine-lease')||
    active?.id&&active.id!==id&&!await new Maker(ROOT).mayYield(await store.read('make-'+active.id)))throw new Error('任务身份或调度状态已变化，保留现场');
  if(await readJson(job.output,'artwork/operation.json')||await readJson(job.output,correctionOperation))
    throw new Error('已有素材后台回执，保留原作业');
  const input=await readJson(job.output,'intake/stage.json');
  if(input?.status!=='completed'||input.inputSha256!==proof.originalInputSha256||input.descriptionSha256!==proof.originalDescriptionSha256||
    sha256(await fs.readFile(await safePath(job.output,'intake/source.png')))!==input.inputSha256||
    sha256(await fs.readFile(await safePath(job.output,input.sourceImage.path)))!==input.sourceImage.sha256)
    throw new Error('原输入缓存已变化');
  const [layout,report]=await Promise.all(['layout.json','source-report.json'].map(async f=>json(await safePath(layoutDir,f))));
  if(report.sourceSha256!==input.inputSha256||Object.keys(materials).length!==layout.layers.length)throw new Error('本地拆层来源或标签不匹配');
  const [left,top,right,bottom]=report.sourceCrop;
  const parts=[];
  for(const l of layout.layers){
    if(!/^[a-z0-9-]+$/.test(l.id)||!materials[l.id]||!Array.isArray(materials[l.id].tags))throw new Error('没有登记实际图层语义：'+l.id);
    const png=await fs.readFile(await safePath(layoutDir,l.image.path));
    await writeBound(job.output,'local-artwork/parts/'+l.id+'.png',png);
    const {id,name,group,rect,visible,opacity}=l;
    const {tags,origin,variant}=materials[id];
    parts.push({id,name,group,rect,visible,opacity,tags,origin,...(variant?{variant}:{}),sha256:sha256(png)});
  }
  const manifest={schemaVersion:1,taskId:id,candidateId:job.candidateId,revision:job.revision,inputSha256:input.inputSha256,
    normalizedSha256:input.sourceImage.sha256,descriptionSha256:input.descriptionSha256,canvas:layout.canvas,
    sourceCrop:{left,top,width:right-left,height:bottom-top},parts};
  await writeJson(job.output,LOCAL_ARTWORK_MANIFEST,manifest);
  const localArtwork={manifestSha256:sha256(await fs.readFile(await safePath(job.output,LOCAL_ARTWORK_MANIFEST)))};
  await loadLocalArtwork(job.output,localArtwork,input);
  if(await activeSession()!==currentSessionId)throw new Error('操作期间当前会话又发生变更');
  const backup=path.join(store.dir,'make-'+id+'.before-local-artwork.json');
  await fs.writeFile(backup,JSON.stringify(job,null,2)+'\n',{flag:'wx',mode:0o600});
  const sessionRecovery={from:proof.originalSessionId,to:currentSessionId,sessionKey,originalMessageEntryId:original.id,
    originalMessageAt:original.timestamp,inputSha256:input.inputSha256,descriptionSha256:input.descriptionSha256,recoveredAt:new Date().toISOString()};
  // Keep the old sessionContext: intake uses it to resolve the archived attachment.
  await store.write('make-'+id,{...job,session:store.session({sessionKey,sessionId:currentSessionId}),localArtwork,sessionRecovery});
  console.log(JSON.stringify({taskId:id,candidateId:job.candidateId,revision:job.revision,sessionRecovery,localArtwork,backup}));
});
