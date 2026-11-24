const agentId='live2d-streamer';

// Claim only explicit, authorized creation requests. Everything ambiguous
// still reaches the existing assistant and its scoped attachment tools.
export function nativeIntakeRequest(event) {
  const {ctx,sessionKey,runId,images}=event;
  if(ctx?.AgentId!==agentId||ctx.Provider!=='webchat'||ctx.CommandTurn?.kind!=='normal'||
    ctx.SessionKey!==sessionKey||!/^agent:live2d-streamer:dashboard:[a-z0-9-]+$/.test(sessionKey??'')||
    !runId||event.isTailDispatch||event.suppressUserDelivery||event.sendPolicy!=='allow'||
    event.shouldRouteToOriginating||ctx.MediaPaths?.length||images?.length!==1)return;
  const image=images[0],description=ctx.RawBody;
  if(!['image/png','image/jpeg'].includes(image?.mimeType)||typeof image.data!=='string'||
    typeof description!=='string'||description.length>20000||
    !/(?:^|[。！；\n])\s*(?:请|帮我|麻烦)(?:把|将)?[^。！？\n]{0,45}(?:做成|制作|生成|制成)[^。！？\n]{0,60}(?:Live2D|虚拟主播)[^。！？\n]*(?:[。！]|$)/iu.test(description)||
    !/原创[^。！？\n]{0,24}(?:角色|立绘|图)/u.test(description)||
    !/(?:我允许|允许本项目|授权本项目)[^。！？\n]{0,24}使用[^。！？\n]{0,12}修改[^。！？\n]{0,16}交付/u.test(description)||
    /(?:暂不|先别|不要|无需|不必)[^。！？\n]{0,25}(?:做成|制作|生成|制成|使用|修改|交付|出包|重跑)|不(?:允许|授权|是)[^。！？\n]{0,18}(?:原创|使用|修改|交付)|(?:可以|能否|能不能|能做吗)[^。！？\n]{0,18}(?:做成|制作|生成)/u.test(description))return;
  return {image:{type:'image',mimeType:image.mimeType,data:image.data},description,sessionKey,callId:'native:'+runId};
}

export async function dispatchNativeIntake(event,dispatch,{inbox,maker,resolveSessionId}) {
  const input=nativeIntakeRequest(event);
  if(!input)return;
  const {sessionKey,description,callId,image}=input;
  const sessionId=await resolveSessionId(sessionKey,dispatch.cfg);
  if(!sessionId)return;
  const ctx={agentId,sessionKey,sessionId,callId};
  dispatch.abortSignal?.throwIfAborted();
  const [registered]=await inbox.capture([{role:'user',content:[image]}],ctx,description);
  if(!registered)return;
  dispatch.abortSignal?.throwIfAborted();
  let result;
  let busy=false;
  try {
    result=await maker.makeImage({imageRef:registered.imageRef,description,rights:{
      source:'当前会话用户提交并声明的原创角色',license:'用户授权本项目使用、修改及向本会话交付',
      allowDerivatives:true,allowRedistribution:false,userDeclared:true
    }},ctx);
  } catch(error) {
    if(error.code!=='MAKER_BUSY')throw error;
    busy=true;
    const prior=await maker.making(error.details?.jobId,ctx).catch(()=>null);
    result=prior?.ok?prior:null;
  }
  const text=busy
    ? `制作队列仍有任务。${result?.jobId?`本会话的在制任务编号是 \`${result.jobId}\`。`:''}请等当前任务结束后再提交这张图。`
    : `已收到角色图。任务编号 \`${result.jobId}\`。\n\n可在本会话查询制作进度。`;
  const queuedFinal=dispatch.dispatcher.sendFinalReply({text});
  dispatch.recordProcessed('completed',{reason:'live2d_native_intake'});
  dispatch.markIdle('message_completed');
  return {handled:true,queuedFinal,counts:dispatch.dispatcher.getQueuedCounts()};
}
