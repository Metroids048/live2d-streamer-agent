// The native generated grid extends beyond the brief's authored turn. Copy its
// nearest authored boundary so the wider declared range cannot return to rest.
export async function applyHeadRangeClamps(session,{yaw,pitch},{prefix='head-range-v1'}={}) {
  const target='warp:DeformHeadContainer';
  const {axes}=(await session.query('workspace_inspect',{scope:'objects',target})).data;
  const limits=Object.fromEntries(Object.entries({ParamAngleX:yaw,ParamAngleY:pitch}).filter(([,limit])=>limit!==0));
  if(!Object.keys(limits).length)return {target,authoredLimits:limits,copiedCells:0,preservesOtherAxes:true};
  for(const [id,limit] of Object.entries(limits)) {
    if(!Number.isFinite(limit)||limit<=0||!axes?.[id]?.includes(-limit)||!axes[id].includes(limit))
      throw Error('HEAD_RANGE_AUTHORED_BOUNDARY_MISSING:'+id);
  }
  let cells=[{}];
  for(const [id,values] of Object.entries(axes))cells=cells.flatMap(key=>values.map(value=>({...key,[id]:value})));
  const changes=cells.filter(key=>Object.entries(limits).some(([id,limit])=>Math.abs(key[id])>limit))
    .map(key=>({op:'copy',target,key,from:Object.fromEntries(Object.entries(key).map(([id,value])=>
      [id,limits[id]===undefined?value:Math.max(-limits[id],Math.min(limits[id],value))]))}));
  for(let i=0;i<changes.length;i+=64)await session.step(prefix+'-'+i,'keyform_apply',{changes:changes.slice(i,i+64)});
  return {target,authoredLimits:limits,copiedCells:changes.length,preservesOtherAxes:true};
}
