// Resume only the preview of an already exported job; never reimport/rebind its model.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {ROOT} from '../src/controller.mjs';
import {Store} from '../src/store.mjs';
import {Psd2Live} from '../src/psd2live.mjs';
import {Maker} from '../src/maker.mjs';
import {finishPreview,ffmpeg} from '../src/preview.mjs';
const id=process.argv[2];
if(!/^[a-f0-9-]{36}$/.test(id??''))throw new Error('Invalid job');
const store=new Store(ROOT),job=await store.read('make-'+id),client=new Psd2Live(ROOT);
if(job?.status!=='completed')throw new Error('Only an exported job can finish its preview');
const material=(await new Maker().materials()).materials.find(m=>m.id===job.materialId&&m.valid&&m.sha256===job.source.sha256);
if(!material)throw new Error('原素材校验失败');
const {data:state}=await client.call('workspace_inspect',{scope:'project'});
if(state.project_id!==job.projectId)throw new Error('制作工作区不是原工程；保留原结果');
const request={project_id:state.project_id,state:state.state,request_id:id+'-preview-video',target:'mp4',
  output_directory:job.artifacts.previewDirectory,settings:{clip:'preview6s',fps:'24',size:'1024',background:'FF273342',ffmpeg}};
job.pending={operation:'project_export_target',request};await store.write('make-'+id,job);
const result=await client.call('project_export_target',request,{onJob:async j=>{job.pending.jobId=j.id;await store.write('make-'+id,job);}});
job.steps.push({name:'preview-video',operation:'project_export_target',result:result.data,finishedAt:new Date().toISOString()});
delete job.pending;
const preview=await finishPreview(job.artifacts.previewDirectory,material.previewCrop);
job.artifacts.previews=preview.previews;job.artifacts.cover=preview.cover;
await store.write('make-'+id,job);
await fs.writeFile(path.join(job.output,'制作过程.json'),JSON.stringify(job.steps,null,2)+'\n');
await fs.writeFile(path.join(job.output,'制作记录.json'),JSON.stringify({...job,session:undefined,callId:undefined,pid:undefined},null,2)+'\n');
console.log(JSON.stringify({id,preview:preview.check}));
