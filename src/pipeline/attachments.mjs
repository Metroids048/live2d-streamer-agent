import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Store} from '../store.mjs';
import {fail} from '../rpc.mjs';

const MAX_IMAGE_BYTES=16*1024*1024;
const sha=b=>createHash('sha256').update(b).digest('hex');
export class ImageInbox {
  constructor(root) {this.root=root;this.store=new Store(root);}
  // Accept only the latest user message's typed ImageContent. The Codex harness
  // can omit current messages from before_prompt_build, so avatar_inputs also
  // reads them through the scoped SDK transcript facade.
  async capture(messages,ctx,nativeDescription) {
    if(ctx.agentId!=='live2d-streamer'||!ctx.sessionKey||!ctx.sessionId)return [];
    const session=this.store.session(ctx),registered=[];
    const latest=[...(messages??[])].reverse().find(m=>m?.role==='user');
    const blocks=Array.isArray(latest?.content)?latest.content:[];
    for(const block of blocks) {
      if(block.type!=='image'||!['image/png','image/jpeg'].includes(block.mimeType)||typeof block.data!=='string')continue;
      if(block.data.length>Math.ceil(MAX_IMAGE_BYTES*4/3)+4)continue;
      if(!/^[A-Za-z0-9+/]*={0,2}$/.test(block.data))continue;
      const bytes=Buffer.from(block.data,'base64');
      if(!bytes.length||bytes.length>MAX_IMAGE_BYTES||bytes.toString('base64')!==block.data)continue;
      const hash=sha(bytes),ref='img-'+sha(session+':'+hash).slice(0,40);
      const dir=path.join(this.root,'.local','image-inbox',session);
      await fs.mkdir(dir,{recursive:true,mode:0o700});
      if(await fs.realpath(dir)!==dir)fail('INPUT_INVALID','图片缓存目录包含链接');
      const file=path.join(dir,hash+(block.mimeType==='image/png'?'.png':'.jpg'));
      try {await fs.writeFile(file,bytes,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
      const existing=await fs.lstat(file);
      if(!existing.isFile()||await fs.realpath(file)!==file||existing.size!==bytes.length||sha(await fs.readFile(file))!==hash)fail('INPUT_CONFLICT','图片缓存内容已改变，保留原文件');
      const description=nativeDescription??(await this.store.read(ref))?.description;
      await this.store.write(ref,{session,path:file,mimeType:block.mimeType,sha256:hash,bytes:bytes.length,description,createdAt:new Date().toISOString()});
      registered.push({imageRef:ref,mimeType:block.mimeType,sha256:hash});
    }
    return registered;
  }
  async resolve(ref,ctx,taskRoot) {
    if(!/^img-[a-f0-9]{40}$/.test(ref??''))fail('INPUT_INVALID','请选择当前会话的真实图片附件');
    const record=await this.store.read(ref);
    if(!record||record.session!==this.store.session(ctx))fail('SESSION_MISMATCH','图片附件不属于当前会话');
    const inbox=await fs.realpath(path.join(this.root,'.local','image-inbox',record.session));
    const file=await fs.realpath(record.path),stat=await fs.lstat(record.path);
    if(!stat.isFile()||file!==record.path||!file.startsWith(inbox+path.sep)||stat.size>MAX_IMAGE_BYTES)fail('INPUT_INVALID','图片附件引用失效');
    const bytes=await fs.readFile(file);
    if(sha(bytes)!==record.sha256)fail('INPUT_INVALID','图片附件内容已改变');
    const base=await fs.realpath(this.root),task=await fs.realpath(taskRoot);
    if(task!==path.resolve(taskRoot)||!task.startsWith(base+path.sep))fail('INPUT_INVALID','任务目录不属于当前项目或包含链接');
    const target=path.join(task,'input');await fs.mkdir(target,{recursive:true});
    if(await fs.realpath(target)!==target||!(await fs.lstat(target)).isDirectory())fail('INPUT_INVALID','输入目录包含链接');
    const dest=path.join(target,'source'+(record.mimeType==='image/png'?'.png':'.jpg'));
    try {await fs.writeFile(dest,bytes,{flag:'wx',mode:0o600});}
    catch(e) {
      if(e.code!=='EEXIST')throw e;
      const stat=await fs.lstat(dest);
      if(!stat.isFile()||await fs.realpath(dest)!==dest||stat.size!==bytes.length||sha(await fs.readFile(dest))!==record.sha256)fail('INPUT_CONFLICT','该任务已有不同图片或链接，保留原输入，请创建新修订');
    }
    return {path:dest,mimeType:record.mimeType,sha256:record.sha256,source:'session_attachment',description:record.description};
  }
}

export async function captureSessionImages(inbox,ctx,readEvents,media={}) {
  if(ctx.agentId!=='live2d-streamer'||!ctx.sessionId||!ctx.sessionKey?.startsWith('agent:live2d-streamer:'))
    return {ok:false,code:'SESSION_REQUIRED',message:'图片附件需要当前角色完整会话身份'};
  let events;
  try {events=await readEvents({agentId:ctx.agentId,sessionKey:ctx.sessionKey,sessionId:ctx.sessionId});}
  catch {return {ok:false,code:'ATTACHMENTS_UNAVAILABLE',message:'当前会话附件暂不可读取；保留原输入，不猜测图片路径'};}
  if(!Array.isArray(events))return {ok:false,code:'ATTACHMENTS_UNAVAILABLE',message:'当前会话附件返回无效，保留原输入'};
  const messages=events.filter(e=>e?.type==='message'&&e.message?.role).map(e=>e.message);
  let images;
  try {
    const latest=[...messages].reverse().find(m=>m.role==='user');
    const content=Array.isArray(latest?.content)?[...latest.content]:[];
    // Native desktop transcripts carry attachment metadata beside string content.
    // Read only SDK-validated inbound media; never interpret paths in user text.
    const paths=Array.isArray(latest?.MediaPaths)&&latest.MediaPaths.length?latest.MediaPaths:latest?.MediaPath?[latest.MediaPath]:[];
    const types=Array.isArray(latest?.MediaTypes)&&latest.MediaTypes.length?latest.MediaTypes:latest?.MediaType?[latest.MediaType]:[];
    for(let i=0;i<paths.length;i++) {
      const file=paths[i],mimeType=types[i];
      if(!['image/png','image/jpeg'].includes(mimeType))continue;
      if(typeof file!=='string'||!path.isAbsolute(file)||path.normalize(file)!==file||!media.resolveMediaBufferPath||!media.readMediaBuffer)throw new Error('Unresolvable attachment');
      const id=path.basename(file),resolved=await media.resolveMediaBufferPath(id,'inbound');
      if(resolved!==file)throw new Error('Attachment outside media store');
      const stored=await media.readMediaBuffer(id,'inbound',MAX_IMAGE_BYTES);
      if(stored.path!==file||!Buffer.isBuffer(stored.buffer)||!stored.buffer.length||stored.buffer.length>MAX_IMAGE_BYTES||stored.size!==stored.buffer.length)throw new Error('Invalid media buffer');
      const data=stored.buffer.toString('base64');
      if(!content.some(b=>b.type==='image'&&b.mimeType===mimeType&&b.data===data))content.push({type:'image',mimeType,data});
    }
    const description=typeof latest?.content==='string'?latest.content:
      content.filter(block=>block.type==='text'&&typeof block.text==='string').map(block=>block.text).join('\n');
    images=await inbox.capture(latest?[{role:'user',content}]:[],ctx,description);
  }
  catch(e) {return {ok:false,code:e.code??'ATTACHMENTS_UNAVAILABLE',message:e.code?e.message:'当前会话图片登记失败，保留原输入'};}
  return {ok:true,images,message:images.length?'本轮图片已登记，imageRef 仅限当前会话；文件已接收不代表模型已制作。':'本轮用户消息没有可读取的PNG/JPEG图片，请保留已有任务，不使用旧图片代替。'};
}
