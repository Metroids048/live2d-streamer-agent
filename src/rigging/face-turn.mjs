// PSD2Live expresses landmark offsets in the current mesh bounds. Compute them in
// one canvas coordinate system so overlaid skin, lids, eyes and lips agree.
const radians=d=>d*Math.PI/180;
const clamp01=x=>Math.max(0,Math.min(1,x));
const smooth=x=>{const t=clamp01(x);return t*t*(3-2*t);};
const arch=x=>Math.abs(x)<1?(1+Math.cos(Math.PI*x))/2:0;
const side=(p,s)=>p.tags.includes(s);
const inside=([x,y],[l,t,r,b])=>l<=x&&x<=r&&t<=y&&y<=b;

export function faceTurnAnchors(face,parts) {
  const find=(...tags)=>parts.find(p=>tags.every(t=>side(p,t)));
  const eyes=['left','right'].map(s=>find('eye','white',s));
  // If the artwork does not locate two distinct whites, keep contour-only support.
  if(eyes.some(p=>!p?.geometry?.centroid)||eyes[0]===eyes[1])return [];
  const anchors=[],put=p=>{if(p&&inside(p,face.geometry.canvasBounds))anchors.push(p);};
  for(const p of [...eyes,find('mouth','closed')])if(p) {
    const [l,,r]=p.geometry.canvasBounds,[x,y]=p.geometry.centroid;
    put([l,y]);put([x,y]);put([r,y]);
  }
  put(find('nose')?.geometry.centroid);
  // One shared bridge between the measured brows keeps both eye corners and
  // both mouth corners. author_axis caps each list at 16 including its contour.
  const brows=['left','right'].map(s=>find('brow',s)?.geometry.centroid);
  if(brows.every(Boolean))put([(brows[0][0]+brows[1][0])/2,(brows[0][1]+brows[1][1])/2]);
  return anchors;
}

export function faceTurnOffset([x,y],box,yaw,pitch,diagonal=false,portrait=false) {
  const [l,t,r,b]=box,w=r-l,h=b-t,u=(x-l)/w*2-1,v=(y-t)/h;
  const ax=radians(yaw),ay=radians(pitch),sx=Math.sin(ax)/(1+.45*Math.sin(ax)**2);
  // Rounded cross-section; finite derivatives keep far-side features from reversing.
  // Taper towards hairline and chin so skin at the head/neck seam remains attached.
  const support=smooth((v+.12)/.37)*smooth((1.035-v)/.31);
  const depth=arch(u)*support;
  if(diagonal) {
    // The authoring API already adds both cardinal shapes. Only the residual of
    // yaw followed by pitch belongs to the combined key.
    return [0,h*Math.sin(ay)*support*(.15*u*sx+.115*depth*(1-Math.cos(ax)))];
  }
  // Broad motion of the original hair/temple and stronger near/far projection
  // for a frontal illustrated face. It fades to zero at the neck anchor.
  const shell=portrait?smooth((1.06-v)/.46):0;
  return [w*(.32*u*(Math.cos(ax)-1)+(.29+(portrait ? .48 : 0))*depth*sx+shell*(.23*sx+.11*clamp01(1-Math.abs(u))*sx)),
    h*(.23*(2*v-1)*(Math.cos(ay)-1)-(.135+(portrait ? .10 : 0))*depth*Math.sin(ay)-.10*shell*Math.sin(ay))];
}

// Locate the visible face independently of the reconstructed forehead. The
// brow/eye line, mouth and neck give the crown, cheek and jaw different depth.
export function portraitTurnField(face,parts) {
  const eyes=parts.filter(p=>side(p,'eye')&&side(p,'white'));
  const mouth=parts.find(p=>side(p,'mouth')&&side(p,'closed'));
  if(eyes.length!==2||!mouth)return null;
  const [l,t,r,b]=face.geometry.canvasBounds,w=r-l,h=b-t;
  const ey=(eyes[0].geometry.centroid[1]+eyes[1].geometry.centroid[1])/2;
  const mx=mouth.geometry.centroid[0],my=mouth.geometry.centroid[1];
  if(!(t<ey&&ey<my&&my<b&&l<mx&&mx<r))return null;
  const cx=(l+r)/2;
  const orbitHeight=Math.max(...eyes.map(p=>p.geometry.canvasBounds[3]-p.geometry.canvasBounds[1]));
  const orbits=eyes.map(({geometry:{centroid:[x,y],canvasBounds:[a,c,d,e]}})=>({
    x,y,halfWidth:(d-a)/2,halfHeight:(e-c)/2,side:Math.sign(x-cx),
  }));
  return ([x,y],yaw,pitch)=>{
    const ax=radians(yaw),ay=radians(pitch),s=Math.sin(ax),p=Math.sin(ay);
    const u=(x-cx)/(w/2),v=(y-t)/h;
    const sideDepth=arch(u/1.22);
    const jaw=smooth((y-ey)/(b-ey));
    const neck=smooth((b-y)/Math.max((b-my)*.87,h*.085));
    const headCarry=smooth((b-y)/(h*.46));
    const forehead=smooth((ey-y)/(ey-t));
    const cheekBand=arch((y-(ey*.42+my*.58))/Math.max((my-ey)*1.3,h*.22));
    const noseBand=arch((y-(ey*.68+my*.32))/Math.max((my-ey)*.95,h*.15));
    const nose=arch((x-mx)/(w*.25))*noseBand;
    const orbit=arch((y-ey)/Math.max(orbitHeight*1.7,h*.23));
    const cheek=.105*cheekBand*arch(u/.96);
    const jawBand=arch((y-(my+b)*.5)/Math.max((b-my)*.9,h*.12));
    const shape=(.49+.19*forehead-.19*jaw-.22*orbit)*sideDepth+.11*nose+cheek;
    // Keep far hair tips and the neck attached. At a three-quarter angle the
    // cheek turns around the bridge while the near side opens and the far eye
    // compresses, with all eye/mouth masks still inheriting the same surface.
    const shell=.32*headCarry*(.52+.48*smooth((1.95-Math.abs(u))/1.05));
    const upperSkull=smooth((ey+h*.12-y)/(h*.38));
    const lateralSkull=smooth((Math.abs(u)-.35)/.80);
    // The crown and outer hair arc roll around the bridge as a volume.
    // A wider leading silhouette and receding far rim keep it from reading
    // as a stationary hair frame with sliding features.
    const crownSweep=.29*upperSkull*lateralSkull;
    const crownDepth=upperSkull*arch(u/1.85);
    const recedingRim=-.48*Math.max(-1.6,Math.min(1.6,u))*(1-Math.cos(ax))*upperSkull;
    const contourCheek=.18*cheekBand*smooth((Math.abs(u)-.33)/.69)
      *smooth((1.35-Math.abs(u))/.35);
    const wrap=-.36*Math.max(-1.4,Math.min(1.4,u))*(1-Math.cos(ax))*neck;
    const jawRound=.095*jawBand*arch(u/1.2);
    // The cheek mass follows the nose around the head before the jaw tapers
    // into the neck. A broad support avoids pinching the far eyelid.
    const cheekCarry=.10*cheekBand*smooth((1.38-Math.abs(u))/.62);
    // The mouth and lower cheek turn farther than the outer contour. Limit
    // this support below the eye line so the far eyelid keeps its aperture.
    const lowerFace=-.10*arch((y-my)/(h*.20))*arch((x-mx)/(w*.46));
    let dx=w*(s*(shell+crownSweep+.14*crownDepth+(shape+jawRound+cheekCarry+lowerFace+contourCheek)*neck)+wrap+recedingRim);
    let dy=h*(-p*(.095*headCarry+(.09*sideDepth+.065*nose)*neck)
      +.125*(2*clamp01(v)-1)*(Math.cos(ay)-1)*neck
      +s*u*(.045*cheekBand+.15*jawBand)*sideDepth*neck+.08*p*s*u*sideDepth*neck
      +s*Math.max(-1.5,Math.min(1.5,u))*.065*upperSkull*lateralSkull);
    for(const eye of orbits) {
      const far=smooth(eye.side*s/.275);
      const across=x-eye.x,down=y-eye.y;
      const support=arch(across/(eye.halfWidth*2.9))*arch(down/(eye.halfHeight*3.1));
      // Tilt and shorten the far aperture around the actual eye centre.
      // Skin, lashes, iris and closure inherit the same projection.
      // The distant lid and iris recede together. Preserve its height while
      // shortening its apparent horizontal span around the outer corner.
      dx-=far*support*(.10*across+.035*eye.side*eye.halfWidth);
      dy-=far*support*(.205*down+.085*eye.side*across);
    }
    return [dx,dy];
  };
}

export function surfaceTurn(part,face,yaw,pitch,diagonal=false,anchors=[]) {
  const bounds=part.geometry.canvasBounds,[l,t,r,b]=bounds,w=r-l,h=b-t;
  const from=(part.geometry.contourControls??part.geometry.arcControls).map(p=>[...p]);
  // v3.6.7 interpolates with inverse squared distance. Contour-only interpolation
  // cannot transfer central depth to the skin beneath an eye. Give all overlapping
  // meshes the same observed anchors and preserve the original contour supports.
  for(const p of anchors)if(inside(p,bounds)){
    const q=[(p[0]-l)/w,(p[1]-t)/h];
    if(!from.some(([x,y])=>Math.hypot((x-q[0])*w,(y-q[1])*h)<.35))from.push(q);
  }
  return {type:'landmarks',from,to:from.map(([x,y])=>{
    const [dx,dy]=faceTurnOffset([l+x*w,t+y*h],face.geometry.canvasBounds,yaw,pitch,diagonal);
    return [x+dx/w,y+dy/h];
  })};
}

// The 3.6.7 landmark tool uses inverse-distance interpolation, which can fold a
// long, nearly collinear eyelash triangle between good individual landmarks.
// Use one invertible local projection for each eye group and the mouth aperture.
export function surfaceTurnOperations(part,face,yaw,pitch,diagonal=false,anchors=[],parts=[]) {
  const s=['left','right'].find(s=>side(part,s)),eye=side(part,'eye')&&s&&parts.find(p=>['eye','white',s].every(t=>side(p,t)));
  const mouth=side(part,'mouth')&&parts.find(p=>side(p,'mouth')&&side(p,'open')&&!side(p,'line'));
  const reference=eye||mouth;
  if(!reference)return [surfaceTurn(part,face,yaw,pitch,diagonal,anchors)];
  const [xl,yt,xr,yb]=reference.geometry.canvasBounds,[l,t,r,b]=part.geometry.canvasBounds;
  const cx=(xl+xr)/2,cy=(yt+yb)/2,project=(x,y)=>faceTurnOffset([x,y],face.geometry.canvasBounds,yaw,pitch,diagonal);
  const scaleX=1+(project(xr,cy)[0]-project(xl,cy)[0])/(xr-xl);
  const scaleY=1+(project(cx,yb)[1]-project(cx,yt)[1])/(yb-yt);
  const [dx,dy]=project(cx,cy),px=(l+r)/2,py=(t+b)/2;
  return [{type:'scale',factors:[scaleX,scaleY],pivot:[.5,.5]},
    {type:'translate',delta:[(dx+(px-cx)*(scaleX-1))/(r-l),(dy+(py-cy)*(scaleY-1))/(b-t)]}];
}
