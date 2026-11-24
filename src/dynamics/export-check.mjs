import * as fs from 'node:fs/promises';
import path from 'node:path';
import {Fault} from '../rpc.mjs';
import {taskFile,relativePath} from './files.mjs';

const near=(a,b)=>typeof a==='number'&&typeof b==='number'&&Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=1e-5*Math.max(1,Math.abs(b));
const equal=(a,b)=>typeof b==='number'?near(a,b):Array.isArray(b)?Array.isArray(a)&&a.length===b.length&&b.every((v,i)=>equal(a[i],v)):
  b&&typeof b==='object'?a&&Object.keys(a).length===Object.keys(b).length&&Object.entries(b).every(([k,v])=>equal(a[k],v)):a===b;
const requireThat=(condition,message)=>{if(!condition)throw new Fault('DYNAMICS_EXPORT_INVALID',message);};

export function matchingMotionClip(actual,expected) {
  const normalized=clip=>({duration:clip?.duration,fps:clip?.fps,loop:clip?.loop,fade_in:clip?.fade_in,fade_out:clip?.fade_out,
    curves:clip?.curves?.map(c=>({parameter:c.parameter,keys:c.keys?.map(k=>({time:k.time,value:k.value,
      interpolation:k.interpolation??'BEZIER',out:k.out??[1/3,0],in:k.in??[1/3,0]}))}))});
  return equal(normalized(actual),normalized(expected));
}

function motionMatches(data,clip) {
  if(data?.Version!==3||!near(data.Meta?.Duration,clip.duration)||data.Meta?.Loop!==clip.loop||data.Meta?.Fps!==clip.fps||
    !Array.isArray(data.Curves)||data.Curves.length!==clip.curves.length)return false;
  return clip.curves.every(c=>{
    const actual=data.Curves.filter(v=>v.Target==='Parameter'&&v.Id===c.parameter);
    if(actual.length!==1)return false;
    const expected=[c.keys[0].time,c.keys[0].value];
    for(let i=0;i<c.keys.length-1;i++) {
      const a=c.keys[i],b=c.keys[i+1],tag=['LINEAR','BEZIER','STEPPED','INVERSE_STEPPED'].indexOf(a.interpolation??'BEZIER');
      expected.push(tag);
      if(tag===1) {
        const out=a.out??[1/3,0],inn=b.in??[1/3,0],span=b.time-a.time;
        expected.push(a.time+out[0]*span,a.value+out[1],b.time-inn[0]*span,b.value+inn[1]);
      }
      expected.push(b.time,b.value);
    }
    return equal(actual[0].Segments,expected);
  });
}

// Verifies indexed files, not just resource counts or unused JSON in a folder.
export async function inspectDynamicsExport(root,modelPath,recipe) {
  const entry=await taskFile(root,modelPath),directory=path.dirname(entry);
  const read=async reference=>{
    requireThat(typeof reference==='string'&&!path.isAbsolute(reference)&&!reference.includes('\\')&&
      !reference.split('/').some(p=>!p||p==='.'||p==='..'),'导出引用越界或不合法');
    const file=await taskFile(root,relativePath(root,path.join(directory,reference)));
    requireThat(file.startsWith(directory+path.sep),'资源超出本动态模型目录');
    requireThat((await fs.stat(file)).size>0,'导出引用为空文件');return file;
  };
  const json=async ref=>JSON.parse(await fs.readFile(await read(ref),'utf8'));
  const model=JSON.parse(await fs.readFile(entry,'utf8')),refs=model.FileReferences;
  requireThat(model.Version===3&&refs,'缺少model3 FileReferences');
  await read(refs.Moc);
  requireThat(Array.isArray(refs.Textures)&&refs.Textures.length>0,'缺少图集');
  for(const ref of refs.Textures)await read(ref);
  for(const key of ['DisplayInfo','Pose','UserData'])if(refs[key])await read(refs[key]);
  const physics=await json(refs.Physics),settings=physics.PhysicsSettings??[];
  requireThat(physics.Version===3&&physics.Meta?.Fps===recipe.physicsFps,'物理格式/实际FPS不符');
  requireThat(equal(settings.map(s=>s.Id),recipe.physics.map(g=>g.id)),'导出物理组和执行顺序与本版配方不符');
  for(const g of recipe.physics) {
    const actual=settings.find(s=>s.Id===g.id);
    requireThat(actual,'model3所引用物理缺少组：'+g.id);
    requireThat(equal(actual.Output?.map(o=>o.Destination.Id).sort(),g.outputs.map(o=>o.parameter).sort()),'物理输出参数不符');
    requireThat(equal(actual.Input?.map(i=>({parameter:i.Source.Id,weight:i.Weight,type:i.Type.toLowerCase(),reflect:i.Reflect})),g.inputs),'物理输入不符');
    requireThat(equal(actual.Output.map(o=>({parameter:o.Destination.Id,vertex:o.VertexIndex,scale:o.Scale,weight:o.Weight,reflect:o.Reflect})),g.outputs)&&
      actual.Output.every(o=>o.Type==='Angle'&&Number.isFinite(o.Scale)&&o.Scale!==0),'物理输出类型或倍率不符');
    requireThat(equal(actual.Vertices?.slice(1).map(v=>({length:v.Radius,mobility:v.Mobility,delay:v.Delay,acceleration:v.Acceleration})),g.segments),'物理分段与配方不符');
    requireThat(equal(Object.fromEntries(['Position','Angle'].map(k=>[k.toLowerCase(),{
      min:actual.Normalization?.[k]?.Minimum,default:actual.Normalization?.[k]?.Default,max:actual.Normalization?.[k]?.Maximum}])),g.normalization),'物理归一化范围不符');
    for(const o of g.outputs)requireThat(settings.flatMap(s=>s.Output??[]).filter(v=>v.Destination?.Id===o.parameter).length===1,'物理输出存在重复writer');
  }
  const expressions=[];
  for(const e of recipe.expressions) {
    const indexed=refs.Expressions?.find(r=>r.Name===e.name);
    requireThat(indexed,'表情未登记到实际model3：'+e.id);
    const actual=await json(indexed.File);
    const expected=e.entries.map(v=>({Id:v.parameter,Value:v.value,Blend:v.blend}));
    requireThat(actual.Type==='Live2D Expression'&&equal(actual.Parameters,expected)&&near(actual.FadeInTime,e.fade_in)&&near(actual.FadeOutTime,e.fade_out),'表情文件与工程配方不符');
    expressions.push({id:e.id,name:e.name,file:relativePath(root,path.join(directory,indexed.File)),
      leafExpressionId:String(refs.Expressions.indexOf(indexed)),
      exclusiveGroup:recipe.appearanceGroups?.[e.id]??'emotion',parameters:e.entries.map(v=>v.parameter),enter:'activate owned resource',exit:'release owned resource token',
      trackingAllowed:true});
  }
  const indexedMotions=[];
  for(const [group,items] of Object.entries(refs.Motions??{}))for(let index=0;index<items.length;index++) {
    const item=items[index],data=await json(item.File);indexedMotions.push({group,index,file:item.File,data});
  }
  const motions=[];
  for(const m of recipe.motions) {
    const found=indexedMotions.find(({data:d,group})=>group===(m.loop?'Idle':m.name)&&motionMatches(d,m));
    requireThat(found,'动作未索引或曲线/时长不符：'+m.id);
    requireThat(found.data.Curves.every(c=>c.Target==='Parameter'&&c.Segments?.length>=5&&c.Segments.every(Number.isFinite)),'动作缺少有效曲线');
    motions.push({id:m.id,name:m.name,file:relativePath(root,path.join(directory,found.file)),group:found.group,index:found.index,
      leafMotionId:found.group+':'+found.index,
      duration:m.duration,loop:m.loop,fps:m.fps,parameters:m.curves.map(c=>c.parameter),
      enter:'activate owned resource',exit:'release owned resource token',hold:m.loop?'until cancelled':'release after duration'});
  }
  return {modelPath,physicsPath:relativePath(root,path.join(directory,refs.Physics)),expressions,motions};
}
