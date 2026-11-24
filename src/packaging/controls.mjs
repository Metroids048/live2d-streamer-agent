import {json, reject} from './files.mjs';
import {hasMovingShape} from '../dynamics/recipe.mjs';
import {emotionPresets,gestureClips,gestureAxes,includeStreamerPresets} from '../rigging/streamer-presets.mjs';

const requireThat = (v, why) => { if (!v) reject('REFERENCE_INVALID', why); };
const named = (rows, key) => {
  requireThat(Array.isArray(rows), '缺少' + key + '需求清单');
  const ids = rows.map(row => row?.id);
  requireThat(ids.every(id => typeof id === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(id)) &&
    new Set(ids).size === ids.length, key + '需求 ID 无效或重复');
  return ids;
};
const sameSet = (a, b) => Array.isArray(a) && a.length === b.length && new Set(a).size === a.length && new Set(b).size === b.length && b.every(id => a.includes(id));

export function verifyCoverage(requested, expressions, motions) {
  requireThat(['expressions','actions','clothingVariants'].every(key=>Array.isArray(requested?.[key])) &&
    Array.isArray(expressions) && Array.isArray(motions), '缺少需求对应的运行控制清单');
  const expectedExpressions=[...requested.expressions.map(id=>'dyn_'+id),...requested.clothingVariants.map(id=>'dyn_appearance_'+id)];
  const expectedMotions=['dyn_idle',...requested.actions.filter(id=>!['idle','breath','reset'].includes(id)).map(id=>'dyn_'+id)];
  requireThat(sameSet(expressions.map(e=>e.id),expectedExpressions) && sameSet(motions.map(m=>m.id),expectedMotions) &&
    [expressions,motions].every(list=>new Set(list.map(r=>r.leafId)).size===list.length && new Set(list.map(r=>r.file)).size===list.length),
    '运行包未逐项覆盖用户要求的情绪、手势和外观，或多项共用了同一文件');
}

// Read endpoints of Cubism's variable-length segment encoding. Control-point values are not endpoint keys.
function endpoints(segments, duration) {
  requireThat(Array.isArray(segments) && segments.length >= 5 && segments.every(Number.isFinite) && segments[0] === 0, '动作曲线无有效起点');
  const keys = [[segments[0],segments[1]]];
  for (let i = 2; i < segments.length;) {
    const type = segments[i++], n = type === 1 ? 6 : [0,2,3].includes(type) ? 2 : 0;
    requireThat(n && i+n <= segments.length && segments[i+n-2] > keys.at(-1)[0], '动作曲线段损坏或时间无序');
    keys.push([segments[i+n-2],segments[i+n-1]]); i += n;
  }
  requireThat(Math.abs(keys.at(-1)[0]-duration) < 1e-4, '动作末帧与时长不符');
  return keys.map(v => v[1]);
}

export async function verifyRequestedControls(root, bundle, map, manifest, model) {
  const brief = bundle.brief, intent = brief?.intent;
  requireThat(brief && brief.inputSha256 === bundle.inputSha256 && brief.descriptionSha256 === bundle.descriptionSha256 && intent && map.requested,
    '缺少同图同需求的原始简报或03参数表需求记录');
  requireThat(['inputSha256','descriptionSha256','taskId','candidateId','revision','parentRevision'].every(k => map[k] === bundle[k]), '03参数表身份与打包候选不符');
  const requested = Object.fromEntries(['expressions','actions','clothingVariants'].map(key => {
    const ids = named(intent[key], key);
    requireThat(sameSet(named(map.requested[key], key), ids), '03参数表需求与原始简报不符：'+key);
    return [key, ids];
  }));
  requested.expressions=includeStreamerPresets(requested.expressions,brief.streamerPresets===true,emotionPresets).map(r=>r.id??r);
  requested.actions=includeStreamerPresets(requested.actions,brief.streamerPresets===true,gestureClips).map(r=>r.id??r);
  const mapRows = map.parameters;
  requireThat(Array.isArray(mapRows) && mapRows.every(p => typeof p.id==='string' && p.id) && new Set(mapRows.map(p=>p.id)).size===mapRows.length, '03参数表ID缺失或重复');
  requireThat(model.display && model.physics, '缺少模型索引中的显示信息或物理文件');
  const cdi = await json(root, model.display), labels = new Map((cdi.Parameters ?? []).map(p=>[p.Id,p.Name]));
  requireThat(cdi.Version === 3 && Array.isArray(cdi.Parameters) && cdi.Parameters.length && labels.size === cdi.Parameters.length, '显示信息无有效参数');
  function resolve(id) {
    const p = mapRows.find(v=>v.id===id);
    requireThat(p?.available === true && typeof labels.get(id)==='string' && labels.get(id).trim() && Number.isFinite(p.default), '参数无同版绑定或显示信息：'+id);
    return p;
  }
  requireThat(Array.isArray(manifest.expressions) && Array.isArray(manifest.motions),'动态清单缺少定制表情或动作登记');
  const expressions = [];
  for (const e of manifest.expressions) {
    const indexed = model.expressions.find(item => item.file === e.file && item.name === e.name);
    requireThat(indexed && indexed.leafId === e.leafExpressionId, '动态表情与 model3/Leaf 索引不符');
    const data = await json(root,indexed.file), rows=data.Parameters;
    requireThat(data.Type==='Live2D Expression' && Array.isArray(rows) && rows.length && sameSet(e.parameters,rows.map(r=>r.Id)) &&
      rows.every(r=>r.Blend==='Add' && Number.isFinite(r.Value) && r.Value!==0), '表情参数与实际文件不符：'+e.id);
    const params=rows.map(r=>resolve(r.Id)), appearance = e.id.startsWith('dyn_appearance_');
    if(appearance) {
      const id=e.id.slice('dyn_appearance_'.length), binding=map.dynamics?.appearances?.find(a=>a.id===id);
      requireThat(requested.clothingVariants.includes(id) && params.length===1 && params[0].id===binding?.parameter && params[0].semantic===e.exclusiveGroup &&
        e.exclusiveGroup.startsWith('appearance.'+id+'.') && binding.off===params[0].default && Math.abs((binding.on-binding.off)-rows[0].Value)<1e-5,
        '外观开关未指向独立且可撤销的同版参数：'+e.id);
    } else {
      requireThat(e.exclusiveGroup==='emotion' && requested.expressions.some(id=>e.id==='dyn_'+id) &&
        params.every(p=>/^(?:expression\.|brow\.|eyes\.emotion$|mouth\.form$)/.test(p.semantic) ||
          p.semantic==='eyes.smile' && hasMovingShape(p) && (p.runtimeOwner ? p.runtimeOwner==='expression' :
            ['rigging','expression','expression_additive'].includes(p.owner))), '表情没有独立的情绪参数：'+e.id);
    }
    expressions.push({id:e.id,name:indexed.name,leafId:indexed.leafId,leafActionId:'expression:'+indexed.leafId,
      file:indexed.file,parameters:e.parameters,exclusiveGroup:e.exclusiveGroup,runtime:'not_run'});
  }
  const motions = [];
  for (const m of manifest.motions) {
    const indexed=model.motions.find(item=>item.file===m.file && item.group===m.group && item.index===m.index);
    requireThat(indexed && indexed.leafId===m.leafMotionId, '动态动作与 model3/Leaf 索引不符');
    const data=await json(root,indexed.file), curves=data.Curves;
    requireThat(data.Version===3 && data.Meta?.Duration>0 && data.Meta.Loop===m.loop && Math.abs(data.Meta.Duration-m.duration)<1e-4 &&
      Array.isArray(curves) && curves.length && sameSet(m.parameters,curves.map(c=>c.Id)), '动作登记、时长或实际参数不符：'+m.id);
    const idle=m.id==='dyn_idle', preset=brief.streamerPresets===true&&gestureClips.find(p=>'dyn_'+p.id===m.id);
    if(preset) {
      requireThat(!m.loop&&sameSet(preset.curves.map(c=>c.parameter),m.parameters), '通用动作曲线与登记轴不符：'+m.id);
    }
    for(const c of curves) {
      const p=resolve(c.Id), keys=endpoints(c.Segments,data.Meta.Duration);
      const scope='action.'+m.id.slice(4);
      const inScope=idle ? p.semantic==='body.breath' && m.loop===true : preset ?
        gestureAxes.some(a=>a.id===p.id&&a.semantic===p.semantic)&&p.runtimeOwner==='motion'&&hasMovingShape(p)&&
        Math.abs(keys[0]-p.default)<1e-5&&Math.abs(keys.at(-1)-p.default)<1e-5 :
        p.semantic===scope || p.semantic.startsWith(scope+'.');
      requireThat(c.Target==='Parameter' && inScope &&
        keys.some(v=>Math.abs(v-p.default)>1e-5), '动作没有驱动本次动作的独立参数：'+m.id);
      if(m.id==='dyn_wave') requireThat(m.loop===false && Math.abs(keys[0]-p.default)<1e-5 && Math.abs(keys.at(-1)-p.default)<1e-5, '打招呼动作不能回到默认手势');
    }
    motions.push({id:m.id,name:indexed.group+' · '+(indexed.index+1),group:indexed.group,index:indexed.index,leafId:indexed.leafId,leafActionId:'motion:'+indexed.leafId,
      file:indexed.file,parameters:m.parameters,loop:m.loop,duration:data.Meta.Duration,runtime:'not_run'});
  }
  verifyCoverage(requested, expressions, motions);
  const additionalIndexedControls = {
    expressions: model.expressions.filter(r=>!expressions.some(e=>e.leafId===r.leafId)),
    motions: model.motions.filter(r=>!motions.some(m=>m.leafId===r.leafId))
  };
  return {expressions,motions,requested,additionalIndexedControls};
}
