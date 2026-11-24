// A native ancestor moves every drawable together, independently of head/body
// angles. Leaf's actual position signals still require a model-specific mapping.
export async function applyRootPositionRig(session,{width,height},{prefix='root-position-v1'}={}) {
  if(!(width>0&&height>0))throw Error('ROOT_POSITION_CANVAS_INVALID');
  const id='DeformRootPosition',target='warp:'+id;
  await session.step(prefix+'-wrap','canvas_warp',{id,name:'画面内位置',meshes:[],add_to:'parent_of_deformer',
    deformer_id:'DeformBodyXY',bounds:{x:0,y:0,w:width,h:height},rows:1,columns:1});
  for(const [parameter,axis] of [['ParamBaseX',0],['ParamBaseY',1]]) {
    const shapes=[-1,1].flatMap(value=>(axis===0?[undefined]:[-1,0,1]).map(x=>({target,value,
      ...(x===undefined?{}:{key:{ParamBaseX:x}}),operations:[{type:'translate',delta:axis===0?[value*.1,0]:[0,value*.1]}]})));
    await session.step(prefix+'-'+parameter,'author_axis',{parameter:{id:parameter,min:-1,max:1,default:0},shapes});
  }
  return {target,parameters:['ParamBaseX','ParamBaseY'],travelPixels:{x:width*.1,y:height*.1},tracking:'mapping_and_human_validation_required'};
}
