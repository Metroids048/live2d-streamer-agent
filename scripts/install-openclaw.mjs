// 只增量注册/更新本项目；原配置保存在用户私有目录。
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {ROOT} from '../src/controller.mjs';

const configPath=path.join(os.homedir(),'.openclaw/openclaw.json');
const before=await fs.readFile(configPath);
const config=JSON.parse(before);
const backupDir=path.join(os.homedir(),'.openclaw/backups/live2d-streamer');
await fs.mkdir(backupDir,{recursive:true,mode:0o700});
const backup=path.join(backupDir,new Date().toISOString().replaceAll(':','-')+'.json');
await fs.writeFile(backup,before,{mode:0o600});
const plugin=path.join(ROOT,'openclaw-plugin');
config.plugins.load.paths=[...new Set([...config.plugins.load.paths,plugin])];
config.plugins.allow=[...new Set([...(config.plugins.allow??[]),'live2d-streamer'])];
config.plugins.entries??={};config.plugins.entries['live2d-streamer']={enabled:true};
const tools=['read','avatar_inputs','avatar_materials','avatar_make','avatar_making','avatar_deliver','avatar_status','avatar_inspect','avatar_connect','avatar_load','avatar_expressions','avatar_expression','avatar_restore','avatar_prepare_obs'];
const agent=config.agents.list.find(a=>a.id==='live2d-streamer');
if(agent) {
  if(agent.workspace!==path.join(ROOT,'openclaw-workspace')) throw new Error('Agent workspace ownership mismatch');
  agent.tools.alsoAllow=[...new Set([...(agent.tools.alsoAllow??[]),...tools])];
} else config.agents.list.push({id:'live2d-streamer',name:'虚拟主播助手',workspace:path.join(ROOT,'openclaw-workspace'),agentDir:path.join(os.homedir(),'.openclaw/agents/live2d-streamer/agent'),model:{primary:'openai/gpt-6.1-sol',fallbacks:[]},tools:{profile:'minimal',alsoAllow:tools}});
const temp=configPath+'.live2d.tmp';
await fs.writeFile(temp,JSON.stringify(config,null,2)+'\n',{mode:0o600});
await fs.rename(temp,configPath);
console.log(JSON.stringify({registered:'live2d-streamer',plugin,backup},null,2));
