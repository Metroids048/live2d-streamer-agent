import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {safePath,sha256} from './files.mjs';
import {semanticTags} from './see-through.mjs';
import {fileURLToPath} from 'node:url';

const exec=promisify(execFile);
const processor=fileURLToPath(new URL('./materialize.py',import.meta.url));

// The backend retains the immutable provider files. Derived pixels can be rebuilt locally.
export async function materializeFlash(result,{sourcePath,brief,taskRoot,signal,wave,classificationSheet=false,repairCriteria=[]}) {
  const directory=await mkdtemp(path.join(taskRoot,'artwork','.materialize-'));
  try {
    const layers=[];
    for(const [i,part] of result.parts.entries()){
      const file=`coarse-${i}.png`;await writeFile(path.join(directory,file),part.png);
      const mapped=part.providerLabel&&semanticTags(part.providerLabel).join(':');
      layers.push({file,id:part.id,label:mapped||part.providerLabel,z:part.providerOrder,box:part.providerBox,observedOnSheet:part.observedOnSheet});
    }
    const regions=brief?.imageObservation?.materialRegions??[];
    if(wave) {
      const bytes=await readFile(await safePath(taskRoot,wave.file));
      if(sha256(bytes)!==wave.sha256)throw new Error('CODEX_WAVE_INPUT_CHANGED');
      await writeFile(path.join(directory,'wave.png'),bytes);
    }
    await writeFile(path.join(directory,'input.json'),JSON.stringify({sourcePath,layers,regions,classificationSheet,repairCriteria,wave:wave?'wave.png':null}));
    await exec('/usr/bin/python3',['-B',processor,directory],{timeout:120000,maxBuffer:65536,signal});
    const processed=JSON.parse(await readFile(path.join(directory,'result.json'),'utf8'));
    const parts=[];
    for(const part of processed.parts) {
      const {file,...properties}=part;
      parts.push({...properties,png:await readFile(path.join(directory,file))});
    }
    let sheet;
    if(classificationSheet) {
      try{sheet=await readFile(path.join(directory,'layer-sheet.png'));}catch(e){if(e.code!=='ENOENT')throw e;}
    }
    return {canvas:processed.canvas,parts,...(sheet?{sheet}:{}),quality:{...result.quality,registration:processed.registration,
      sourceCanvasMapping:{method:'source-pixels',verified:processed.registration.some(r=>r.registered)&&processed.registration.every(r=>r.registered||r.verifiedFullSourceReference||r.verifiedBackgroundOnly),...processed.canvas},
      processingNotes:processed.notes}};
  } finally {await rm(directory,{recursive:true,force:true});}
}
