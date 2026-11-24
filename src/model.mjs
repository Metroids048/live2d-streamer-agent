import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

export async function inspectModel(filename) {
  const errors=[],files=[]; let doc,base;
  try {base=await fs.realpath(path.dirname(filename));doc=JSON.parse(await fs.readFile(filename,'utf8'));}
  catch {return {ok:false,errors:[{code:'MODEL_JSON_MISSING_OR_INVALID',file:filename}],files};}
  const r=doc.FileReferences ?? {};
  const entry = x => x && typeof x === 'object' && typeof x.File === 'string';
  if(!r || !Array.isArray(r.Textures) || (r.Expressions && (!Array.isArray(r.Expressions)||!r.Expressions.every(entry))) || (r.Motions && (typeof r.Motions!=='object'||Array.isArray(r.Motions)||Object.values(r.Motions).some(x=>!Array.isArray(x)||!x.every(entry))))) return {ok:false,file:filename,errors:[{code:'INVALID_FILE_REFERENCES'}],files};
  const refs=[['Moc',r.Moc],...(r.Textures??[]).map(x=>['Texture',x]),...['Physics','Pose','UserData','DisplayInfo'].filter(x=>r[x]).map(x=>[x,r[x]]),...(r.Expressions??[]).map(x=>['Expression',x.File]),...Object.values(r.Motions??{}).flat().map(x=>['Motion',x.File]),...Object.values(r.Motions??{}).flat().filter(x=>x.Sound).map(x=>['Sound',x.Sound])];
  if (!r.Moc) errors.push({code:'MOC_MISSING'});
  if (!r.Textures?.length) errors.push({code:'TEXTURES_MISSING'});
  for(const [kind,ref] of refs) {
    if(typeof ref!=='string'||path.isAbsolute(ref)) {errors.push({code:'INVALID_REFERENCE',kind,file:ref});continue;}
    try {
      const p=await fs.realpath(path.resolve(base,ref));
      if(!p.startsWith(base+path.sep)) {errors.push({code:'REFERENCE_OUTSIDE_MODEL',kind,file:ref});continue;}
      const data=await fs.readFile(p);
      if(!data.length) throw new Error('empty');
      if(kind==='Moc'&&data.subarray(0,4).toString()!=='MOC3') {errors.push({code:'INVALID_MOC3',file:ref});continue;}
      if(kind==='Texture'&&!data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {errors.push({code:'INVALID_PNG_TEXTURE',file:ref});continue;}
      if(['Expression','Physics','Motion','Pose','UserData','DisplayInfo'].includes(kind)) JSON.parse(data.toString());
      files.push({kind,file:ref,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')});
    } catch {errors.push({code:'REFERENCE_MISSING_OR_INVALID',kind,file:ref});}
  }
  return {ok:errors.length===0,file:filename,errors,files,expressionCount:(r.Expressions??[]).length};
}

export async function findModels(root,depth=0) {
  if(!root || depth>5) return [];
  let entries;try {entries=await fs.readdir(root,{withFileTypes:true});} catch {return [];}
  const out=[];
  for(const e of entries) {
    if(e.isSymbolicLink()) continue;
    const p=path.join(root,e.name);
    if(e.isDirectory()) out.push(...await findModels(p,depth+1));
    else if(e.name.endsWith('.model3.json')) out.push(p);
  }
  return out;
}
