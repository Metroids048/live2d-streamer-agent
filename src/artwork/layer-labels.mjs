import {readFile} from 'node:fs/promises';
import {decodePng} from './png.mjs';
import {artifact,readJson,safePath,sha256,writeBound} from './files.mjs';

const roles=['unknown','other','face','neck','hair:front','hair:back','nose','upper-body','lower-body','brow:left','brow:right'];
const object=properties=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
const schema=object({orderConfidence:{type:'string',enum:['clear','uncertain']},backToFront:{type:'array',items:{type:'string'}},
  layers:{type:'array',items:object({id:{type:'string'},role:{type:'string',enum:roles},confidence:{type:'string',enum:['clear','uncertain']},observation:{type:'string'}})}});
const instructions='The first cell is SOURCE. Each numbered cell shows the same separate layer at its registered location (left) and its enlarged real pixels (right). Use only pictured IDs. Identify each layer once, including a brief visible observation; give backToFront using those IDs exactly once. Character-relative left is usually on the right of a frontal image. Choose clear only when pixels establish a single coherent role. Mixed fragments, a head with inseparable face and bangs, ambiguous anatomy or uncertain layering must stay uncertain. other is a recognizable independent layer outside these named controls. Do not promote tiny skin patches to face or small strands to full front/back hair. Never infer hidden shapes.';

export function needsLayerLabels(parts) {
  return parts.length>0&&parts.every(p=>p.providerLabel==null||typeof p.providerLabel==='string'&&
    (!p.providerLabel.trim()||/^(?:(?:layer|output)[ _-]*)?\d+(?:\.png)?$/i.test(p.providerLabel.trim())));
}

export async function labelFlashLayers(raw,material,{input,taskRoot,vision,signal}) {
  if(!vision||!material.sheet||!material.quality.sourceCanvasMapping.verified||!needsLayerLabels(raw.parts))return null;
  const ids=material.quality.registration.filter(r=>r.registered).map(r=>r.id);
  if(!ids.length)return null;
  const old=input.operation?.operationKey;
  if(!/^intake-vision-[a-f0-9]{64}$/.test(old??'')||input.operation.status!=='completed')return {code:'ARTWORK_LABEL_SOURCE_UNVERIFIED'};
  const intake=await readJson(taskRoot,'intake/codex-vision/'+old+'/receipt.json');
  if(intake?.status!=='completed'||intake.imageSha256!==input.sourceImage.sha256||!['taskId','candidateId','revision','inputSha256','descriptionSha256'].every(k=>intake[k]===input[k]))return {code:'ARTWORK_LABEL_SOURCE_UNVERIFIED'};
  const sheetSha=sha256(material.sheet),sheetPath='artwork/label-sheets/'+sheetSha+'.png';
  const sourceId=raw.parts.map(p=>[p.id,sha256(p.png)]);
  const operationKey='artwork-labels-'+sha256(JSON.stringify([input.taskId,input.candidateId,input.revision,input.sourceImage.sha256,input.descriptionSha256,sourceId,instructions,schema]));
  const file=await safePath(taskRoot,sheetPath,{mkdirParents:true});
  try{if(sha256(await readFile(file))!==sheetSha)throw new Error('ARTWORK_LABEL_SHEET_CHANGED');}
  catch(e){if(e.code!=='ENOENT')throw e;await writeBound(taskRoot,sheetPath,material.sheet);}
  const {width,height}=decodePng(material.sheet);
  let response;
  try {
    const request={operationKey,taskId:input.taskId,candidateId:input.candidateId,revision:input.revision,
      inputSha256:input.inputSha256,descriptionSha256:input.descriptionSha256,description:'Identify the visible registered layers in this contact sheet.',
      image:{path:file,sha256:sheetSha,mimeType:'image/png',width,height},instructions,outputSchema:schema,signal};
    const existing=await vision.recoverDescription?.(request);
    if(existing?.status==='completed')response=existing.response;
    else if(!existing||existing.status==='not_found')response=await vision.describeImage(request);
    else return {code:['submitted','running','unknown'].includes(existing.status)?'ARTWORK_LABEL_RESULT_UNKNOWN':'ARTWORK_LABELS_UNAVAILABLE'};
  } catch(e){if(signal?.aborted)throw e;return {code:e.code==='EXTERNAL_RESULT_UNKNOWN'?'ARTWORK_LABEL_RESULT_UNKNOWN':'ARTWORK_LABELS_UNAVAILABLE'};}
  const exact=list=>Array.isArray(list)&&list.length===ids.length&&new Set(list).size===list.length&&list.every(id=>ids.includes(id));
  if(!Array.isArray(response?.layers)||!exact(response.layers.map(l=>l?.id))||!exact(response.backToFront)||!['clear','uncertain'].includes(response.orderConfidence)||
     !response.layers.every(l=>roles.includes(l.role)&&['clear','uncertain'].includes(l.confidence)&&typeof l.observation==='string'&&l.observation.trim().length>=4&&l.observation.length<=1000))return {code:'ARTWORK_LABEL_RESPONSE_INVALID'};
  const byId=new Map(response.layers.map(r=>[r.id,r]));
  const parts=raw.parts.map(p=>{
    const r=byId.get(p.id);if(!r)return p;
    const label=r.confidence==='clear'&&!['unknown','other'].includes(r.role)?r.role:undefined;
    return {...p,providerLabel:label,observedOnSheet:true,providerOrder:response.orderConfidence==='clear'?response.backToFront.indexOf(p.id):p.providerOrder};
  });
  const confirmed=response.orderConfidence==='clear'&&response.layers.every(r=>r.confidence==='clear'&&r.role!=='unknown');
  return {raw:{...raw,parts,quality:{...raw.quality,layerObservation:{kind:'model',operationKey,sheetPath,sheetSha,confirmed,...response}}},
    sheet:await artifact(taskRoot,sheetPath,'artwork_label_sheet')};
}
