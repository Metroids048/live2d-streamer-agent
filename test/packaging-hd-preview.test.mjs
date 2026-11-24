import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {deflateSync} from 'node:zlib';
import {buildHdPreview} from '../src/packaging/hd-preview.mjs';
import {artifact,digest} from '../src/packaging/files.mjs';
import {ffmpeg} from '../src/preview.mjs';
import {crc32} from '../src/rigging/geometry.mjs';

function blackPng(width,height) {
  const chunk=(tag,data)=>{const type=Buffer.from(tag),length=Buffer.alloc(4),crc=Buffer.alloc(4);
    length.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([type,data])));
    return Buffer.concat([length,type,data,crc]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),
    chunk('IDAT',deflateSync(Buffer.alloc((width*3+1)*height))),chunk('IEND',Buffer.alloc(0))]);
}

// Synthetic renderer boundary and structural MOC only. Real ffmpeg encoding/decoding
// verifies media and recovery; these tests do not claim Leaf rendering or visual approval.
async function fixture(t) {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'hd-preview-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const taskRoot=path.join(root,'task');
  for(const dir of ['scripts','seed','task/artwork','task/dynamics/model','task/dynamics/preview'])
    await fs.mkdir(path.join(root,dir),{recursive:true});
  const identity={taskId:'task',candidateId:'candidate',revision:2,parentRevision:1,
    inputSha256:'a'.repeat(64),descriptionSha256:'b'.repeat(64)};
  const write=async(relative,value)=>fs.writeFile(path.join(taskRoot,relative),JSON.stringify(value));
  const png=Buffer.from('89504e470d0a1a0a','hex');
  await write('artwork/manifest.json',{...identity,canvas:{width:100,height:200},parts:[{tags:['face'],rect:{left:30,top:20,width:40,height:40}}]});
  await fs.writeFile(path.join(taskRoot,'dynamics/model/texture.png'),png);
  await fs.writeFile(path.join(taskRoot,'dynamics/model/avatar.moc3'),'MOC3fixture');
  await write('dynamics/model/avatar.model3.json',{Version:3,FileReferences:{Moc:'avatar.moc3',Textures:['texture.png'],Physics:'physics.json'}});
  const group={id:'cloth',inputs:[{parameter:'ParamBodyAngleX',weight:100,type:'angle',reflect:false}],
    outputs:[{parameter:'ParamCloth',vertex:1,scale:1,weight:100,reflect:false}],
    segments:[{length:7,mobility:.55,delay:.3,acceleration:1.1}],
    normalization:{position:{min:-10,default:0,max:10},angle:{min:-10,default:0,max:10}}};
  await write('dynamics/recipe.json',{physicsFps:30,physics:[group],expressions:[],motions:[]});
  await write('dynamics/model/physics.json',{Version:3,Meta:{Fps:30},PhysicsSettings:[{Id:'cloth',
    Input:[{Source:{Id:'ParamBodyAngleX'},Weight:100,Type:'Angle',Reflect:false}],
    Output:[{Destination:{Id:'ParamCloth'},VertexIndex:1,Scale:1,Weight:100,Type:'Angle',Reflect:false}],
    Vertices:[{}, {Radius:7,Mobility:.55,Delay:.3,Acceleration:1.1}],
    Normalization:{Position:{Minimum:-10,Default:0,Maximum:10},Angle:{Minimum:-10,Default:0,Maximum:10}}}]});
  const phases=['neutral','physics-slow-turn','physics-fast-stop','physics-reverse','physics-settle','restore-baseline'];
  const frames=Array.from({length:31},(_,i)=>({time:i/30,phase:phases[Math.min(5,Math.floor(i/5))]}));
  const trajectory={fps:30,duration:1,frameCount:31,phases:phases.map((id,i)=>({id,from:i/6,to:(i+1)/6})),frames,
    clip:{fps:30,duration:1,curves:[{parameter:'ParamBodyAngleX',keys:frames.map(f=>({time:f.time,value:f.time}))}]}};
  await write('dynamics/preview/trajectory.json',trajectory);
  const manifest={...identity,stage:'dynamics',status:'completed',exportStatus:'exported',
    modelPath:'dynamics/model/avatar.model3.json',preview:{kind:'parameter-animation',trajectoryPath:'dynamics/preview/trajectory.json'}};
  await write('dynamics/manifest.json',manifest);
  const dynamics={schemaVersion:1,...identity,stage:'dynamics',status:'completed',engineVersion:'3.6.7',
    modelPath:manifest.modelPath,artworkManifestPath:'artwork/manifest.json',dynamicsManifestPath:'dynamics/manifest.json',
    previewCapture:{status:'captured'},checks:[{name:'dynamics.export-and-reopen',status:'passed'}],unresolved:[],artifacts:[]};
  const refresh=async(extra=[])=>{
    dynamics.artifacts=await Promise.all(['artwork/manifest.json','dynamics/recipe.json','dynamics/preview/trajectory.json',
      'dynamics/manifest.json','dynamics/model/avatar.model3.json','dynamics/model/avatar.moc3','dynamics/model/texture.png',
      'dynamics/model/physics.json',...extra].map(p=>artifact(taskRoot,p,'source')));
    await write('dynamics/stage.json',dynamics);
  };
  await refresh();
  await promisify(execFile)(ffmpeg,['-hide_banner','-v','error','-f','lavfi','-i','color=c=black:s=1920x1080:r=30',
    '-frames:v','31','-an','-c:v','libx264','-preset','ultrafast','-threads','1','-pix_fmt','yuv420p',path.join(root,'seed/preview.mp4')]);
  for(const [file,w,h] of [['pose-0000.png',1920,1080],['face.png',1080,1080],['full-body.png',2160,3840]])
    await fs.writeFile(path.join(root,'seed',file),blackPng(w,h));
  // Keep the rendering boundary explicit: source hashes and native readback fields are
  // fixture receipts. Only the default installed-Leaf script may produce real previews.
  const producer=`import fs from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';
const args=Object.fromEntries(process.argv.slice(2).reduce((a,v,i,s)=>i%2?a:[...a,[v.slice(2),s[i+1]]],[]));
const reqBytes=await fs.readFile(args.request),req=JSON.parse(reqBytes),out=args.output;
const hash=b=>({sha256:createHash('sha256').update(b).digest('hex'),bytes:b.length});
await fs.appendFile(path.join(${JSON.stringify(root)},'calls'),'1');await fs.mkdir(out);
await fs.copyFile(path.join(${JSON.stringify(root)},'seed/preview.mp4'),path.join(out,'preview-1080p30.mp4'));
const stills=[];for(const file of ['pose-0000.png','full-body.png','face.png']){const b=await fs.readFile(path.join(${JSON.stringify(root)},'seed',file));await fs.writeFile(path.join(out,file),b);stills.push({file,...hash(b)});}
const p={schemaVersion:2,...Object.fromEntries(['taskId','candidateId','revision','parentRevision','inputSha256','descriptionSha256'].map(k=>[k,req[k]])),
kind:'parameter_playback',request:hash(reqBytes),sourceRequest:req,artworkManifest:req.sources.find(s=>s.path===req.artworkManifestPath),
entry:args.model,modelFiles:req.modelFiles.map(s=>({file:path.posix.relative(path.posix.dirname(req.modelPath),s.path),sha256:s.sha256,bytes:s.bytes})),
trajectory:req.sources.find(s=>s.path===req.trajectoryPath),engineAssets:{core:'c'.repeat(64)},
renderer:'VTubeLeaf 1.3.1 installed Cubism WebGL core',nativeTracking:'not_run',desktopModelChanged:false,
width:1920,height:1080,fps:30,seconds:1,frameCount:31,encodedDuration:31/30,phases:req.phases,
phaseFrames:req.phaseFrames,physics:{groups:req.physics.groups,outputs:req.physics.outputs.map(parameter=>({parameter,min:0,max:.2,samples:31})),observedFrames:31,nativeEvaluations:32,stepMs:1000/30,parameterOverrides:false},
video:{file:'preview-1080p30.mp4',...hash(await fs.readFile(path.join(out,'preview-1080p30.mp4')))},stills,
visualAcceptance:'pending',userAcceptance:'pending'};
await fs.writeFile(path.join(out,'render-provenance.json'),JSON.stringify(p));`;
  await fs.writeFile(path.join(root,'scripts/hachi-g1-preview.mjs'),producer);
  return {root,taskRoot,dynamics,manifest,write,refresh,trajectory,options:{root,taskRoot,dynamics,manifest}};
}

test('HD preview renders once and reuses only complete same-source media and provenance',async t=>{
  const f=await fixture(t),result=await buildHdPreview(f.options);
  assert.equal(result.kind,'parameter_playback');assert.equal(result.nativeTracking,'not_run');
  assert.equal(result.reused,false);assert.equal(result.frameCount,31);
  assert.deepEqual(result.artifacts.map(a=>a.role),['hd-preview-video','hd-preview-cover','hd-preview-full-body','hd-preview-face','hd-preview-provenance']);
  const second=await buildHdPreview(f.options);
  assert.equal(second.reused,true);assert.deepEqual(second.artifacts,result.artifacts);
  assert.equal(await fs.readFile(path.join(f.root,'calls'),'utf8'),'1');
  for(const [key,value] of Object.entries({descriptionSha256:'c'.repeat(64),parentRevision:0}))
    await assert.rejects(buildHdPreview({...f.options,manifest:{...f.manifest,[key]:value}}));
  const video=path.join(f.taskRoot,result.videoPath),before=await fs.readFile(video);
  await fs.appendFile(video,'changed');await assert.rejects(buildHdPreview(f.options));
  await fs.writeFile(video,before);
  const p=JSON.parse(await fs.readFile(path.join(f.taskRoot,result.provenancePath),'utf8'));
  p.phases.pop();await f.write(result.provenancePath,p);await assert.rejects(buildHdPreview(f.options));
  assert.equal(await fs.readFile(path.join(f.root,'calls'),'utf8'),'1');
});

test('prepares the exact review video before visual sign-off and reuses it after an immutable review manifest is appended',async t=>{
  const f=await fixture(t),captured='dynamics/preview/dynamics-manifest.json';
  const capture={...f.manifest,status:'blocked'};
  Object.assign(f.dynamics,{status:'blocked',dynamicsManifestPath:captured,unresolved:[{code:'DYNAMICS_VISUAL_REVIEW_FAILED'}]});
  await f.write(captured,capture);await f.refresh([captured]);
  await assert.rejects(buildHdPreview({...f.options,manifest:capture,prepareReview:true}),{code:'HD_PREVIEW_INVALID'});
  f.dynamics.unresolved=[{code:'DYNAMICS_VISUAL_NOT_RUN'}];
  await f.write(captured,capture);await f.refresh([captured]);
  await assert.rejects(buildHdPreview({...f.options,manifest:capture}),{code:'HD_PREVIEW_INVALID'});
  const result=await buildHdPreview({...f.options,manifest:capture,prepareReview:true});
  assert.equal(result.reused,false);
  const reviewed='dynamics/preview/reviewed.json';
  Object.assign(f.dynamics,{status:'completed',dynamicsManifestPath:reviewed,unresolved:[]});
  await f.write(reviewed,f.manifest);await f.refresh([captured,reviewed]);
  const final=await buildHdPreview(f.options);
  assert.equal(final.reused,true);assert.deepEqual(final.artifacts,result.artifacts);
  assert.equal(await fs.readFile(path.join(f.root,'calls'),'utf8'),'1');
  f.manifest.preview={...f.manifest.preview,videoSha256:'changed'};
  await f.write(reviewed,f.manifest);await f.refresh([captured,reviewed]);
  await assert.rejects(buildHdPreview(f.options),{code:'HD_PREVIEW_INVALID'});
});

test('HD preview rejects changed resource/trajectory and physics overrides before rendering',async t=>{
  const f=await fixture(t);
  const texture=path.join(f.taskRoot,'dynamics/model/texture.png');await fs.appendFile(texture,'changed');
  await assert.rejects(buildHdPreview(f.options));await f.refresh();
  const clip=f.trajectory.clip;clip.curves.push({parameter:'ParamCloth',keys:clip.curves[0].keys});
  await f.write('dynamics/preview/trajectory.json',f.trajectory);
  await assert.rejects(buildHdPreview(f.options));await f.refresh();
  await assert.rejects(buildHdPreview(f.options));
  await assert.rejects(fs.stat(path.join(f.root,'calls')),{code:'ENOENT'});
});

test('HD preview preserves unknown interrupted work and never starts another render',async t=>{
  const f=await fixture(t),dir=path.join(f.taskRoot,'packaging-hd-preview');await fs.mkdir(dir);
  await fs.writeFile(path.join(dir,'unknown'),'keep');
  await assert.rejects(buildHdPreview(f.options),{code:'EXTERNAL_RESULT_UNKNOWN'});
  assert.equal(await fs.readFile(path.join(dir,'unknown'),'utf8'),'keep');
  await assert.rejects(fs.stat(path.join(f.root,'calls')),{code:'ENOENT'});
});

test('HD preview rejects a matching-hash short film, missing native physics and corrupt stills without rerendering',async t=>{
  const f=await fixture(t),result=await buildHdPreview(f.options),provenance=path.join(f.taskRoot,result.provenancePath);
  const original=JSON.parse(await fs.readFile(provenance,'utf8'));
  const video=path.join(f.taskRoot,result.videoPath),videoBefore=await fs.readFile(video);
  await promisify(execFile)(ffmpeg,['-hide_banner','-v','error','-f','lavfi','-i','color=c=black:s=1920x1080:r=30',
    '-frames:v','30','-an','-c:v','libx264','-preset','ultrafast','-threads','1','-pix_fmt','yuv420p',path.join(f.root,'seed/short.mp4')]);
  await fs.copyFile(path.join(f.root,'seed/short.mp4'),video);
  await f.write(result.provenancePath,{...original,video:{file:original.video.file,...await digest(video)}});
  await assert.rejects(buildHdPreview(f.options),{code:'HD_PREVIEW_INVALID'});
  await fs.writeFile(video,videoBefore);
  await f.write(result.provenancePath,{...original,physics:{...original.physics,nativeEvaluations:0}});
  await assert.rejects(buildHdPreview(f.options),{code:'HD_PREVIEW_INVALID'});
  const face=path.join(f.taskRoot,result.facePath);await fs.writeFile(face,Buffer.from('89504e470d0a1a0a','hex'));
  await f.write(result.provenancePath,{...original,stills:await Promise.all(original.stills.map(async s=>s.file==='face.png'?{file:s.file,...await digest(face)}:s))});
  await assert.rejects(buildHdPreview(f.options),{code:'HD_PREVIEW_INVALID'});
  assert.equal(await fs.readFile(path.join(f.root,'calls'),'utf8'),'1');
});
