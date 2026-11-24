import test from 'node:test';
import assert from 'node:assert/strict';
import {faceTurnOffset,faceTurnAnchors,portraitTurnField,surfaceTurn,surfaceTurnOperations} from '../src/rigging/face-turn.mjs';
const contourControls=[[0,.25],[1,.25],[.1,.7],[.9,.7],[.5,1]];
const part=(tags,canvasBounds)=>{
  const [l,t,r,b]=canvasBounds;
  return {tags,geometry:{canvasBounds,centroid:[(l+r)/2,(t+b)/2],contourControls}};
};
const face=part(['face'],[100,40,200,140]),left=part(['eye','white','left'],[113,85,140,97]),
  right=part(['eye','white','right'],[160,85,187,97]),mouth=part(['mouth','closed'],[137,112,163,116]),
  nose=part(['nose'],[148,98,152,102]),anchors=faceTurnAnchors(face,[face,left,right,mouth,nose,part(['brow','left'],[110,72,139,78]),part(['brow','right'],[161,72,190,78])]);
function projected(p,point,yaw=12,pitch=0,diagonal=false) {
  const [l,t,r,b]=p.geometry.canvasBounds,q=[(point[0]-l)/(r-l),(point[1]-t)/(b-t)];
  const op=surfaceTurn(p,face,yaw,pitch,diagonal,anchors),i=op.from.findIndex(v=>Math.hypot(v[0]-q[0],v[1]-q[1])<1e-9);
  assert(i>=0);return [l+op.to[i][0]*(r-l),t+op.to[i][1]*(b-t)];
}
test('同一源像素在皮肤和叠加眼白、唇、鼻的几何约束相同；复位无残留',()=>{
  const skin=surfaceTurn(face,face,12,0,false,anchors);
  assert.equal(skin.from.length,16,'PSD2Live author_axis limits source/target lists to 16');
  assert.deepEqual(skin.from.slice(0,contourControls.length),contourControls);
  for(const p of [left,right,mouth,nose])for(const pt of anchors.filter(([x,y])=>{const [l,t,r,b]=p.geometry.canvasBounds;return l<=x&&x<=r&&t<=y&&y<=b;})) {
    for(const [yaw,pitch,combined] of [[-12,0,false],[12,0,false],[0,8,false],[12,-8,true]]) {
      const a=projected(p,pt,yaw,pitch,combined),b=projected(face,pt,yaw,pitch,combined);
      assert(Math.hypot(a[0]-b[0],a[1]-b[1])<1e-10);
    }
    assert.deepEqual(projected(p,pt,0),pt);
  }
});
test('转 12 度可分辨近眼/远眼宽度，逆转交换；鼻比下巴更突出',()=>{
  const width=(p,yaw)=>{const [l,,r]=p.geometry.canvasBounds,y=p.geometry.centroid[1];return (projected(p,[r,y],yaw)[0]-projected(p,[l,y],yaw)[0])/(r-l);};
  for(const yaw of [-12,12]){
    const ratios=[width(left,yaw),width(right,yaw)];
    assert(Math.max(...ratios)>1.12&&Math.max(...ratios)<1.23);assert(Math.min(...ratios)<.88&&Math.min(...ratios)>.75);
    assert.equal(ratios[0]>ratios[1],yaw>0);
    const a=projected(nose,nose.geometry.centroid,yaw),b=projected(face,[150,140],yaw);
    assert(Math.abs(a[0]-150)>4&&Math.abs(b[0]-150)<.5);
  }
});
test('侧转时下半脸绕向近侧，眼部保持开合空间，颈部锚点随复位归零',()=>{
  const project=portraitTurnField(face,[left,right,mouth]);
  const [x,y]=mouth.geometry.centroid;
  for(const yaw of [-15,15]){
    const mouthTravel=project([x,y],yaw,0)[0]*Math.sign(yaw);
    const contourTravel=project([x+Math.sign(yaw)*42,y],yaw,0)[0]*Math.sign(yaw);
    assert(mouthTravel-contourTravel>7);
    assert.equal(Math.abs(project([x,140],yaw,0)[0]),0);
    for(const eye of [left,right]){
      const [l,,r]=eye.geometry.canvasBounds,cy=eye.geometry.centroid[1];
      const width=r-l+project([r,cy],yaw,0)[0]-project([l,cy],yaw,0)[0];
      assert(width/(r-l)>.70&&width/(r-l)<1.28);
    }
    const aperture=eye=>{
      const [,t,,b]=eye.geometry.canvasBounds,[cx]=eye.geometry.centroid;
      return b-t+project([cx,b],yaw,0)[1]-project([cx,t],yaw,0)[1];
    };
    const [far,near]=yaw<0?[left,right]:[right,left];
    assert(aperture(far)>8&&aperture(far)<aperture(near)*.88);
  }
  assert.deepEqual(project([x,y],0,0),[0,0]);
});
test('完整参数范围内宽度保持正值；对角只加耦合修正，单轴不能重复变形',()=>{
  for(const yaw of [-45,45])for(const p of [left,right,mouth]){
    const [l,,r]=p.geometry.canvasBounds,y=p.geometry.centroid[1];
    assert(projected(p,[r,y],yaw)[0]>projected(p,[l,y],yaw)[0]);
  }
  for(const [x,y] of [[12,0],[0,8]])assert.deepEqual(surfaceTurn(face,face,x,y,true,anchors).to,surfaceTurn(face,face,0,0,false,anchors).from);
});

test('狭长睫毛、眼白和虹膜共用可逆的局部投影，包括半闭眼/转头叠加时的细网格',()=>{
  const lash=part(['eye','lash','left'],[107,81,145,86]),iris=part(['eye','iris','left'],[123,86,134,96]),eyeGroup=[left,lash,iris];
  for(const [yaw,pitch,diag] of [[15,0,false],[-15,0,false],[0,10,false],[15,10,true]]) {
    const apply=(p,[x,y])=>{
      const [s,tr]=surfaceTurnOperations(p,face,yaw,pitch,diag,anchors,eyeGroup),[l,t,r,b]=p.geometry.canvasBounds;
      assert(s.type==='scale'&&tr.type==='translate'&&s.factors[0]>0&&s.factors[1]>0);
      return [(x-(l+r)/2)*s.factors[0]+(l+r)/2+tr.delta[0]*(r-l),(y-(t+b)/2)*s.factors[1]+(t+b)/2+tr.delta[1]*(b-t)];
    };
    for(const pt of [[114,86],[127,89],[138,91]]) {
      const target=apply(left,pt);
      for(const p of [iris,lash]){const v=apply(p,pt);assert(Math.hypot(v[0]-target[0],v[1]-target[1])<1e-9);}
    }
  }
});

test('production head motion is inherited once; no per-mesh IDW or local affine head fields',async()=>{
 const {planRefinements}=await import('../src/rigging/recipe.mjs');
 const {sharedHeadShapes}=await import('../src/rigging/shared-face.mjs');
 const parts=[face,left,right,mouth,nose].map((p,i)=>({...p,id:'shared-'+i}));
 const brief={intent:{headMotion:{yawDegrees:12,pitchDegrees:8,rollDegrees:6},eyes:{blink:true,gaze:true},mouth:{speech:true},expressions:[],actions:[]}};
 const plan=planRefinements(parts,parts.map(p=>({target:'mesh:'+p.id,layerId:p.id})),brief);
 assert(!plan.steps.some(s=>['ParamAngleX','ParamAngleY'].includes(s.parameter.id)));
 const shapes=sharedHeadShapes(parts,brief);assert.equal(shapes.length,8);
 assert(shapes.every(s=>s.shape.target==='warp:DeformHeadContainer'));
 assert(shapes.every(s=>s.shape.operations[0].from.length===16));
});

test('sampled head field writes each existing lattice point without IDW spreading',async()=>{
 const {sampledHeadShapes}=await import('../src/rigging/shared-face.mjs');
 assert.equal(typeof sampledHeadShapes,'function');
 const parts=[face,left,right,mouth,nose],brief={intent:{headMotion:{yawDegrees:15,pitchDegrees:10,rollDegrees:6},eyes:{blink:true,gaze:true},mouth:{speech:true},expressions:[],actions:[]}};
 const result=sampledHeadShapes(parts,brief),{bounds,poses}=result;
 assert.equal(poses.length,8);
 const [l,t,r,b]=bounds,w=r-l,h=b-t;
 for(const pose of poses) {
  const points=Array.from({length:289},(_,i)=>[i%17/16,Math.floor(i/17)/16]);
  for(const s of pose.shapes) {
   assert(s.operations.length<=16);
   const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]),width=Math.max(...xs)-Math.min(...xs),height=Math.max(...ys)-Math.min(...ys);
   for(const op of s.operations){const i=op.selection.indices[0];points[i][0]+=op.delta[0]*width;points[i][1]+=op.delta[1]*height;}
  }
  for(let i=0;i<points.length;i++) {
   const u=i%17/16,v=Math.floor(i/17)/16;
   let [dx,dy]=faceTurnOffset([l+u*w,t+v*h],face.geometry.canvasBounds,pose.yaw,pose.pitch);
   if(pose.combined){const residual=faceTurnOffset([l+u*w,t+v*h],face.geometry.canvasBounds,pose.yaw,pose.pitch,true);dx+=residual[0];dy+=residual[1];}
   assert(Math.abs(points[i][0]-u-dx/w)<1e-10);
   assert(Math.abs(points[i][1]-v-dy/h)<1e-10);
  }
 }
});
