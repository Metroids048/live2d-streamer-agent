import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fail} from './rpc.mjs';
import {singleImageSources} from './pipeline/delivery.mjs';
import {g1PreviewSources} from './pipeline/g1-preview.mjs';
import {completedCandidateSources} from './pipeline/completed-candidate.mjs';
import {attachmentLimitForRevision, LOCAL_ATTACHMENT_MAX_BYTES as cap} from './packaging/distribution.mjs';

const exec=promisify(execFile);
export async function deliverStagePreview(maker,id,ctx,saveMediaBuffer) {
  await maker.making(id,ctx);
  return maker.store.lock(async()=>{
    const job=await maker.store.read('make-'+id),expected=path.join(maker.root,'openclaw-workspace','outputs',id);
    if(job.output!==expected||await fs.realpath(expected)!==expected)fail('OUTPUT_MISMATCH','预览输出不属于本任务');
    const {bundle,sources,manifest}=await g1PreviewSources(job),attachments=[];
    const receipts=job.stagePreviewDelivery?.manifestSha256===manifest.sha256?job.stagePreviewDelivery.attachments??[]:[];
    async function matches(receipt,source){
      if(!receipt?.path||!path.isAbsolute(receipt.path))return false;
      try{
        const stat=await fs.lstat(receipt.path);
        return stat.isFile()&&stat.size===source.artifact.bytes&&
          createHash('sha256').update(await fs.readFile(receipt.path)).digest('hex')===source.artifact.sha256;
      }catch{return false;}
    }
    for(const source of sources){
      if(source.artifact.bytes>cap)fail('DELIVERY_TOO_LARGE','G1单个媒体超过交付限制');
      const buffer=await fs.readFile(source.file);
      if(buffer.length!==source.artifact.bytes||createHash('sha256').update(buffer).digest('hex')!==source.artifact.sha256)
        fail('INVALID_ARTIFACT','G1预览附件在发布前发生变化');
      const previous=receipts.find(a=>a.name===source.name&&a.sha256===source.artifact.sha256);
      const saved=await matches(previous,source)?previous:
        await saveMediaBuffer(buffer,source.mime,'live2d-streamer',cap,source.name,source.file);
      if(!await matches(saved,source))fail('MEDIA_STORE_MISMATCH','预览媒体存储回读不一致');
      attachments.push({name:source.name,path:saved.path,size:source.artifact.bytes,sha256:source.artifact.sha256,source:source.file});
      job.stagePreviewDelivery={stage:'g1',revision:bundle.revision,parentRevision:bundle.parentRevision,
        manifestSha256:manifest.sha256,attachments,at:new Date().toISOString(),notice:bundle.notice};
      await maker.store.write('make-'+id,job);
    }
    return {ok:true,id,stagePreview:'g1',revision:bundle.revision,status:job.status,attachments,
      notice:bundle.notice+' 使用 MEDIA: 后跟附件 path 向当前会话交付。'};
  });
}
// Deliberately separate publication from the read-only job query.
export async function deliver(maker,id,ctx,saveMediaBuffer) {
  await maker.making(id,ctx); // checks both job identity and owning conversation
  return maker.store.lock(async()=>{
    const job=await maker.store.read('make-'+id);
    const expected=path.join(maker.root,'openclaw-workspace','outputs',id);
    if(job.status!=='completed') {
      const visual=job.pipeline?.packaging?.finalPreviewReview;
      if(visual&&visual.status!=='passed')
        fail(visual.status==='failed'?'DELIVERY_VISUAL_HOLD':'DELIVERY_VISUAL_PENDING','当前候选的最终成片尚未通过视觉验收');
      let hasCandidate=false;
      if(job.kind==='single_image')try{await fs.lstat(path.join(expected,'completed-candidate-current.json'));hasCandidate=true;}catch(e){if(e.code!=='ENOENT')throw e;}
      if(!hasCandidate)fail('NOT_COMPLETED','原制作尚未完成，不能发布成品附件');
    }
    const revised=job.kind==='single_image'&&job.status==='completed'&&
      Number.isSafeInteger(job.revision)&&Number.isSafeInteger(job.parentRevision)&&
      job.parentRevision>=1&&job.parentRevision<job.revision&&
      job.output===path.join(expected,'revisions','r'+String(job.revision).padStart(4,'0'));
    const mediaLimit=revised?attachmentLimitForRevision(job):cap;
    if(job.output!==expected&&!revised) fail('OUTPUT_MISMATCH','制作输出不属于当前工程');
    const root=await fs.realpath(job.output);
    if(root!==job.output) fail('OUTPUT_MISMATCH','制作输出目录不能指向其他位置');
    async function regular(relative) {
      const file=path.join(root,relative),stat=await fs.lstat(file);
      if(!stat.isFile() || (await fs.realpath(file))!==file || stat.size>cap) fail('INVALID_ARTIFACT','附件不是本任务的普通文件或过大');
      return file;
    }
    const candidate=job.kind==='single_image'&&!revised?await completedCandidateSources(job):null;
    if(!candidate&&job.status!=='completed')fail('NOT_COMPLETED','原制作尚未完成，不能发布成品附件');
    if(job.kind==='single_image') {
      const hold=await maker.store.read('delivery-hold-'+id);
      const revision=candidate?.bundle.revision??job.revision;
      if(hold?.taskId===job.id&&hold.candidateId===job.candidateId&&hold.revision===revision)
        fail(hold.pending?'DELIVERY_VISUAL_PENDING':'DELIVERY_VISUAL_HOLD',hold.reason);
    }
    let sources,archive,notice,volumeGuide;
    if(candidate) {
      ({sources,archive,notice}=candidate);
    } else if(job.kind==='single_image') {
      ({sources,archive,notice,volumeGuide}=await singleImageSources(job,root,mediaLimit,{preferComplete:mediaLimit>cap}));
    } else {
    const modelFiles=[];
    async function walk(relative) {
      if(await fs.realpath(path.join(root,relative))!==path.join(root,relative)) fail('INVALID_ARTIFACT','模型目录不能指向外部');
      for(const entry of await fs.readdir(path.join(root,relative),{withFileTypes:true})) {
        const next=path.join(relative,entry.name);
        if(entry.isDirectory()) {
          if(await fs.realpath(path.join(root,next))!==path.join(root,next)) fail('INVALID_ARTIFACT','模型目录不能指向外部');
          await walk(next);
        } else {await regular(next);modelFiles.push(next);}
      }
    }
    await walk('model');
    const video='preview/半身制作预览-6秒.mp4',cover='preview/半身预览.png';
    for(const file of ['角色.psd2live',video,cover]) await regular(file);
    const readme=`# 白发绿眼角色：制作候选\n\n任务：${id}\n\n来源：PSD2Live Examples tml 1.0.0（CC0-1.0）\nhttps://github.com/tsunehimatoi/psd2live-examples/tree/main/cases/tml\n输入 SHA256：${job.source.sha256}\n制作：PSD2Live v3.6.7，固定提交 bfadd8343774d5b6208146060c4fa175d84a0f4f。\n引擎按其 GPL-3.0 等模块许可，本包不含引擎二进制。\n\n## 使用\n1. 用 PSD2Live v3.6.7 打开「角色.psd2live」继续编辑。\n2. model 为本轮新导出；包含 model3.json、moc3、纹理、物理、动作、四个表情及 cmo3/can3。\n3. VTube Studio：将整个 model 目录复制到其 Live2DModels 中，重新启动后选择 tml。VTS 尚未实际重载验收；若载入失败保留原候选并提供具体报错。\n4. 表情顺序：微笑、悲伤、生气、惊讶；实际文件为 tml.smile/sad/angry/surprised.exp3.json。未设置 VTS 热键，不能把建议按键当成已配置。\n5. preview 中为六秒、24fps 半身制作动画；无音轨，并非真人跟踪实录。\n\n## 验证边界\n模型引用与文件头检查已通过；PSD2Live 工程可以重新打开。VTS 重载、摄像头口型/眨眼/转头、表情回读与恢复、OBS/B站画面及麦克风仍待实际验收。用户尚未认可美术效果。此 CC0 示例与用户图片定制分开交付。\n`;
    const readmeFile=path.join(root,'使用与来源.md');
    let previousReadme;try {previousReadme=await fs.readFile(readmeFile,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
    if(previousReadme!==readme) await fs.writeFile(readmeFile,readme);
    const members=['角色.psd2live','使用与来源.md',video,cover,...modelFiles];
    archive=path.join(root,'白发绿眼角色-制作候选.zip');const tmp=path.join(root,'.delivery-'+randomUUID()+'.zip');
    try {
      await exec('/usr/bin/zip',['-q','-X',tmp,...members],{cwd:root,maxBuffer:1024*1024});
      if((await fs.stat(tmp)).size>cap) fail('DELIVERY_TOO_LARGE','模型包超过交付限制');
      await fs.rename(tmp,archive);
    } finally {await fs.rm(tmp,{force:true});}
    sources=[{file:await regular(video),mime:'video/mp4',name:'半身制作预览-6秒.mp4'},
      {file:await regular(cover),mime:'image/png',name:'半身预览.png'},
      {file:archive,mime:'application/zip',name:'白发绿眼角色-制作候选.zip'}];
    notice='制作动画，无音轨；VTS 和真人跟踪尚未验收。';
    }
    const attachments=[],mediaSteps=[],candidateKey=candidate?.manifest.sha256;
    const candidateReceipt=candidateKey?(job.completedCandidateDeliveries?.[candidateKey]??
      (job.completedCandidateDelivery?.manifestSha256===candidateKey?job.completedCandidateDelivery:null)):null;
    const receipts=candidate?(candidateReceipt?.attachments??[]):[...(job.deliveryProgress??[]),...(job.delivery?.attachments??[])];
    const saveCandidate=async status=>{
      const receipt={status,revision:candidate.bundle.revision,parentRevision:candidate.bundle.parentRevision,
        manifestSha256:candidateKey,archive,attachments:[...attachments],mediaSteps:[...mediaSteps],at:new Date().toISOString()};
      job.completedCandidateDeliveries={...(job.completedCandidateDeliveries??{}),[candidateKey]:receipt};
      job.completedCandidateDelivery=receipt;await maker.store.write('make-'+id,job);
    };
    async function matchesReceipt(receipt,sha256,size) {
      if(!receipt?.path||!path.isAbsolute(receipt.path))return false;
      try {
        const stat=await fs.lstat(receipt.path);
        return stat.isFile()&&stat.size===size&&
          createHash('sha256').update(await fs.readFile(receipt.path)).digest('hex')===sha256;
      }catch{return false;}
    }
    for(const source of sources) {
      await candidate?.assertUnchanged();
      const buffer=await fs.readFile(source.file),sha256=createHash('sha256').update(buffer).digest('hex');
      if(source.artifact&&(sha256!==source.artifact.sha256||buffer.length!==source.artifact.bytes))
        fail('INVALID_ARTIFACT','本候选附件在发布前发生变化');
      const old=receipts.find(a=>a.sha256===sha256 && a.name===source.name);
      const cached=await matchesReceipt(old,sha256,buffer.length);
      const mediaStart=new Date().toISOString(),mediaTick=performance.now();
      const saved=cached?old:await saveMediaBuffer(buffer,source.mime,'live2d-streamer',mediaLimit,source.name,source.file);
      if(!cached&&!await matchesReceipt(saved,sha256,buffer.length))fail('MEDIA_STORE_MISMATCH','媒体存储回读与本候选的附件不一致');
      attachments.push({name:source.name,path:saved.path,size:buffer.length,sha256,source:source.file});
      mediaSteps.push({name:source.name,reused:cached,startedAt:mediaStart,finishedAt:new Date().toISOString(),elapsedMs:Math.round(performance.now()-mediaTick)});
      if(candidate)await saveCandidate('publishing');
      else if(!cached) {
        job.deliveryProgress=[...attachments];await maker.store.write('make-'+id,job);
      }
    }
    if(candidate) {
      await candidate.assertUnchanged();await saveCandidate('published');
      return {ok:true,id,revision:candidate.bundle.revision,parentRevision:candidate.bundle.parentRevision,status:candidate.bundle.status,
        attachments,archive,notice:notice+' 使用 MEDIA: 后跟附件 path 向当前会话交付。'};
    }
    delete job.deliveryProgress;
    job.delivery={at:new Date().toISOString(),archive,attachments,mediaSteps};
    await maker.store.write('make-'+id,job);
    await fs.writeFile(path.join(root,'附件交付.json'),JSON.stringify(job.delivery,null,2)+'\n');
    return {ok:true,id,attachments,archive,...(volumeGuide?{volumeGuide}:{}),
      notice:[notice,volumeGuide,'使用 MEDIA: 后跟附件 path 向当前会话交付。'].filter(Boolean).join(' ')};
  });
}
