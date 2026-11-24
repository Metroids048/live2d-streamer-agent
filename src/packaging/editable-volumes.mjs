import * as fs from 'node:fs/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {archive} from './archive.mjs';
import {artifact,reject} from './files.mjs';

const role = index => 'editable-volume-'+String(index+1).padStart(3,'0');
export const isEditableVolume = name => /^editable-volume-\d{3}$/.test(name);
const member = name => name+'.bin';

export function editableVolumeGuide(volumes,editable) {
  const names=volumes.map(v=>member(v.role)).join(' ');
  return '把编辑分卷 ZIP 全部解压到同一目录，在该目录运行 `cat '+names+
    ' > editable-assets.zip`，用 `shasum -a 256 editable-assets.zip` 核对 '+editable.sha256+
    ' 后解压，即可取得完整工程和分层 PSD。运行包可单独解压导入。';
}

export async function makeEditableVolumes(directory,editable,limit,signal) {
  // ZIP_STORED adds only headers and the short reassembly note.
  const payload=limit-8192;
  const count=Math.ceil(editable.bytes/payload);
  if(payload<=0||count>999)return [];
  const work=await fs.mkdtemp(path.join(directory,'.editable-parts-'));
  try {
    const volumes=Array.from({length:count},(_,i)=>({role:role(i),path:role(i)+'.zip'}));
    await fs.writeFile(path.join(work,'合并说明.txt'),editableVolumeGuide(volumes,editable)+'\n');
    const result=[];
    for(const [index,volume] of volumes.entries()) {
      const start=index*payload,name=member(volume.role),raw=path.join(work,name);
      await pipeline(createReadStream(path.join(directory,'editable-assets.zip'),{start,end:Math.min(start+payload,editable.bytes)-1}),
        createWriteStream(raw,{flags:'wx'}),{signal});
      await archive({action:'make',root:work,file:path.join(directory,volume.path),
        files:[name,'合并说明.txt'],store:true},signal);
      await fs.unlink(raw);
      result.push(await artifact(directory,volume.path,volume.role));
    }
    await verifyEditableVolumes(result.map(v=>({...v,file:path.join(directory,v.path)})),editable,work,signal);
    return result;
  } finally {await fs.rm(work,{recursive:true,force:true});}
}

export async function verifyEditableVolumes(volumes,editable,scratch,signal) {
  const hash=createHash('sha256');
  let bytes=0;
  for(const [index,volume] of volumes.entries()) {
    if(volume.role!==role(index)||path.basename(volume.file)!==volume.role+'.zip')
      reject('REFERENCE_INVALID','编辑分卷顺序或文件名不符');
    const target=path.join(scratch,volume.role),name=member(volume.role);
    await archive({action:'extract',file:volume.file,root:target,files:[name,'合并说明.txt']},signal);
    try {
      for await(const chunk of createReadStream(path.join(target,name),{signal})) {
        hash.update(chunk);bytes+=chunk.length;
      }
    } finally {await fs.rm(target,{recursive:true,force:true});}
  }
  if(bytes!==editable.bytes||hash.digest('hex')!==editable.sha256)
    reject('REFERENCE_INVALID','编辑分卷重组后与原 ZIP 摘要不符');
}
