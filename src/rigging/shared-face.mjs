import {has,validateMotion} from './recipe.mjs';
import {faceTurnOffset,portraitTurnField} from './face-turn.mjs';
import {canvasRegistration} from './wave.mjs';

const union=boxes=>[Math.min(...boxes.map(b=>b[0])),Math.min(...boxes.map(b=>b[1])),Math.max(...boxes.map(b=>b[2])),Math.max(...boxes.map(b=>b[3]))];
const center=b=>[(b[0]+b[2])/2,(b[1]+b[3])/2];
const isHead=p=>['face','hair','eye','brow','nose','ear','headwear','eyewear'].some(t=>has(p,t))||has(p,'mouth');
const isHeadOrnament=p=>has(p,'headwear')||has(p,'head','accessory');

// One sampled surface is inherited by all overlapping head layers. Giving each
// mesh the same landmarks is insufficient: different supports interpolate apart.
export function sharedHeadShapes(parts,brief) {
  const face=parts.find(p=>has(p,'face')&&!has(p,'detail'));
  if(!face)throw Error('FACE_MATERIAL_MISSING');
  let [l,t,r,b]=headBounds(parts);
  const w=r-l,h=b-t,[fl,ft,fr,fb]=face.geometry.canvasBounds;
  // A uniform head-wide support grid misses the narrower face's central depth.
  // Keep the four outer corners and sample the actual face, including its center.
  const from=[[0,0],[1,0],[0,1],[1,1],...[.2,.45,.7,.9].flatMap(v=>[.15,.5,.85].map(u=>[(fl+u*(fr-fl)-l)/w,(ft+v*(fb-ft)-t)/h]))];
  const {yaw,pitch}=validateMotion(brief),shapes=[];
  const put=(axis,value,x,y,combined=false)=>shapes.push({parameter:axis,shape:{target:'warp:DeformHeadContainer',value,
    ...(combined?{key:{ParamAngleY:y}}:{}),operations:[{type:'landmarks',from,to:from.map(([u,v])=>{
      const [dx,dy]=faceTurnOffset([l+u*w,t+v*h],face.geometry.canvasBounds,x,y,combined);return[u+dx/w,v+dy/h];
    })}]}});
  if(yaw)for(const x of [-yaw,yaw])put('ParamAngleX',x,x,0);
  if(pitch)for(const y of [-pitch,pitch])put('ParamAngleY',y,0,y);
  if(yaw&&pitch)for(const x of [-yaw,yaw])for(const y of [-pitch,pitch])put('ParamAngleX',x,x,y,true);
  return shapes;
}

// Sample the existing 16×16 cage directly. A sparse inverse-distance field
// smears the nose/cheek depth across the face and does not reproduce its curve.
function headBounds(parts) {
  const [l,t,r,b]=union(parts.filter(isHead).map(p=>p.geometry.canvasBounds));
  return [l-(r-l)*.025,t-(b-t)*.025,r+(r-l)*.025,b+(b-t)*.025];
}

export function sampledHeadShapes(parts,brief,{portrait=false}={}) {
  const face=parts.find(p=>has(p,'face')&&!has(p,'detail'));
  if(!face)throw Error('FACE_MATERIAL_MISSING');
  const bounds=headBounds(parts),[l,t,r,b]=bounds,w=r-l,h=b-t;
  const project=portrait&&portraitTurnField(face,parts);
  const {yaw,pitch}=validateMotion(brief),poses=[];
  const put=(axis,value,x,y,combined=false)=>{
    const points=Array.from({length:289},(_,i)=>[i%17/16,Math.floor(i/17)/16]),shapes=[];
    for(let first=0;first<points.length;first+=16) {
      // Each native change has one fixed input frame. Track the frame between
      // changes as edge vertices move; fractions must not use a stale width.
      const width=Math.max(...points.map(p=>p[0]))-Math.min(...points.map(p=>p[0]));
      const height=Math.max(...points.map(p=>p[1]))-Math.min(...points.map(p=>p[1]));
      const operations=[];
      for(let i=first;i<Math.min(first+16,points.length);i++) {
        const u=i%17/16,v=Math.floor(i/17)/16,p=[l+u*w,t+v*h];
        const offset=project?project(p,x,y):faceTurnOffset(p,face.geometry.canvasBounds,x,y,false,portrait);
        if(combined&&!project) {
          const residual=faceTurnOffset(p,face.geometry.canvasBounds,x,y,true);
          offset[0]+=residual[0];offset[1]+=residual[1];
        }
        const target=[u+offset[0]/w,v+offset[1]/h];
        operations.push({type:'translate',delta:[(target[0]-points[i][0])/width,(target[1]-points[i][1])/height],selection:{indices:[i]}});
        points[i]=target;
      }
      shapes.push({target:'warp:DeformHeadContainer',value,...(combined?{key:{ParamAngleY:y}}:{}),operations});
    }
    poses.push({parameter:axis,value,yaw:x,pitch:y,combined,shapes});
  };
  if(yaw)for(const x of [-yaw,yaw])put('ParamAngleX',x,x,0);
  if(pitch)for(const y of [-pitch,pitch])put('ParamAngleY',y,0,y);
  if(yaw&&pitch)for(const x of [-yaw,yaw])for(const y of [-pitch,pitch])put('ParamAngleX',x,x,y,true);
  return {bounds,poses};
}

export async function applySampledHeadKeys(session,parts,brief,{prefix,portrait=false}) {
  const sampled=sampledHeadShapes(parts,brief,{portrait});
  // Seed every lattice cell before shaping. A diagonal stores its absolute pose.
  for(const id of ['ParamAngleX','ParamAngleY']) {
    const poses=sampled.poses.filter(p=>p.parameter===id);
    if(poses.length)await session.step(prefix+'-sampled-head-seed-'+id,'author_axis',{
      parameter:{id,min:id==='ParamAngleX'?-45:-30,max:id==='ParamAngleX'?45:30,default:0},
      shapes:poses.map(p=>({...p.shapes[0],operations:[{type:'scale',factors:[1,1]}]}))});
  }
  if(sampled.poses.length)await session.step(prefix+'-sampled-head-neutral','keyform_apply',{
    changes:[{op:'reset',target:'warp:DeformHeadContainer',all_keys:true,to:'default',along:['ParamAngleX','ParamAngleY']}]});
  for(const [i,p] of sampled.poses.entries())await session.step(prefix+'-sampled-head-'+i,'author_axis',{
    parameter:{id:p.parameter,min:p.parameter==='ParamAngleX'?-45:-30,max:p.parameter==='ParamAngleX'?45:30,default:0},shapes:p.shapes});
  return sampled;
}

const smoothstep=value=>{const v=Math.max(0,Math.min(1,value));return v*v*(3-2*v);};

// Move only the free part of the foreground hair and head ornaments. The
// shared head surface owns the scalp seam and the attached ornament bases.
export function portraitParallax(part,face,[x,y],turn) {
  const [fl,ft,fr,fb]=face.geometry.canvasBounds,fw=fr-fl,fh=fb-ft,cx=(fl+fr)/2;
  const [l,t,r,b]=part.geometry.canvasBounds;
  const yaw=Math.sin(turn*Math.PI/180);
  if(has(part,'hair','front','root')){
    const v=(y-ft)/fh,side=Math.abs(x-cx)/fw;
    const cheeks=smoothstep((v-.37)/.24)*smoothstep((1.07-v)/.19);
    // The cheek-facing edge follows the same surface as the face.
    const edge=smoothstep((side-.50)/.17)*smoothstep((.96-side)/.20);
    // The upper temple has overlap to trade at a turn. Fade before the lock
    // reaches the cheek and jaw, whose edge must remain on the shared surface.
    const temple=smoothstep((v-.18)/.15)*smoothstep((.62-v)/.22)
      *smoothstep((side-.29)/.18)*smoothstep((.74-side)/.16);
    // At the far cheek the lock can cover more skin. On the near side the
    // seam stays on the shared head field; moving it out can expose a hole.
    const far=smoothstep(Math.sign(x-cx)*yaw/.26);
    const cheekOverlap=cheeks*smoothstep((.75-v)/.20)*smoothstep((side-.25)/.16)*smoothstep((.65-side)/.19);
    return [-yaw*fw*(.12*cheeks*edge+.16*temple+.24*far*cheekOverlap),
      Math.abs(yaw)*fw*.065*far*cheekOverlap];
  }
  const tip=smoothstep((.77-(y-t)/(b-t))/.55);
  const span=(x-(l+r)/2)/(r-l);
  return [-yaw*fw*.19*tip,Math.abs(yaw)*fw*.085*span*tip*Math.sign(yaw)];
}

async function parallaxKeys(session,part,face,target,yaw,prefix) {
  const points=async space=>{
    const r=(await session.query('mesh_get_topology',{target,space,section:'vertices',limit:4096})).data;
    if(r.target!==target||r.coordinate_space!==(space==='canvas'?'canvas_x_right_y_down':'mesh_rest')||
      r.items?.length!==r.vertex_count||r.items.some((row,i)=>row[0]!==i))
      throw Error('PARALLAX_TOPOLOGY_MISMATCH:'+target);
    return r.items.map(p=>p.slice(1));
  };
  const local=await points('local'),canvas=await points('canvas');
  const {toLocal}=canvasRegistration(local,canvas);
  const parameter={id:'ParamAngleX',min:-45,max:45,default:0};
  const values=[...new Set([-45,-yaw,yaw,45])];
  await session.step(prefix+'-parallax-seed-'+part.id,'author_axis',{parameter,shapes:values.map(value=>({
    target,value,operations:[{type:'scale',factors:[1,1]}],
  }))});
  const shapes=values.map(value=>{
    const turn=Math.max(-yaw,Math.min(yaw,value)),current=local.map(p=>[...p]);
    const to=canvas.map(p=>{
      const [dx,dy]=portraitParallax(part,face,p,turn);
      return toLocal([p[0]+dx,p[1]+dy]);
    });
    const changes=[];
    for(let start=0;start<local.length;start+=256) {
      const bounds=union(current.map(([x,y])=>[x,y,x,y])),[l,t,r,b]=bounds;
      const norm=([x,y])=>[(x-l)/(r-l),(y-t)/(b-t)],operations=[];
      for(let i=start;i<Math.min(start+256,local.length);i+=16){
        const indices=Array.from({length:Math.min(16,local.length-i)},(_,j)=>i+j);
        operations.push({type:'landmarks',selection:{indices},from:indices.map(k=>norm(current[k])),to:indices.map(k=>norm(to[k]))});
      }
      for(let i=start;i<Math.min(start+256,local.length);i++)current[i]=to[i];
      changes.push({target,key:{ParamAngleX:value},operations});
    }
    return {value,changes};
  });
  for(const {value,changes} of shapes)await session.step(prefix+'-parallax-shape-'+part.id+'-'+value,'rig_deform',{changes});
  return {id:part.id,values,vertices:local.length,method:'pinned_root_canvas_vertices'};
}

export async function applyEyeApertureKeys(session,id,axis,keys,point,{prefix='shared-face-v5',angry=false,surprise=false,articulated=false,lashCenter,lowerLid,farYaw=0,linkedBlink=false}={}) {
  const target='warp:'+id,identity=[{type:'scale',factors:[1,1],pivot:point}];
  // Native author_axis inserts a new cell from the currently interpolated grid.
  // Seed the entire lattice before shaping so .25/.5/.75 cannot inherit a
  // previously compressed key and then be compressed a second time.
  await session.step(prefix+'-aperture-'+id,'author_axis',{parameter:{id:axis,min:0,max:1,default:1},
    shapes:keys.filter(v=>v!==1).map(value=>({target,value,operations:identity}))});
  await session.step(prefix+'-smile-'+id,'author_axis',{parameter:{id:'ParamEyeSmile',min:0,max:1,default:0},
    shapes:keys.map(v=>({target,value:1,key:{[axis]:v},operations:identity}))});
  const emotionAxes=[...(angry?['ParamEyeAngry']:[]),...(surprise?['ParamEyeSurprise']:[])];
  let grid=keys.flatMap(v=>[0,1].map(smile=>({[axis]:v,ParamEyeSmile:smile})));
  for(const parameterId of emotionAxes) {
    const label=parameterId==='ParamEyeAngry'?'angry':'surprise';
    await session.step(prefix+'-'+label+'-'+id,'author_axis',{parameter:{id:parameterId,min:0,max:1,default:0},
      shapes:grid.map(key=>({target,value:1,key,operations:identity}))});
    grid=grid.flatMap(key=>[0,1].map(value=>({...key,[parameterId]:value})));
  }
  if(linkedBlink)farYaw=0;
  if(farYaw) {
    await session.step(prefix+'-far-lid-'+id,'author_axis',{parameter:{id:'ParamAngleX',min:-45,max:45,default:0},
      shapes:grid.map(key=>({target,value:farYaw,key,operations:identity}))});
    grid=grid.flatMap(key=>[0,farYaw].map(value=>({...key,ParamAngleX:value})));
  }
  await session.step(prefix+'-aperture-default-'+id,'keyform_apply',{changes:[{op:'reset',target,all_keys:true,to:'default'}]});
  const changes=grid.map(key=>{
    const opening=Math.max(.05,key[axis]);
    const expression=(key.ParamEyeSmile?(articulated?.71:.84):1)*
      (key.ParamEyeAngry?(articulated?.78:.88):1)*(key.ParamEyeSurprise?(articulated?1.13:1.24):1);
    const farBlink=key.ParamAngleX?4*opening*(1-opening)*Math.min(1,Math.abs(farYaw)/30):0;
    // Head yaw is already inherited from the head warp. A second mid-blink
    // squash and tilt pulls the eyelash away from the fixed eye corners.
    const height=opening*expression*(1-.19*farBlink);
    const operations=[{type:'scale',factors:[1,height],pivot:point}];
    if(lowerLid) {
      const {anchor,release}=lowerLid,blink=key[axis];
      const pivot=[anchor[0],point[1]+(anchor[1]-point[1])*height];
      operations.push({type:'scale',factors:[1,1+release*4*blink*(1-blink)],pivot});
    }
    // The lash follows the aperture to the lid, but retains its own brush thickness.
    if(lashCenter&&opening<1)operations.push({type:'scale',factors:[1,(.50+.50*opening)/opening],
      pivot:[lashCenter[0],point[1]+(lashCenter[1]-point[1])*height]});
    if(farBlink)operations.push({type:'rotate',degrees:Math.sign(farYaw)*6*farBlink,pivot:point});
    if(key.ParamEyeAngry)operations.push({type:'rotate',degrees:(axis==='ParamEyeLOpen'?-1:1)*7,pivot:point});
    return {target,key,operations};
  });
  for(let i=0;i<changes.length;i+=64)await session.step(prefix+'-aperture-geometry-'+id+(i?'-'+i:''),'rig_deform',{changes:changes.slice(i,i+64)});
}

async function alignClosedLash(session,prefix,closed,target,axis) {
  const controls=closed.rigging.closedLashHandoff;
  if(!Array.isArray(controls)||controls.length<3||controls.length>16||
    controls.some((p,i)=>!Array.isArray(p)||p.length!==2||!p.every(Number.isFinite)||
      p[0]<0||p[0]>1||Math.abs(p[1])>.25||i&&p[0]<=controls[i-1][0]))
    throw Error('CLOSED_LASH_HANDOFF_INVALID:'+closed.id);
  const changes=await session.capturePlan(prefix+'-lash-handoff-plan-'+closed.id,async()=>{
    const vertices=async space=>{
      const mesh=(await session.query('mesh_get_topology',{target,space,section:'vertices',limit:256})).data;
      if(mesh.target!==target||mesh.items?.length!==mesh.vertex_count||mesh.items.some((p,i)=>p[0]!==i))
        throw Error('CLOSED_LASH_HANDOFF_TOPOLOGY:'+closed.id);
      return mesh.items.map(p=>p.slice(1));
    };
    const local=await vertices('local'),canvas=await vertices('canvas'),{toLocal}=canvasRegistration(local,canvas);
    const [left,,right]=closed.geometry.canvasBounds,width=right-left;
    const [l,t,r,b]=union(local.map(([x,y])=>[x,y,x,y]));
    const norm=([x,y])=>[(x-l)/(r-l),(y-t)/(b-t)];
    const corrected=canvas.map(([x,y])=>{
      const u=Math.max(controls[0][0],Math.min(controls.at(-1)[0],(x-left)/width));
      const i=controls.findIndex(([k])=>k>=u);
      const [a,dy0]=controls[Math.max(0,i-1)],[z,dy1]=controls[i];
      const dy=i===0?dy0:dy0+(dy1-dy0)*(u-a)/(z-a);
      return toLocal([x,y+dy*width]);
    });
    const operations=[];
    for(let start=0;start<local.length;start+=16) {
      const indices=Array.from({length:Math.min(16,local.length-start)},(_,i)=>start+i);
      operations.push({type:'landmarks',selection:{indices},from:indices.map(i=>norm(local[i])),to:indices.map(i=>norm(corrected[i]))});
    }
    return [.085,.11].map(value=>({target,key:{[axis]:value},operations}));
  });
  await session.step(prefix+'-lash-handoff-seed-'+closed.id,'author_axis',{parameter:{id:axis,min:0,max:1,default:1},
    shapes:[0,.04,.085,.11].map(value=>({target,value,operations:[{type:'scale',factors:[1,1]}]}))});
  await session.step(prefix+'-lash-handoff-geometry-'+closed.id,'rig_deform',{changes});
}

export async function applySharedFaceRig(session,parts,objects,brief,{prefix='shared-face-v5',portrait=false,linkedBlink=false}={}) {
  const articulated=portrait&&parts.some(p=>p.rigging?.continuousWave?.fingertips);
  const surprise=brief.intent.expressions.some(e=>e.id==='surprise');
  const surpriseMouth=portrait&&surprise;
  const parentById=new Map(objects.map(o=>[o.target.slice(o.target.indexOf(':')+1),o.parentId]));
  const underHead=id=>{const seen=new Set();for(let p=id;p&&!seen.has(p);p=parentById.get(p)){if(p==='DeformHeadContainer')return true;seen.add(p);}return false;};
  const resets=[];
  // The generated warp hierarchy owns additional yaw/pitch keys. Neutralize them
  // before authoring the sole head field; preserving gaze, roll and body axes.
  const axes=await session.capturePlan(prefix+'-original-axes',async()=>{
    const entries=[];
    for(const o of objects.filter(o=>['warp:','mesh:'].some(p=>o.target.startsWith(p))&&underHead(o.target.split(':')[1]))) {
      const detail=(await session.query('workspace_inspect',{scope:'objects',target:o.target})).data;
      entries.push([o.target,Object.keys(detail.axes??{})]);
    }
    return entries;
  });
  const axesByTarget=new Map(axes);
  for(const [target,ids] of axes) {
    const along=['ParamAngleX','ParamAngleY'].filter(id=>ids.includes(id));
    if(along.length)resets.push({op:'reset',target,all_keys:true,to:'default',along});
  }
  for(let i=0;i<resets.length;i+=64)await session.step(prefix+'-head-reset-'+i,'keyform_apply',{changes:resets.slice(i,i+64)});
  // Cubism samples an ancestor surface again at every child warp's lattice.
  // Coarse hair/face children otherwise approximate the same surface differently.
  for(const o of objects.filter(o=>o.target.startsWith('warp:')&&underHead(o.target.slice(5))))
    await session.step(prefix+'-topology-'+o.target.slice(5),'warp_set_topology',{target:o.target,rows:16,columns:16});
  const byLayer=new Map(objects.filter(o=>o.layerId&&o.target.startsWith('mesh:')).map(o=>[o.layerId,o]));
  const features=parts.filter(p=>has(p,'eye')||has(p,'mouth'));
  // Reset every direct eye/mouth grid, not just white/cavity; no generated lash
  // curvature or old local head compensation may survive beneath the new warp.
  // An unkeyed mesh has only an empty default cell; native reset requires a
  // nonempty geometry key. Opacity axes do not make that cell a geometry key.
  // Later expression refinements can add direct axes to a previously unkeyed
  // feature. Reuse this exact completed reset's receipt on resume; step still
  // verifies its original request hash, so the new expression is not reset.
  const completedRest=session.journal?.done?.[prefix+'-feature-rest'];
  const resetTargets=completedRest?.data.changed??features.filter(p=>axesByTarget.get(byLayer.get(p.id).target)?.length)
    .map(p=>byLayer.get(p.id).target);
  if(!Array.isArray(resetTargets)||resetTargets.some(t=>!features.some(p=>byLayer.get(p.id).target===t))||new Set(resetTargets).size!==resetTargets.length)
    throw Error('SHARED_FEATURE_REST_RECEIPT_INVALID');
  const featureResets=resetTargets.map(target=>({op:'reset',target,all_keys:true,to:'rest'}));
  if(featureResets.length)await session.step(prefix+'-feature-rest','keyform_apply',{changes:featureResets});
  const sampled=await applySampledHeadKeys(session,parts,brief,{prefix,portrait});
  const parallax=[];
  const {yaw}=validateMotion(brief);
  const face=parts.find(p=>has(p,'face')&&!has(p,'detail'));
  if(portrait&&yaw) {
    for(const p of parts.filter(p=>has(p,'hair','front','root')||isHeadOrnament(p))) {
      // Complementary fringe/temple pixels share one head field. A separate yaw
      // grid pulls their join apart. Continue a previously started journal unchanged.
      const previousSeed=prefix+'-parallax-seed-'+p.id;
      if(p.sharesFringeJoin&&!session.journal?.done?.[previousSeed]&&session.journal?.pending?.key!==previousSeed)continue;
      const target=byLayer.get(p.id)?.target;
      if(target&&underHead(target.slice(5)))parallax.push(await parallaxKeys(session,p,face,target,yaw,prefix));
    }
  }
  const opacity=[],apertures=[];
  async function aperture(id,selected,pivotSource,axis,keys,form=false,independentLash=false,farYaw=0,lowerLid=null) {
    if(!selected.length)return;
    const targets=selected.map(p=>byLayer.get(p.id).target);
    const parents=new Set(selected.map(p=>byLayer.get(p.id).parentId));
    if(parents.size!==1)throw Error('SHARED_APERTURE_PARENT_MISMATCH:'+id);
    const {point,lashCenter,anchor}=await session.capturePlan(prefix+'-pivots-'+id,async()=>{
      const bounds=async target=>(await session.query('mesh_get_topology',{target,limit:1})).data.bounds;
      const point=center(await bounds(byLayer.get(pivotSource.id).target));
      return {point,...(independentLash?{lashCenter:center(await bounds(targets[0]))}:{}),
        ...(lowerLid?{anchor:center(await bounds(byLayer.get(lowerLid.lash.id).target))}:{})};
    });
    await session.step(prefix+'-create-'+id,'rig_create_warp',{id,name:id,targets,rows:16,columns:16,fit_local:false});
    if(!form)await applyEyeApertureKeys(session,id,axis,keys,point,{prefix,articulated,lashCenter,
      lowerLid:lowerLid&&{anchor,release:lowerLid.release},farYaw,linkedBlink,angry:brief.intent.expressions.some(e=>e.id==='angry'),surprise});
    else {
      const target='warp:'+id,identity=[{type:'scale',factors:[1,1],pivot:point}];
      const grid=keys.flatMap(v=>[-1,0,1].map(f=>({ParamMouthOpenY:v,ParamMouthForm:f})));
      const shapes=grid.filter(k=>k.ParamMouthOpenY!==0).map(k=>({target,value:k.ParamMouthOpenY,
        key:{ParamMouthForm:k.ParamMouthForm},operations:identity}));
      await session.step(prefix+'-aperture-'+id,'author_axis',{parameter:{id:axis,min:0,max:1,default:0},shapes});
      if(surpriseMouth)await session.step(prefix+'-surprise-mouth','author_axis',{
        parameter:{id:'ParamEyeSurprise',min:0,max:1,default:0},
        shapes:grid.map(key=>({target,value:1,key,operations:identity}))});
      const changes=grid.flatMap(key=>(surpriseMouth?[0,1]:[0]).map(o=>{
        const v=key.ParamMouthOpenY,f=key.ParamMouthForm;
        // Surprise rounds and opens the painted cavity at rest. Speech still
        // changes its height, and the expression never writes the speech input.
        const factors=o?[.65+.16*v,.58+.48*v]:
          articulated?[1+.13*f,Math.max(.05,v*(1-.23*f))]:[1+.04*f,Math.max(.05,v)];
        return {target,key:{...key,...(surpriseMouth?{ParamEyeSurprise:o}:{})},
          operations:[{type:'scale',factors,pivot:point}]};
      }));
      await session.step(prefix+'-mouth-geometry','rig_deform',{changes});
    }
    apertures.push({id,targets,parent:[...parents][0],pivot:point,keys});
  }
  for(const side of ['left','right']) {
    const axis=side==='left'?'ParamEyeLOpen':'ParamEyeROpen',white=parts.find(p=>has(p,'eye','white',side));
    const closed=parts.find(p=>has(p,'eye','closed',side));
    if(!white||!closed)continue;
    const suffix=side==='left'?'L':'R',keys=[0,.25,.5,.75,1];
    const lash=articulated&&parts.find(p=>has(p,'eye','lash','upper',side));
    const farYaw=portrait&&yaw?Math.sign(center(white.geometry.canvasBounds)[0]-center(face.geometry.canvasBounds)[0])*yaw:0;
    const release=white.rigging?.lowerLidRelease;
    if(release!==undefined&&(!lash||!linkedBlink||!Number.isFinite(release)||release<=0||release>.4))
      throw Error('LOWER_LID_RELEASE_INVALID:'+white.id);
    await aperture('DeformSharedAperture'+suffix,parts.filter(p=>p!==lash&&has(p,'eye',side)&&(has(p,'white')||has(p,'lash')||has(p,'rim'))),closed,axis,keys,false,false,farYaw,
      release===undefined?null:{lash,release});
    if(lash)await aperture('DeformSharedUpperLash'+suffix,[lash],closed,axis,keys,false,true,farYaw);
    const pairedLash=linkedBlink&&lash;
    const alignedLash=closed.rigging?.closedLashHandoff!==undefined;
    if(alignedLash) {
      if(!pairedLash)throw Error('CLOSED_LASH_HANDOFF_INVALID:'+closed.id);
      await alignClosedLash(session,prefix,closed,byLayer.get(closed.id).target,axis);
    }
    // Complementary opacity alone drops the combined coverage to 75%.
    // Preserve the ink density where the aligned drawings overlap.
    const closedHandoff=alignedLash?[[.09,.98],[.0975,.76],[.105,.38]]:[];
    const openHandoff=alignedLash?[[.09,.38],[.0975,.76],[.105,.98]]:[];
    for(const p of parts.filter(p=>has(p,'eye',side))) {
      // Hold the closed drawing through the last sliver of aperture, then
      // hand its opacity to the upper lash over the same interval.
      const blink=has(p,'closed')?(pairedLash?[[0,1],[.085,1],...closedHandoff,[.11,0],[1,0]]:
        lash?[[0,1],[.07,1],[.12,0],[1,0]]:[[0,1],[.2,0],[1,0]]):
        has(p,'fold')?[[0,0],[.5,portrait?0:.12],[1,1]]:
        lash&&!has(p,'rim')?(p===lash?(pairedLash?[[0,0],[.085,0],...openHandoff,[.11,1],[1,1]]:
          [[0,0],[.04,0],[.09,1],[1,1]]):[[0,0],[.08,0],[.15,1],[1,1]]):
        pairedLash?[[0,0],[.085,0],[.2,1],[1,1]]:[[0,0],[.2,1],[1,1]];
      for(const [value,a] of blink)
        opacity.push({op:'set',target:byLayer.get(p.id).target,key:{[axis]:value},channels:{opacity:a}});
    }
  }
  const closed=parts.find(p=>has(p,'mouth','closed'));
  if(closed) {
    await aperture('DeformSharedMouthAperture',parts.filter(p=>has(p,'mouth','open')),closed,'ParamMouthOpenY',[0,.25,.5,.75,1],true);
    for(const p of parts.filter(p=>has(p,'mouth')))for(const [value,a] of (has(p,'closed')?[[0,1],[.12,0],[1,0]]:[[0,0],[.12,1],[1,1]]))
      for(const o of (surpriseMouth?[0,1]:[0]))opacity.push({op:'set',target:byLayer.get(p.id).target,
        key:{ParamMouthOpenY:value,...(surpriseMouth?{ParamEyeSurprise:o}:{})},
        channels:{opacity:o?Number(!has(p,'mouth','closed')):a}});
  }
  for(let i=0;i<opacity.length;i+=120)await session.step(prefix+'-opacity-'+i,'keyform_apply',{changes:opacity.slice(i,i+120)});
  return {headTarget:'warp:DeformHeadContainer',headResetTargets:resets.map(r=>r.target),featureResetTargets:featureResets.map(r=>r.target),parallax,apertures,opacity,
    boundary:'One inherited skin field with relative parallax for attached foreground locks and ornaments; real source art still requires visual review.'};
}
