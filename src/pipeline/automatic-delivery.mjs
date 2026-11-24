import * as fs from 'node:fs/promises';
import {alive} from '../maker.mjs';
import {deliver} from '../delivery.mjs';

const terminal=new Set(['completed','blocked','failed','needs_input','awaiting_external_result','outcome_unknown']);
const agentId='live2d-streamer';

export async function notifyAutomaticDelivery(maker,id,{append,saveMediaBuffer,config}) {
  const job=await maker.store.read('make-'+id);
  const ctx=job?.sessionContext;
  if(job?.id!==id||job.kind!=='single_image'||!job.notifyAutomatically||
    !ctx?.sessionId||!/^agent:live2d-streamer:dashboard:[a-z0-9-]+$/.test(ctx.sessionKey)||
    maker.store.session(ctx)!==job.session||!terminal.has(job.status)||job.pid&&alive(job.pid))return;
  const key='automatic-notice-'+id;
  const previous=await maker.store.read(key);
  const attempt=[job.revision,job.status,job.stage,job.error?.code??''].join(':');
  if(previous?.attempt===attempt)return;
  let text;
  if(job.status==='completed'){
    try {
      const result=await deliver(maker,id,ctx,saveMediaBuffer);
      text=`任务 ${id} 的 Live2D 制作包已生成（修订 ${result.revision??job.revision}）。下方有同版预览和制作文件。\n\n`+
        (result.volumeGuide?result.volumeGuide+'\n\n':'')+
        result.attachments.map(a=>'MEDIA:'+a.path).join('\n');
    } catch(e) {
      if(e.code==='DELIVERY_VISUAL_PENDING')return;
      if(e.code!=='DELIVERY_VISUAL_HOLD')throw e;
      text=`任务 ${id} 的制作文件已生成，视觉复核未通过，附件保留在原任务。${e.message}`;
    }
  }else{
    const stages={intake:'输入分析',artwork:'拆层和补绘',rigging:'绑定',dynamics:'动态校验',packaging:'打包'};
    text=`任务 ${id} 停在${stages[job.stage]??job.stage}。 ${job.error?.message??'已保留当前制作回执。'}`;
  }
  const result=await append({agentId,...ctx,config,text,idempotencyKey:'live2d:'+id+':'+attempt});
  if(!result.ok&&result.code!=='session-rebound')throw Error('原会话结果写入尚未确认');
  await maker.store.write(key,{attempt,status:result.ok?'visible_message_saved':'session_rebound',at:new Date().toISOString()});
}

export function automaticDeliveryService(maker,options) {
  let timer,run;
  return {
    id:'live2d-automatic-delivery',
    start({config,logger}){
      async function tick(){
        await maker.recoverAutomaticReview().catch(e=>{
          logger.warn(`Live2D 自动恢复本机制作失败 (${e.code??'MAKE_RECOVERY_FAILED'})`);
        });
        const files=await fs.readdir(maker.store.dir).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
        for(const file of files){
          const id=/^make-([a-f0-9-]{36})\.json$/.exec(file)?.[1];
          if(id)await notifyAutomaticDelivery(maker,id,{...options,config}).catch(e=>{
            logger.warn(`Live2D 自动交付 ${id} 等待恢复 (${e.code??'APPEND_UNCONFIRMED'})`);
          });
        }
      }
      timer=setInterval(()=>{
        if(!run)run=tick().catch(e=>logger.warn(`Live2D 自动交付读取失败 (${e.code??'SCAN_FAILED'})`)).finally(()=>{run=null;});
      },3000);
      timer.unref();
    },
    async stop(){clearInterval(timer);await run;}
  };
}
