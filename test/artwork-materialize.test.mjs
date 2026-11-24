import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {includedWaveQuota} from '../src/artwork/codex-wave-quota.mjs';
import {materializeFlash} from '../src/artwork/materialize.mjs';
import {obtainWaveArtwork} from '../src/artwork/codex-wave.mjs';
import {sha256} from '../src/artwork/files.mjs';
import {decodePng,encodePng,cropPng} from '../src/artwork/png.mjs';

test('registers a uniquely textured trimmed Flash layer to original coordinates and preserves its pixels',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'flash-material-test-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await fs.mkdir(path.join(dir,'artwork'));const sourcePath=path.join(dir,'source.png');
  const source={width:60,height:60,data:Buffer.alloc(60*60*4)};
  for(let y=0;y<60;y++)for(let x=0;x<60;x++){
    const i=(y*60+x)*4;source.data.set([(x*32+y*17)%211,(x*33+y*25)%243,(y*17+x*19)%241,255],i);
  }
  await fs.writeFile(sourcePath,encodePng(source));
  const tile=cropPng(source,{left:25,top:12,width:12,height:10});tile.data[3]=0;
  const r=await materializeFlash({parts:[{id:'test-layer',providerLabel:'neck',png:encodePng(tile)},{id:'base',png:encodePng(source)}]}, {taskRoot:dir,sourcePath});
  assert.equal(r.quality.sourceCanvasMapping.verified,true);
  assert.equal(r.parts[1].reference,true);
  assert.deepEqual(r.parts[0].rect,{left:25,top:12,width:12,height:10});
  assert.deepEqual(decodePng(r.parts[0].png).data,tile.data);
});

for(const purpose of ['raised-arm','palm'])test(purpose+' artwork requires the scoped candidate and collects exactly its own successful CLI output once',async t=>{
  const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'codex-wave-test-'));const dir=await fs.realpath(tmp);
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));const generatedRoot=path.join(dir,'generated');
  await fs.mkdir(path.join(dir,'intake'));const png=encodePng({width:4,height:4,data:Buffer.from(Array.from({length:16},(_,i)=>[120,44,8,i<2?255:0]).flat())});
  await fs.writeFile(path.join(dir,'intake/normalized.png'),png);
  const input={rights:{allowDerivatives:true},taskId:'t',candidateId:'c',revision:1,inputSha256:sha256(png),descriptionSha256:sha256('wave'),
    sourceImage:{path:'intake/normalized.png',sha256:sha256(png)},brief:{intent:{actions:[{id:'wave',source:'user'}]},imageObservation:{materialRegions:[{semantic:'gesture:wave:rest',box:[.3,.4,.5,.9]}]}}};
  const id=randomUUID();let launches=0;
  const opts={purpose,taskRoot:dir,generatedRoot,checkLogin:async()=>true,authorization:{taskId:'t',candidateId:'c',revision:1,codexWaveEdit:true},
    spawnProcess(_binary,_args,flags){
      launches++;
      // Synthetic isolated CLI fixture. The real worker only consumes PNGs below its own thread UUID.
      const code='const fs=require("fs"),p=require("path");const dir=process.argv[1];fs.mkdirSync(dir,{recursive:true});fs.copyFileSync(process.argv[2],p.join(dir,process.argv[3]));console.log(JSON.stringify({type:"thread.started",thread_id:process.argv[4]}));console.log(JSON.stringify({type:"turn.completed"}));';
      return spawn(process.execPath,['-e',code,path.join(generatedRoot,id),path.join(dir,'intake/normalized.png'),'exec-'+randomUUID()+'.png',id],flags);
    }};
  assert.equal((await obtainWaveArtwork(input,{...opts,authorization:{}})).code,'CODEX_WAVE_SCOPE_REQUIRED');
  assert.equal((await obtainWaveArtwork(input,opts)).code,'CODEX_WAVE_PENDING');
  let result;for(let i=0;i<80;i++){
    result=await obtainWaveArtwork(input,opts);if(result.status==='completed')break;
    await new Promise(r=>setTimeout(r,25));
  }
  assert.equal(result.status,'completed');assert.equal(result.sha256,sha256(png));assert.equal(launches,1);
  assert.ok(result.file.startsWith(purpose==='palm'?'artwork/palm-edit/':'artwork/wave-edit/'));
  assert.deepEqual(await obtainWaveArtwork(input,opts),result);
  const changed=structuredClone(input);changed.brief.imageObservation.materialRegions[0].box[1]=.3;
  assert.equal((await obtainWaveArtwork(changed,opts)).code,'CODEX_WAVE_CANDIDATE_IMMUTABLE');
  await fs.appendFile(path.join(dir,result.file),'stale');
  await assert.rejects(obtainWaveArtwork(input,opts),/CODEX_WAVE_CACHE_CHANGED/);assert.equal(launches,1);
});

test('included wave generation never falls back to purchased credits or an exhausted window',()=>{
  const allowance={planType:'pro',primary:{usedPercent:35},credits:{hasCredits:false,unlimited:false}};
  assert.equal(includedWaveQuota(allowance),null);
  assert.equal(includedWaveQuota({...allowance,credits:{hasCredits:true,unlimited:false}}),'CODEX_WAVE_PAID_FALLBACK_UNVERIFIED');
  assert.equal(includedWaveQuota({...allowance,secondary:{usedPercent:100}}),'CODEX_WAVE_QUOTA_EXHAUSTED');
  assert.equal(includedWaveQuota({...allowance,planType:'enterprise'}),'CODEX_WAVE_INCLUDED_QUOTA_UNKNOWN');
});

test('Hachi speech and blink drawings stay tied to original facial observations and start hidden',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'artwork-pose-test-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await fs.mkdir(path.join(dir,'artwork'));
  const sourcePath=path.resolve('evidence/single-image-live2d/00/hachi-front.png');
  const proof=JSON.parse(await fs.readFile('evidence/single-image-live2d/02/hachi-native-material-development/provenance.json'));
  const result=await materializeFlash({parts:[]},{taskRoot:dir,sourcePath,brief:{imageObservation:{materialRegions:proof.regions}}});
  const posed=result.parts.filter(p=>p.tags.includes('open')||p.tags.includes('eye')&&p.tags.includes('closed'));
  assert.equal(posed.length,5);
  for(const p of posed){assert.equal(p.visible,false);assert.equal(p.origin,'generated');assert.equal(p.variant.type,'switch');}
  assert.equal(new Set(posed.map(p=>sha256(p.png))).size,5);
  assert.equal(result.parts.filter(p=>p.tags.includes('line')&&p.tags.includes('open')).length,2);
  assert.equal(result.parts.find(p=>p.tags.includes('mouth')&&p.tags.includes('closed')).visible,true);
  assert.equal(result.quality.sourceCanvasMapping.verified,false);
  const bare=await materializeFlash({parts:[]},{taskRoot:dir,sourcePath,brief:{}});
  assert.equal(bare.parts.length,0);
});


test('visible upper eyelid pigment stays on the skin while the separate dark line can blink',()=>{
  execFileSync('/usr/bin/python3',['-B',path.resolve('test/eye-rim-check.py')],{timeout:15000});
});
