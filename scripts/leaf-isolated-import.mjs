import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {digest} from '../src/packaging/files.mjs';

const execute=promisify(execFile),root=fileURLToPath(new URL('../',import.meta.url));
export async function importInCleanLeaf(zip,library){
  const source=path.join(root,'evidence/single-image-live2d/05/leaf-source');
  const receipts=JSON.parse(await fs.readFile(path.join(source,'source-receipt.json')));
  for(const name of ['models.rs','vts.rs']){
    const file='src-tauri/src/'+name;
    if((await digest(path.join(source,file))).sha256!==receipts.find(x=>x.path===file)?.sha256)
      throw Error('VTubeLeaf 导入代码与固定版本不一致');
  }
  const {stdout}=await execute(path.join(os.homedir(),'.cargo/bin/cargo'),['run','--locked','--offline','--quiet',
    '--manifest-path',path.join(root,'scripts/leaf-import-probe/Cargo.toml'),'--target-dir',path.join(root,'.local/leaf-import-target'),
    '--',zip,library],{timeout:120000,maxBuffer:1024*1024});
  const info=JSON.parse(stdout),entry=await fs.realpath(info.path),base=await fs.realpath(library);
  if(!entry.startsWith(base+path.sep)||!Array.isArray(info.files)||!info.files.length)throw Error('未在隔离的 Leaf 模型库中找到导入产物');
  return {entry,resources:info.files,implementation:'VTubeLeaf 1.3.1 Registry::load + Registry::read (fixed release source, isolated library)'};
}
