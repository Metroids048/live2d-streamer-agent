import {has} from './recipe.mjs';

export const EXPRESSION_REFINEMENT_VERSION='hachi-expression-v4';

// Native geometry operations use fixed input bounds, x-right/y-down units.
// The source closed line already smiles. The negative Form must reverse that
// curvature, rather than only changing the invisible open-mouth width.
export function closedMouthOperations(form) {
  if(![-1,0,1].includes(form))throw Error('EXPRESSION_FORM_KEY_INVALID');
  if(!form)return [{type:'scale',factors:[1,1]}];
  return [
    {type:'scale',factors:[form>0?1.12:.92,1]},
    {type:'curve',axis:'y',controls:form>0?[-.5,.2,.2,-.5]:[1.2,-.4,-.4,1.2]},
  ];
}

export function browOperations(side,value) {
  if(!['left','right'].includes(side)||![-1,0,1].includes(value))throw Error('EXPRESSION_BROW_KEY_INVALID');
  if(!value)return [{type:'scale',factors:[1,1]}];
  const inner=side==='left'?-1:1;
  return value<0?[
    {type:'rotate',degrees:inner*22},
    {type:'translate',delta:[inner*.035,.35]},
  ]:[
    {type:'rotate',degrees:-inner*8},
    {type:'translate',delta:[0,-.55]},
    {type:'curve',axis:'y',controls:[0,-.25,-.25,0]},
  ];
}

const validBounds=b=>Array.isArray(b)&&b.length===4&&b.every(Number.isFinite)&&b[2]>b[0]&&b[3]>b[1];
const cubic=(c,t)=>c[0]*(1-t)**3+3*c[1]*(1-t)**2*t+3*c[2]*(1-t)*t*t+c[3]*t**3;
const derivative=(c,t)=>3*((c[1]-c[0])*(1-t)**2+2*(c[2]-c[1])*(1-t)*t+(c[3]-c[2])*t*t);

// Native curve controls use each mesh's own rest X domain and edited height.
// Restrict one cavity field to each lip cage, then convert its vertical units.
// Equal controls on differently sized cages would pull the lip off the cavity.
export function openMouthOperations(form,frame) {
  if(![-1,0,1].includes(form))throw Error('EXPRESSION_FORM_KEY_INVALID');
  if(frame&&(!validBounds(frame.bounds)||!validBounds(frame.commonBounds)))throw Error('EXPRESSION_MOUTH_BOUNDS_INVALID');
  if(!form)return [{type:'scale',factors:[1,1]}];
  let controls=form<0?[.45,-.45/3,-.45/3,.45]:[-.1,.1/3,.1/3,-.1];
  if(frame) {
    const {bounds:b,commonBounds:c}=frame,w=c[2]-c[0],a=(b[0]-c[0])/w,z=(b[2]-c[0])/w;
    const ratio=(c[3]-c[1])/(b[3]-b[1]),start=cubic(controls,a),end=cubic(controls,z);
    controls=[start,start+(z-a)*derivative(controls,a)/3,end-(z-a)*derivative(controls,z)/3,end].map(v=>v*ratio);
    if(!controls.every(Number.isFinite))throw Error('EXPRESSION_MOUTH_BOUNDS_INVALID');
  }
  return [{type:'curve',axis:'y',controls}];
}

function assertGeometry(result,layerId) {
  const diagnostics=[];
  const visit=v=>{if(!v||typeof v!=='object')return;if(v.geometry_diagnostics)diagnostics.push(v.geometry_diagnostics);
    for(const [k,x] of Object.entries(v))if(k!=='geometry_diagnostics'&&x&&typeof x==='object')visit(x);};
  visit(result?.data);
  if(diagnostics.some(d=>(d.violations?.length??0)||(d.warnings?.length??0)))throw Error('EXPRESSION_GEOMETRY_REVIEW_REQUIRED:'+layerId);
}

export async function applyExpressionRefinement(session,parts,objects,brief,{prefix=EXPRESSION_REFINEMENT_VERSION}={}) {
  if(!brief.intent.expressions.length)return null;
  const byLayer=new Map(objects.filter(o=>o.layerId&&o.target.startsWith('mesh:')).map(o=>[o.layerId,o]));
  const report={version:EXPRESSION_REFINEMENT_VERSION,targets:[],
    boundary:'Authored same-source brow, closed-lip and speaking-mouth shapes; actual exported neutral, expressions, blink and speech combinations require visual review.'};
  const selected=parts.filter(p=>has(p,'brow')||has(p,'mouth','closed')||has(p,'mouth','open'));
  const openParts=selected.filter(p=>has(p,'mouth','open')),mouthFrames=new Map(),details=new Map();
  if(openParts.length) {
    const cavities=openParts.filter(p=>!has(p,'line'));
    if(cavities.length!==1)throw Error('EXPRESSION_MOUTH_CAVITY_AMBIGUOUS');
    let parent;
    for(const p of openParts) {
      const object=byLayer.get(p.id);if(!object)throw Error('EXPRESSION_MESH_MISSING:'+p.id);
      const detail=(await session.query('workspace_inspect',{scope:'objects',target:object.target})).data;
      if(typeof detail.parent!=='string'||!detail.parent||(parent&&detail.parent!==parent))throw Error('EXPRESSION_MOUTH_PARENT_MISMATCH');
      parent=detail.parent;details.set(p.id,detail);
      const geometry=(await session.query('mesh_get_topology',{target:object.target,space:'local',section:'vertices',limit:1})).data;
      if(geometry.target!==object.target||geometry.coordinate_space!=='mesh_rest'||!validBounds(geometry.bounds))throw Error('EXPRESSION_MOUTH_BOUNDS_INVALID');
      mouthFrames.set(p.id,{bounds:geometry.bounds});
    }
    const commonBounds=mouthFrames.get(cavities[0].id).bounds;
    for(const frame of mouthFrames.values())frame.commonBounds=commonBounds;
    report.mouthField={parent,commonLayerId:cavities[0].id,targets:openParts.map(p=>({layerId:p.id,...mouthFrames.get(p.id)}))};
  }
  for(const p of selected) {
    const object=byLayer.get(p.id);if(!object)throw Error('EXPRESSION_MESH_MISSING:'+p.id);
    const mouth=has(p,'mouth'),open=has(p,'mouth','open'),side=has(p,'left')?'left':has(p,'right')?'right':null;
    if(!mouth&&!side)throw Error('EXPRESSION_BROW_SIDE_MISSING:'+p.id);
    const axis=mouth?'ParamMouthForm':side==='left'?'ParamBrowLY':'ParamBrowRY';
    const detail=details.get(p.id)??(await session.query('workspace_inspect',{scope:'objects',target:object.target})).data;
    const allowed=open?[axis,'ParamMouthOpenY']:[axis];
    if(Object.keys(detail.axes??{}).some(k=>!allowed.includes(k)))throw Error('EXPRESSION_UNEXPECTED_DIRECT_AXIS:'+p.id);
    const existingOpen=detail.axes?.ParamMouthOpenY??[];
    if(open&&(!Array.isArray(existingOpen)||existingOpen.some(v=>!Number.isFinite(v)||v<0||v>1)))throw Error('EXPRESSION_OPEN_GRID_INVALID:'+p.id);
    const apertures=open?[...new Set([0,.25,.5,.75,1,...existingOpen])].sort((a,b)=>a-b):null;
    const identity=[{type:'scale',factors:[1,1]}];
    await session.step(prefix+'-seed-'+p.id,'author_axis',{parameter:{id:axis,min:-1,max:1,default:0},
      shapes:[-1,1].map(value=>({target:object.target,value,operations:identity}))});
    if(open)await session.step(prefix+'-open-grid-'+p.id,'author_axis',{parameter:{id:'ParamMouthOpenY',min:0,max:1,default:0},
      shapes:apertures.filter(v=>v!==0).flatMap(value=>[-1,0,1].map(form=>({target:object.target,value,key:{[axis]:form},operations:identity})))});
    // Reset the complete seeded lattice before shaping: no stacked native brow
    // translation and no inherited interpolation from an already edited key.
    await session.step(prefix+'-rest-'+p.id,'keyform_apply',{changes:[{op:'reset',target:object.target,all_keys:true,to:'rest'}]});
    const forms=open?[-1,0,1]:[-1,1];
    const changes=(open?apertures:[null]).flatMap(aperture=>forms.map(value=>({target:object.target,
      key:{[axis]:value,...(open?{ParamMouthOpenY:aperture}:{})},
      operations:open?openMouthOperations(value,mouthFrames.get(p.id)):mouth?closedMouthOperations(value):browOperations(side,value)})));
    assertGeometry(await session.step(prefix+'-shape-'+p.id,'rig_deform',{changes}),p.id);
    report.targets.push({layerId:p.id,target:object.target,axis,neutral:'unchanged_source_rest',keys:[-1,0,1],...(open?{apertures,inheritedAperture:true}:{})});
  }
  return report;
}
