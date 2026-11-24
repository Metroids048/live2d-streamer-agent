import path from 'node:path';
import os from 'node:os';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {lstat,open,readFile,readdir,realpath,stat} from 'node:fs/promises';
import {sha256,safePath,readJson,writeBound,writeJson} from './files.mjs';
import {decodePng,alphaBounds} from './png.mjs';
import {checkIncludedWaveQuota} from './codex-wave-quota.mjs';

const exec=promisify(execFile);
const binary=path.join(os.homedir(),'Desktop/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
const uuid=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const generatedName=/^exec-[0-9a-f-]{36}\.png$/i;
const pending=code=>({status:'awaiting_external_result',code});
const blocked=code=>({status:'blocked',code});

async function readEvents(file) {
  try {
    if((await stat(file)).size>48*1024*1024)throw new Error('CODEX_WAVE_EVENT_LIMIT');
    const lines=(await readFile(file,'utf8')).split('\n');lines.pop();
    return lines.filter(Boolean).map(v=>JSON.parse(v));
  } catch(e){if(e.code==='ENOENT')return [];throw e;}
}

async function collect({root,rel,receipt,generatedRoot}) {
  const artifactPath=rel+'/raised-arm.png';
  if(receipt.resultSha256){
    const bytes=await readFile(await safePath(root,artifactPath));
    if(sha256(bytes)!==receipt.resultSha256)throw new Error('CODEX_WAVE_CACHE_CHANGED');
    return {status:'completed',file:artifactPath,sha256:receipt.resultSha256};
  }
  const events=await readEvents(await safePath(root,rel+'/events.jsonl'));
  const ids=events.filter(e=>e.type==='thread.started').map(e=>e.thread_id);
  if(ids.length>1||ids.length===1&&!uuid.test(ids[0]))return blocked('CODEX_WAVE_THREAD_MISMATCH');
  if(events.some(e=>e.type==='turn.failed'))return blocked('CODEX_WAVE_GENERATION_FAILED');
  if(!ids.length||!events.some(e=>e.type==='turn.completed')) {
    if(receipt.launchFailed)return blocked('CODEX_WAVE_LAUNCH_FAILED');
    if(receipt.pid) {
      try{process.kill(receipt.pid,0);}catch(e){if(e.code==='ESRCH')return pending('EXTERNAL_RESULT_UNKNOWN');throw e;}
    }
    return pending(Date.now()-receipt.startedAt>3600000?'EXTERNAL_RESULT_UNKNOWN':'CODEX_WAVE_PENDING');
  }
  const dir=path.join(generatedRoot,ids[0]);
  let names;
  try {
    if(await realpath(dir)!==dir)return blocked('CODEX_WAVE_PATH_INVALID');
    names=(await readdir(dir)).filter(name=>generatedName.test(name));
  } catch(e){if(e.code==='ENOENT')return blocked('CODEX_WAVE_PIXELS_MISSING');throw e;}
  if(names.length!==1)return blocked(names.length?'CODEX_WAVE_AMBIGUOUS_OUTPUT':'CODEX_WAVE_PIXELS_MISSING');
  const file=path.join(dir,names[0]),info=await lstat(file);
  if(!info.isFile()||info.size>16*1024*1024||info.mtimeMs<receipt.startedAt-1000)return blocked('CODEX_WAVE_PATH_INVALID');
  const bytes=await readFile(file),image=decodePng(bytes),alpha=alphaBounds(image);
  if(!image.hasAlpha||!alpha.opaquePixels||alpha.transparentPixels<image.width*image.height*.5)return blocked('CODEX_WAVE_RGBA_REQUIRED');
  const resultSha256=sha256(bytes);
  await writeBound(root,artifactPath,bytes);
  await writeJson(root,rel+'/receipt.json',{...receipt,threadId:ids[0],outputName:names[0],resultSha256,
    width:image.width,height:image.height,alphaBounds:alpha,completedAt:new Date().toISOString(),artifactPath});
  return {status:'completed',file:artifactPath,sha256:resultSha256};
}

// One host-managed ChatGPT image-generation operation. No OpenAI Images API key,
// paid fallback or automatic second generation. Recovery inspects only this thread.
export async function obtainWaveArtwork(input,{taskRoot,authorization,cli=binary,spawnProcess=spawn,checkQuota=checkIncludedWaveQuota,
  purpose='raised-arm',checkLogin=async()=>{const r=await exec(cli,['login','status'],{timeout:10000});return /chatgpt/i.test(r.stdout+r.stderr);},
  generatedRoot=path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'generated_images')}={}) {
  if(input.rights?.allowDerivatives!==true)return blocked('RIGHTS_UNRESOLVED');
  const sourcePath=await safePath(taskRoot,input.sourceImage.path);
  if(sha256(await readFile(sourcePath))!==input.sourceImage.sha256)throw new Error('CODEX_WAVE_INPUT_CHANGED');
  const rest=input.brief?.imageObservation?.materialRegions?.find(r=>r.semantic==='gesture:wave:rest')?.box;
  if(!input.brief?.intent?.actions?.some(a=>a.id==='wave')||!Array.isArray(rest)||rest.length!==4||
      !rest.every(v=>Number.isFinite(v)&&v>=0&&v<=1)||rest[0]>=rest[2]||rest[1]>=rest[3])return blocked('WAVE_REST_REGION_REQUIRED');
  if(!['raised-arm','palm'].includes(purpose))return blocked('CODEX_WAVE_PURPOSE_INVALID');
  const prompt=purpose==='palm'?[
    'Use the built-in image generation tool exactly once. Return one transparent PNG. Do not use any other tool, shell, external service or image API.',
    'Using the attached character as style and color reference, draw only one open greeting palm with five separate natural fingers and a short wrist. Match the character skin, fine outlines and cel shading. Show palm creases and finger joints with restrained shading.',
    'Palm faces the viewer, wrist is at the bottom, all fingers point upward and spread naturally, thumb is on image right. Include generous transparent margins. The source sleeve-hand region is '+JSON.stringify(rest)+'.',
    'Exclude sleeve, clothing, body, face, other hand, backgrounds, labels and guides. Use transparent_background true. End immediately after generation.'
  ].join('\n'):[
    'Use the built-in image generation tool exactly once to edit the attached character. Return exactly one transparent PNG. Do not use any other tool, shell, external service or image API.',
    'Draw one complete raised greeting arm for this same character, including the garment shoulder cap, original sleeve trim and ties, forearm, palm and five natural fingers. Preserve the original drawing style, palette and line width.',
    'The left/top/right/bottom normalized source rectangle for the currently resting sleeve and arm is '+JSON.stringify(rest)+'. Attach the new garment shoulder cap to the SAME shoulder location in the SAME full-body canvas framing. The hand waves above shoulder height outward from the body. Keep original source canvas proportions and empty margins.',
    'Output ONLY this one connected raised sleeve, arm and hand on fully transparent canvas. Exclude all body, head, other arm, accessories outside this arm, ground, labels, guide lines and old resting hand. Never output the source whole figure. Use transparent_background true. End immediately after generation.'
  ].join('\n');
  const identity={taskId:input.taskId,candidateId:input.candidateId,revision:input.revision,inputSha256:input.inputSha256,
    sourceSha256:input.sourceImage.sha256,descriptionSha256:input.descriptionSha256,recipe:purpose==='palm'?'codex-built-in-palm-v1':'codex-built-in-wave-v1',promptSha256:sha256(prompt)};
  const editRoot=purpose==='palm'?'artwork/palm-edit':'artwork/wave-edit';
  const rel=editRoot+'/'+sha256(JSON.stringify(identity));
  const receiptPath=await safePath(taskRoot,rel+'/receipt.json',{mkdirParents:true});
  const activeRel=editRoot+'/operation.json';
  const active=await readJson(taskRoot,activeRel);
  if(active&&active.receipt!==rel+'/receipt.json')return blocked('CODEX_WAVE_CANDIDATE_IMMUTABLE');
  const existing=await readJson(taskRoot,rel+'/receipt.json');
  if(existing) {
    if(JSON.stringify(existing.identity)!==JSON.stringify(identity))throw new Error('CODEX_WAVE_CACHE_CHANGED');
    return collect({root:taskRoot,rel,receipt:existing,generatedRoot});
  }
  if(authorization?.codexWaveEdit!==true||authorization.taskId!==identity.taskId||
    authorization.candidateId!==identity.candidateId||authorization.revision!==identity.revision)return blocked('CODEX_WAVE_SCOPE_REQUIRED');
  if(!await checkLogin())return blocked('CODEX_CHATGPT_LOGIN_REQUIRED');
  if(authorization.includedOnly) {
    const key=input.operation?.operationKey;
    if(!/^intake-vision-[a-f0-9]{64}$/.test(key??'')||input.operation.status!=='completed'||!input.brief.intent.actions.some(a=>a.id==='wave'&&a.source==='user'))return blocked('CODEX_WAVE_NATIVE_INTAKE_REQUIRED');
    const vision=await readJson(taskRoot,'intake/codex-vision/'+key+'/receipt.json');
    if(vision?.status!=='completed'||vision.imageSha256!==input.sourceImage.sha256||vision.inputSha256!==input.inputSha256||
      vision.descriptionSha256!==input.descriptionSha256||!['taskId','candidateId','revision'].every(k=>vision[k]===input[k]))return blocked('CODEX_WAVE_NATIVE_INTAKE_REQUIRED');
    const quotaIssue=await checkQuota(cli);if(quotaIssue)return blocked(quotaIssue);
  }
  const receipt={identity,startedAt:Date.now(),submitCount:1};
  if(!active) {
    // Check legacy receipts before atomically pinning one edit per candidate.
    const dir=path.dirname(path.dirname(receiptPath));
    for(const name of await readdir(dir)) {
      if(/^[a-f0-9]{64}$/.test(name)&&name!==path.basename(rel)&&await readJson(taskRoot,editRoot+'/'+name+'/receipt.json'))
        return blocked('CODEX_WAVE_CANDIDATE_IMMUTABLE');
    }
    let claim;
    try{claim=await open(await safePath(taskRoot,activeRel),'wx',0o600);await claim.writeFile(JSON.stringify({receipt:rel+'/receipt.json'}));await claim.sync();}
    catch(e){if(e.code==='EEXIST')return pending('CODEX_WAVE_PENDING');throw e;}finally{await claim?.close();}
  }
  let marker;
  try{marker=await open(receiptPath,'wx',0o600);await marker.writeFile(JSON.stringify(receipt));await marker.sync();}
  catch(e){if(e.code==='EEXIST')return pending('CODEX_WAVE_PENDING');throw e;}finally{await marker?.close();}
  const dir=path.dirname(receiptPath);
  const events=await open(path.join(dir,'events.jsonl'),'wx',0o600);
  const errors=await open(path.join(dir,'stderr.log'),'wx',0o600);
  try{
    await writeBound(taskRoot,rel+'/prompt.txt',Buffer.from(prompt));
    const args=['exec','-c','forced_login_method="chatgpt"','-c','model_provider="openai"','--skip-git-repo-check','--sandbox','read-only','--disable','shell_tool','--disable','multi_agent',
      '--enable','image_generation','--cd',dir,'--json','--color','never','--image',sourcePath,'-'];
    let child;
    try{child=spawnProcess(cli,args,{cwd:dir,detached:true,stdio:['pipe',events.fd,errors.fd]});
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});}
    catch {await writeJson(taskRoot,rel+'/receipt.json',{...receipt,launchFailed:true});return blocked('CODEX_WAVE_LAUNCH_FAILED');}
    child.stdin.on('error',()=>{});child.stdin.end(prompt);child.unref();
    await writeJson(taskRoot,rel+'/receipt.json',{...receipt,pid:child.pid});
  } finally {await events.close();await errors.close();}
  return pending('CODEX_WAVE_PENDING');
}
