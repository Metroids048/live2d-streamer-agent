import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fail} from './rpc.mjs';

export class Store {
  constructor(root, dir = path.join(root,'.local')) { this.root = root; this.dir = dir; }
  async read(name, fallback = null) {
    try {return JSON.parse(await fs.readFile(path.join(this.dir,name+'.json'),'utf8'));}
    catch(e) {if(e.code==='ENOENT') return fallback; throw e;}
  }
  async write(name,value) {
    await fs.mkdir(this.dir,{recursive:true,mode:0o700});
    const dest=path.join(this.dir,name+'.json'), tmp=dest+'.'+process.pid+'.tmp';
    await fs.writeFile(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600}); await fs.rename(tmp,dest);
  }
  session(ctx) {
    if (!ctx.sessionKey) fail('SESSION_REQUIRED','需要 OpenClaw 会话标识，无法把控制状态绑定到匿名调用');
    return createHash('sha256').update(ctx.sessionKey+'|'+(ctx.sessionId??'')).digest('hex').slice(0,24);
  }
  async lock(fn) {
    await fs.mkdir(this.dir,{recursive:true,mode:0o700});
    const p=path.join(this.dir,'control.lock'); let h;
    try { h=await fs.open(p,'wx',0o600); }
    catch(e) {
      if(e.code!=='EEXIST') throw e;
      const pid=Number(await fs.readFile(p,'utf8'));
      try {process.kill(pid,0);fail('BUSY','另一个控制操作仍在执行，请稍后查询');}
      catch(x) {if(x.code!=='ESRCH') throw x; await fs.unlink(p); return this.lock(fn);}
    }
    try {await h.writeFile(String(process.pid));return await fn();}
    finally {await h.close();await fs.unlink(p);}
  }
}
