// Thin client for PSD2Live v3.6.7's documented Streamable HTTP interface.
// Protocol behavior follows upstream mcp_proxy.py; edits are never retried here.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {Fault} from './rpc.mjs';

export class Psd2Live {
  constructor(root, {fetcher=fetch,connectionDir=path.join(root,'.local')}={}) {
    this.root=root; this.fetcher=fetcher; this.id=0;
    this.connectionDir=connectionDir;
    this.endpoint='http://127.0.0.1:23872/mcp';
  }
  async post(message) {
    this.token??=(await fs.readFile(path.join(this.connectionDir,'psd2live-token'),'utf8')).trim();
    let response;
    try {
      response=await this.fetcher(this.endpoint,{method:'POST',redirect:'error',
        headers:{Authorization:'Bearer '+this.token,'Content-Type':'application/json',Accept:'application/json, text/event-stream',
          'MCP-Protocol-Version':'2025-03-26',...(this.session?{'Mcp-Session-Id':this.session}:{})},
        body:JSON.stringify(message),signal:AbortSignal.timeout(65000)});
    } catch {throw new Fault('MAKER_CONNECTION_UNKNOWN','制作引擎连接中断；已提交的编辑不会自动重发');}
    if(!response.ok) throw new Fault('MAKER_HTTP','制作引擎 HTTP '+response.status);
    this.session=response.headers.get('Mcp-Session-Id')??this.session;
    let body;
    try {body=await response.text();}
    catch {throw new Fault('MAKER_CONNECTION_UNKNOWN','制作结果传输中断；请查询原任务，不重新提交');}
    if(!body.trim()) return null;
    if(response.headers.get('Content-Type')?.includes('text/event-stream')) {
      return body.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>JSON.parse(l.slice(5))).find(v=>v.id===message.id)??null;
    }
    return JSON.parse(body);
  }
  async rpc(method,params) {
    if(!this.initialized && method!=='initialize') {
      await this.rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'live2d-streamer',version:'0.1.0'}});
      await this.post({jsonrpc:'2.0',method:'notifications/initialized'}); this.initialized=true;
    }
    const reply=await this.post({jsonrpc:'2.0',id:++this.id,method,params});
    if(!reply) throw new Fault('MAKER_NO_REPLY','制作引擎未返回结果，请查询原任务');
    if(reply.error) throw new Fault('MAKER_RPC',reply.error.message);
    return reply.result;
  }
  async call(operation,request={}, {onJob,wait=true,unwrap=true}={}) {
    // 3.6.7 can fail to serialize job_wait's error. Persist the native raster exporter job before waiting.
    const args={operation,request};
    if(onJob&&operation==='project_export_target')args.wait_ms=0;
    const result=await this.rpc('tools/call',{name:'workspace_call',arguments:args});
    const data=result.structuredContent??JSON.parse(result.content.find(c=>c.type==='text')?.text??'{}');
    if(result.isError || data.ok===false) throw new Fault('MAKER_REJECTED',data.error?.message??'制作操作被拒绝',{operation,detail:data.error});
    let payload=data.data??data;
    const images=(result.content??[]).filter(c=>c.type==='image').map(c=>Buffer.from(c.data,'base64'));
    if(payload.id?.startsWith('job-') && !payload.terminal) {
      await onJob?.(payload);
      if(!wait) return {data:payload,images};
      do {payload=(await this.call('job_wait',{id:payload.id,timeout_ms:30000},{wait:false,unwrap:false})).data;}
      while(!payload.terminal);
    }
    if(unwrap && payload.id?.startsWith('job-') && payload.terminal) {
      if(payload.status!=='completed') throw new Fault('MAKER_JOB_FAILED',payload.error?.message??payload.status,{job:payload});
      payload=payload.result??payload;
    }
    return {data:payload,images};
  }
}
