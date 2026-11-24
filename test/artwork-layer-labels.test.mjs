import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {materializeFlash} from '../src/artwork/materialize.mjs';
import {labelFlashLayers,needsLayerLabels} from '../src/artwork/layer-labels.mjs';
import {createCodexVision} from '../src/pipeline/codex-vision.mjs';
import {cropPng,decodePng,encodePng} from '../src/artwork/png.mjs';
import {sha256,writeJson} from '../src/artwork/files.mjs';

async function setup(t) {
  const taskRoot=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'registered-label-sheet-')));
  t.after(()=>fs.rm(taskRoot,{recursive:true,force:true}));
  const sourcePath=path.join(taskRoot,'source.png'),source={width:60,height:60,data:Buffer.alloc(60*60*4)};
  for(let y=0;y<60;y++)for(let x=0;x<60;x++){
    source.data.set([(x*32+y*17)%211,(x*33+y*25)%243,(y*17+x*19)%241,255],(y*60+x)*4);
  }
  const png=encodePng(source);await fs.writeFile(sourcePath,png);
  await fs.mkdir(path.join(taskRoot,'artwork'));
  const raw={parts:[[25,12],[11,36]].map(([left,top],i)=>{
    const tile=cropPng(source,{left,top,width:12,height:10});tile.data[3]=0;
    return {id:'runninghub-layer-'+(i+1),png:encodePng(tile),providerLabel:'layer_'+(i+1)+'.png'};
  })};
  const material=await materializeFlash(raw,{taskRoot,sourcePath,classificationSheet:true});
  const operationKey='intake-vision-'+sha256('original intake');
  const input={taskId:'t',candidateId:'c',revision:1,inputSha256:sha256(png),descriptionSha256:sha256('requested'),sourceImage:{sha256:sha256(png)},operation:{status:'completed',operationKey}};
  const intakePath='intake/codex-vision/'+operationKey+'/receipt.json';
  const receipt={...input,operationKey,status:'completed',imageSha256:sha256(png)};
  const backToFront=raw.parts.map(p=>p.id).reverse();
  const response={backToFront,orderConfidence:'clear',layers:raw.parts.map((p,i)=>({id:p.id,role:i?'neck':'face',confidence:'clear',observation:'Fixture observation for the registered tile.'}))};
  return {taskRoot,sourcePath,raw,material,input,intakePath,receipt,response};
}

test('numbered layers need a fully registered sheet and the same native source before model labeling',async t=>{
  const {taskRoot,raw,material,input,intakePath,receipt}=await setup(t);
  assert.equal(needsLayerLabels(raw.parts),true);
  assert.equal(needsLayerLabels([{providerLabel:'output-2.png'},{providerLabel:'  '}]),true);
  assert.equal(needsLayerLabels([{providerLabel:'hat_1.png'}]),false);
  assert.equal(material.quality.sourceCanvasMapping.verified,true);
  assert.equal(decodePng(material.sheet).width,900);
  const ctx={input,taskRoot,vision:{describeImage(){assert.fail('no call allowed');}}};
  assert.equal((await labelFlashLayers(raw,material,ctx)).code,'ARTWORK_LABEL_SOURCE_UNVERIFIED');
  await writeJson(taskRoot,intakePath,{...receipt,candidateId:'other'});
  assert.equal((await labelFlashLayers(raw,material,ctx)).code,'ARTWORK_LABEL_SOURCE_UNVERIFIED');
  assert.equal(await labelFlashLayers(raw,{...material,sheet:undefined},ctx),null);
  assert.equal(await labelFlashLayers(raw,{...material,quality:{sourceCanvasMapping:{verified:false}}},ctx),null);
  assert.equal(await labelFlashLayers({parts:[{...raw.parts[0],providerLabel:'face'}]},material,ctx),null);
});

test('one late original scoped visual result labels unchanged pixels in the observed order',async t=>{
  const {taskRoot,sourcePath,raw,material,input,intakePath,receipt,response}=await setup(t);
  await writeJson(taskRoot,intakePath,receipt);
  let calls=0;
  const vision=createCodexVision({taskRoot,scope:'layer_labels',binary:process.execPath,waitMs:4,pollMs:2,
    spawnProcess(binary,args,options){
      calls++;
      assert(args.includes('forced_login_method="chatgpt"'));
      assert(args.includes('image_generation')&&args[args.indexOf('image_generation')-1]==='--disable');
      const file=args[args.indexOf('--output-last-message')+1];
      assert(file.includes('/artwork/codex-labels/artwork-labels-'));
      return spawn(process.execPath,['-e',"process.stdin.resume();setTimeout(()=>require('fs').writeFileSync(process.argv[1],process.argv[2]),100);",file,JSON.stringify(response)],options);
    }});
  assert.equal((await labelFlashLayers(raw,material,{input,taskRoot,vision})).code,'ARTWORK_LABEL_RESULT_UNKNOWN');
  await delay(140);
  const recovered=createCodexVision({taskRoot,scope:'layer_labels',waitMs:5000,pollMs:15,spawnProcess:()=>assert.fail('do not resubmit')});
  const classified=await labelFlashLayers(raw,material,{input,taskRoot,vision:recovered});
  assert.equal(calls,1);
  assert.equal(classified.raw.quality.layerObservation.confirmed,true);
  assert.equal(classified.sheet.sha256,sha256(material.sheet));
  assert.deepEqual(classified.raw.parts.map(p=>p.providerLabel),['face','neck']);
  assert.deepEqual(classified.raw.parts.map(p=>p.providerOrder),[1,0]);
  assert.deepEqual(classified.raw.parts.map(p=>sha256(p.png)),raw.parts.map(p=>sha256(p.png)));
  const concrete=await materializeFlash(classified.raw,{taskRoot,sourcePath});
  assert.deepEqual(concrete.parts.map(p=>[p.id,p.tags]),[
    ['runninghub-layer-2',['neck']],['runninghub-layer-1',['face']]
  ]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(taskRoot,intakePath))),receipt);
});

test('ambiguous or malformed classifications never add speculative layer roles',async t=>{
  const {taskRoot,raw,material,input,intakePath,receipt,response}=await setup(t);
  await writeJson(taskRoot,intakePath,receipt);
  const check=answer=>labelFlashLayers(raw,material,{input,taskRoot,vision:{recoverDescription:async()=>({status:'completed',response:answer})}});
  for(const answer of [{...response,layers:{}},{...response,layers:[null,null]},{...response,backToFront:['wrong','wrong']}]){
    assert.equal((await check(answer)).code,'ARTWORK_LABEL_RESPONSE_INVALID');
  }
  const uncertain=structuredClone(response);
  uncertain.orderConfidence='uncertain';uncertain.layers[0].confidence='uncertain';uncertain.layers[1].role='other';
  const result=await check(uncertain);
  assert.equal(result.raw.quality.layerObservation.confirmed,false);
  for(const p of result.raw.parts){assert.equal(p.providerLabel,undefined);assert.equal(p.providerOrder,undefined);assert.equal(p.observedOnSheet,true);}
});
