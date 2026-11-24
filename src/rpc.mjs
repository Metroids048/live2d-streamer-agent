import {randomUUID, createHash} from 'node:crypto';

export class Fault extends Error {
  constructor(code, message, details = {}) { super(message); this.code = code; this.details = details; }
}
export const fail = (code, message, details) => { throw new Fault(code, message, details); };

export class Rpc {
  constructor(url, protocol, {timeout = 5000, WebSocketClass = WebSocket} = {}) {
    const u = new URL(url);
    if (u.protocol !== 'ws:' || !['127.0.0.1','localhost','[::1]'].includes(u.hostname) || u.username || u.password) {
      fail('LOCAL_ONLY','控制接口必须使用本机 WebSocket 地址');
    }
    this.url = url; this.protocol = protocol; this.timeout = timeout; this.WS = WebSocketClass;
    this.pending = new Map(); this.messages = []; this.waiters = [];
  }
  async open() {
    this.ws = new this.WS(this.url);
    this.ws.addEventListener('message', e => {
      let m; try { m = JSON.parse(String(e.data)); } catch { return; }
      const id = this.protocol === 'vts' ? m.requestID : m.d?.requestId;
      if (id && this.pending.has(id)) {
        const p = this.pending.get(id); clearTimeout(p.timer); this.pending.delete(id);
        if (m.messageType === 'APIError') p.reject(new Fault('VTS_API_ERROR','VTS 拒绝请求',{errorId:m.data?.errorID}));
        else if (m.op === 7 && !m.d.requestStatus.result) p.reject(new Fault('OBS_API_ERROR','OBS 拒绝请求',{requestType:m.d.requestType,statusCode:m.d.requestStatus.code}));
        else p.resolve(this.protocol === 'vts' ? m.data : m.d.responseData ?? {});
      } else {
        const i = this.waiters.findIndex(w => w.op === m.op);
        if (i >= 0) { const [w] = this.waiters.splice(i,1); clearTimeout(w.timer); w.resolve(m.d); }
        else if (m.op === 0 || m.op === 2) this.messages.push(m);
      }
    });
    this.ws.addEventListener('close', () => this.rejectPending());
    await new Promise((resolve,reject) => {
      const timer = setTimeout(() => { this.ws.close(); reject(new Fault('UNAVAILABLE','应用未响应；请确认应用与本机 API 已开启')); },this.timeout);
      this.ws.addEventListener('open', () => {clearTimeout(timer);resolve();},{once:true});
      this.ws.addEventListener('error', () => {clearTimeout(timer);reject(new Fault('UNAVAILABLE','无法连接本机应用；请确认应用与 API 端口'));},{once:true});
    });
    return this;
  }
  rejectPending() {
    for (const p of this.pending.values()) {clearTimeout(p.timer); p.reject(new Fault('OUTCOME_UNKNOWN','连接断开，操作结果未知；先查询实际状态'));}
    this.pending.clear();
    for (const w of this.waiters) {clearTimeout(w.timer);w.reject(new Fault('UNAVAILABLE','应用连接断开'));} this.waiters = [];
  }
  waitOp(op) {
    const i = this.messages.findIndex(m => m.op === op);
    if (i >= 0) return Promise.resolve(this.messages.splice(i,1)[0].d);
    return new Promise((resolve,reject) => {
      const w = {op,resolve,reject};
      w.timer = setTimeout(() => {this.waiters = this.waiters.filter(x=>x!==w);reject(new Fault('TIMEOUT','应用握手超时'));},this.timeout);
      this.waiters.push(w);
    });
  }
  request(type, data = {}, timeout = this.timeout) {
    if (this.ws?.readyState !== 1) return Promise.reject(new Fault('UNAVAILABLE','应用未连接'));
    const id = randomUUID();
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => {this.pending.delete(id);reject(new Fault('OUTCOME_UNKNOWN','请求超时，操作结果未知；先查询实际状态'));},timeout);
      this.pending.set(id,{resolve,reject,timer});
      try {this.ws.send(JSON.stringify(this.protocol === 'vts'
        ? {apiName:'VTubeStudioPublicAPI',apiVersion:'1.0',requestID:id,messageType:type,data}
        : {op:6,d:{requestType:type,requestId:id,requestData:data}}));}
      catch {clearTimeout(timer);this.pending.delete(id);reject(new Fault('OUTCOME_UNKNOWN','发送失败，操作结果未知；先查询实际状态'));}
    });
  }
  async identifyObs(password) {
    const hello = await this.waitOp(0);
    const d = {rpcVersion:1,eventSubscriptions:0};
    if (hello.authentication) {
      if (!password) fail('AUTH_REQUIRED','OBS 需要本机保存的 WebSocket 密码，请在本机设置，勿发送到聊天');
      const hash = s => createHash('sha256').update(s).digest('base64');
      d.authentication = hash(hash(password + hello.authentication.salt) + hello.authentication.challenge);
    }
    this.ws.send(JSON.stringify({op:1,d}));
    await this.waitOp(2);
  }
  close() { this.ws?.close(); }
}
