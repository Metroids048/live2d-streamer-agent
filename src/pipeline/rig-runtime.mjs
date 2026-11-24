import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Fault} from '../rpc.mjs';
import {RIG_REPAIR_PROFILE} from '../rigging/recipe.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
async function read(file) {
 const stat=await fs.lstat(file);
 if(!stat.isFile()||stat.isSymbolicLink()||await fs.realpath(file)!==file)throw new Fault('ENGINE_BUILD_MISMATCH','制作运行组件路径不符');
 return fs.readFile(file);
}
const optional=async file=>{try{return JSON.parse(await read(file));}catch(e){if(e.code==='ENOENT')return null;throw e;}};

// A resumed old recipe keeps its recorded runtime. Fresh current-recipe work
// uses the exact locally verified component set, also recorded in its RigBundle.
export async function prepareRigRuntime(root,job,location) {
 if(job.kind!=='single_image'||!location.args.length)return null;
 const config=await optional(path.join(root,'config/psd2live-runtime.json'));
 if(!config)return null;
 const recipe=await optional(path.join(job.output,'rigging/recipe.json'));
 if(recipe&&recipe.repairProfile!==RIG_REPAIR_PROFILE)return null;
 const resolve=relative=>{
  if(typeof relative!=='string'||path.isAbsolute(relative)||!relative||relative.split(/[\\/]/).includes('..'))throw new Fault('ENGINE_BUILD_MISMATCH','运行组件配置须使用项目相对路径');
  return path.join(root,relative);
 };
 const manifestBytes=await read(resolve(config.manifest));
 if(hash(manifestBytes)!==config.manifestSha256)throw new Fault('ENGINE_BUILD_MISMATCH','制作运行清单已改变');
 const engineRuntimePatch=JSON.parse(manifestBytes);
 if(!Array.isArray(engineRuntimePatch.runtimeComponents)||!engineRuntimePatch.runtimeComponents.length)throw new Fault('ENGINE_BUILD_MISMATCH','运行组件清单为空');
 if(recipe&&JSON.stringify(recipe.engineRuntimePatch)!==JSON.stringify(engineRuntimePatch))throw new Fault('ENGINE_BUILD_MISMATCH','原工程的制作运行组件与当前配置不符');
 for(const c of engineRuntimePatch.runtimeComponents)if(hash(await read(c.path))!==c.sha256)throw new Fault('ENGINE_BUILD_MISMATCH','制作运行组件校验失败');
 const argsBytes=await read(resolve(config.argsTemplate));
 if(hash(argsBytes)!==config.argsSha256)throw new Fault('ENGINE_BUILD_MISMATCH','制作运行参数校验失败');
 await fs.mkdir(location.dir,{recursive:true,mode:0o700});
 if(await fs.realpath(location.dir)!==location.dir)throw new Fault('ENGINE_BUILD_MISMATCH','制作目录含链接');
 const argsFile=path.join(location.dir,'runtime-pinned.args');
 try {await fs.writeFile(argsFile,argsBytes,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
 if(hash(await read(argsFile))!==config.argsSha256)throw new Fault('ENGINE_BUILD_MISMATCH','专用制作目录已有不同运行参数');
 return {engineRuntimePatch,argsFile,argsSha256:config.argsSha256};
}
