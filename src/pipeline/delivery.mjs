import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fail} from '../rpc.mjs';
import {verifyPackageArchive} from '../packaging/index.mjs';
import {digest} from '../packaging/files.mjs';
import {editableVolumeGuide,isEditableVolume,verifyEditableVolumes} from '../packaging/editable-volumes.mjs';

// Consume 05's immutable package, never rebuild a legacy sample for a new image.
export async function singleImageSources(job,root,cap,{verifyArchive=verifyPackageArchive,preferComplete=false}={}) {
  const regular=async relative=>{
    if(typeof relative!=='string'||path.isAbsolute(relative)||relative.split(/[\\/]/).some(p=>p==='..'||p==='.'||!p))fail('INVALID_ARTIFACT','无效的本任务附件路径');
    const file=path.join(root,relative),stat=await fs.lstat(file);
    if(!stat.isFile()||await fs.realpath(file)!==file)fail('INVALID_ARTIFACT','附件必须是本任务的普通文件');
    return file;
  };
  const bundle=JSON.parse(await fs.readFile(await regular('packaging/stage.json'),'utf8'));
  const identity={taskId:job.id,candidateId:job.candidateId,revision:job.revision,parentRevision:job.parentRevision,
    inputSha256:job.source?.inputSha256,descriptionSha256:job.source?.descriptionSha256};
  if(bundle.schemaVersion!==1||bundle.stage!=='packaging'||bundle.status!=='completed'||
    Object.keys(identity).some(k=>bundle[k]!==identity[k])||bundle.unresolved?.length||
    bundle.checks?.some(c=>['failed','blocked'].includes(c.status))||bundle.packagePath!==job.artifacts?.packagePath)
    fail('PACKAGE_IDENTITY_MISMATCH','完整包与本次图片/候选不符或尚未完成');
  if(!Array.isArray(bundle.deliveryFiles))fail('INVALID_ARTIFACT','缺少已验证交付清单');
  const limits=[cap,bundle.distribution?.localMaxBytes,bundle.distribution?.serviceMaxBytes].filter(n=>n!=null);
  if(limits.some(n=>!Number.isSafeInteger(n)||n<=0))fail('INVALID_ARTIFACT','附件大小限制无效');
  const maxBytes=Math.min(...limits);
  const roles=new Map(),sources=[];
  for(const a of bundle.deliveryFiles) {
    if(roles.has(a.role))fail('INVALID_ARTIFACT','交付类型重复');roles.set(a.role,a);
    const file=await regular(a.path),actual=await digest(file);
    if(actual.bytes!==a.bytes||actual.sha256!==a.sha256)fail('INVALID_ARTIFACT','交付文件哈希已改变');
    const mime=isEditableVolume(a.role)?'application/zip':
      {'complete-package':'application/zip','runtime-package':'application/zip','editable-package':'application/zip','preview-video':'video/mp4','preview-cover':'image/png'}[a.role];
    if(!mime)fail('INVALID_ARTIFACT','未登记的交付类型');
    if(a.bytes<=maxBytes)sources.push({file,mime,name:path.basename(a.path),artifact:a});
  }
  const full=roles.get('complete-package');
  if(!full||full.path!==bundle.packagePath||!roles.has('preview-video')||!roles.has('preview-cover'))fail('INVALID_ARTIFACT','缺少完整包或同版制作预览');
  const editable=roles.get('editable-package');
  const volumes=sources.filter(s=>isEditableVolume(s.artifact.role));
  if(volumes.length!==[...roles.keys()].filter(isEditableVolume).length||
    volumes.length&&(!editable||editable.bytes<=maxBytes))fail('INVALID_ARTIFACT','编辑分卷缺失或未绑定原 ZIP');
  if(full.bytes>maxBytes&&(!sources.some(s=>s.artifact.role==='runtime-package')||
    !(editable?.bytes<=maxBytes||volumes.length)))fail('DELIVERY_TOO_LARGE','完整包超限且缺少运行包或完整编辑分卷');
  if(!['preview-video','preview-cover'].every(r=>sources.some(s=>s.artifact.role===r)))fail('DELIVERY_TOO_LARGE','同版制作预览超出附件限制');
  const scratch=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'live2d-publish-')));
  try {
    for(const a of bundle.deliveryFiles.filter(a=>a.role.endsWith('package')))
      await verifyArchive(await regular(a.path),a,path.join(scratch,a.role),{identity});
    if(volumes.length)await verifyEditableVolumes(volumes.map(s=>({...s.artifact,file:s.file})),editable,scratch);
  } finally {await fs.rm(scratch,{recursive:true,force:true});}
  const completeSources=preferComplete&&full.bytes<=maxBytes
    ? [sources.find(s=>s.artifact.role==='preview-video'),sources.find(s=>s.artifact.role==='complete-package')]
    : sources;
  return {sources:completeSources,archive:path.join(root,bundle.packagePath),
    volumeGuide:volumes.length?editableVolumeGuide(volumes.map(s=>s.artifact),editable):undefined,
    notice:'同一单图候选的模型资源包与制作预览；制作动画不等于真人跟踪。原生加载、摄像头及用户认可仍待验证。'};
}
