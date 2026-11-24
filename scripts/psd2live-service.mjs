import * as fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {ROOT} from '../src/controller.mjs';
import {Store} from '../src/store.mjs';
import {alive} from '../src/maker.mjs';
import {imageEngineDirectory} from '../src/pipeline/engine-location.mjs';

const [taskId,candidateId,revision,profileArg,scopedArgsFile]=process.argv.slice(2);
const profile=scopedArgsFile&&profileArg===''?undefined:profileArg;
const local=path.join(ROOT,'.local'),source=path.join(local,'tools/psd2live');
const dir=taskId?imageEngineDirectory(ROOT,taskId,candidateId,Number(revision),profile):local;
const argsFile=scopedArgsFile??path.join(source,'build/run/jvm.args');
if(scopedArgsFile&&(!taskId||!path.isAbsolute(argsFile)||path.dirname(argsFile)!==dir))
  throw new Error('候选运行参数必须位于同一专用制作目录');
const argsStat=await fs.lstat(argsFile);
if(!argsStat.isFile()||argsStat.isSymbolicLink()||await fs.realpath(argsFile)!==argsFile)
  throw new Error('制作运行参数必须是无链接的普通文件');
const argsSha256=createHash('sha256').update(await fs.readFile(argsFile)).digest('hex');
await fs.mkdir(dir,{recursive:true,mode:0o700});
if(await fs.realpath(dir)!==dir)throw new Error('制作目录不能是符号链接');
const serviceStore=new Store(ROOT,dir);
const tokenFile=path.join(dir,'psd2live-token');
try {await fs.writeFile(tokenFile,randomBytes(32).toString('base64url'),{mode:0o600,flag:'wx'});} catch(e) {if(e.code!=='EEXIST') throw e;}
const token=(await fs.readFile(tokenFile,'utf8')).trim();
const java=(await fs.readFile(path.join(source,'build/run/java'),'utf8')).trim();
const port=taskId?0:23872;
let child,record,closed=false;
await serviceStore.lock(async()=>{
  const previous=await serviceStore.read('psd2live-service');
  if(previous?.pid&&alive(previous.pid)){
    if(scopedArgsFile&&(previous.argsFile!==argsFile||previous.argsSha256!==argsSha256))
      throw new Error('已有候选制作服务使用不同参数，保留原服务');
    return;
  }
  child=spawn(java,['@'+argsFile,'mcp','--port',String(port),'--token',token,'--store',path.join(dir,'psd2live-workspace'),'--profile','core'],
    {cwd:source,stdio:['ignore','pipe','ignore']});
  child.on('error',()=>{process.stderr.write('制作引擎启动失败\n');process.exitCode=1;});
  record={pid:child.pid,supervisorPid:process.pid,startedAt:new Date().toISOString(),port,argsFile,argsSha256,...(taskId?{taskId,candidateId,revision:Number(revision)}:{})};
  await serviceStore.write('psd2live-service',record);
});
if(!child)process.exit(0);
// PSD2Live also prints a bearer secret on stdout. Only persist the exact loopback port.
const lines=createInterface({input:child.stdout});
lines.on('line',line=>{
  const match=/^endpoint http:\/\/127\.0\.0\.1:(\d{1,5})\/mcp$/.exec(line.trim());
  if(match&&Number(match[1])>0&&Number(match[1])<=65535)
    serviceStore.write('psd2live-service',{...record,port:Number(match[1])}).catch(()=>child.kill());
});
if(taskId){
  const jobs=new Store(ROOT);
  const timer=setInterval(async()=>{
    try {
      const job=await jobs.read('make-'+taskId);
      if(!closed&&job?.candidateId===candidateId&&job.revision===Number(revision)&&['completed','failed'].includes(job.status)
        &&(await jobs.read('engine-lease'))?.taskId!==taskId)child.kill();
    }catch{/* A read failure must preserve the editor for recovery. */}
  },30000);timer.unref();
}
for(const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>child.kill(signal));
child.on('exit',code=>{closed=true;process.exitCode=code??1;});
