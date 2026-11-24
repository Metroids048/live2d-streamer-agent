// Geometry-guided ownership for the registered 1254px Hachi head. The blink
// edit guides hair occlusion only; all visible recovered RGB comes from head.
const clamp=x=>Math.max(0,Math.min(1,x));
const curves={
  right:{lid:[[349,675],[365,663],[382,654],[401,647],[422,642],[447,639],[473,640],[494,643],[515,649],[537,660],[553,673]],brow:[[350,614],[380,604],[410,598],[440,596],[470,597],[500,602],[532,613]],range:[330,570]},
  left:{lid:[[710,674],[728,659],[748,648],[771,641],[796,638],[823,640],[850,646],[875,655],[895,666],[913,679]],brow:[[704,614],[731,605],[760,598],[791,596],[823,599],[851,605],[894,618]],range:[690,950]},
};
function distance(x,y,points) {
  let best=Infinity;
  for(let i=1;i<points.length;i++) {
    const [ax,ay]=points[i-1],[bx,by]=points[i],dx=bx-ax,dy=by-ay;
    const t=clamp(((x-ax)*dx+(y-ay)*dy)/(dx*dx+dy*dy));
    best=Math.min(best,Math.hypot(x-ax-t*dx,y-ay-t*dy));
  }
  return best;
}
const curveY=(x,points)=>{for(let i=1;i<points.length;i++)if(x<=points[i][0]){const[a,b]=points[i-1],[c,d]=points[i];return b+(d-b)*(x-a)/(c-a);}return points.at(-1)[1];};
export function repairEyeOwnership(masks,head,blink) {
  const w=head.width,h=head.height,core=new Uint8Array(w*h),hair=new Uint8Array(w*h);
  const at=(x,y)=>blink.data.subarray((y*w+x)*4,(y*w+x)*4+4);
  const gray=(x,y)=>{const[r,g,b,a]=at(x,y);return a>100&&r-g<30&&b>=g&&g>(y<708?65:110);};
  for(const [side,{brow,range:[x0,x1]}]of Object.entries(curves))for(let y=575;y<731;y++)for(let x=x0;x<x1;x++) {
    if(!gray(x,y))continue;
    // A horizontal gray eyebrow is not a bang. Hair crosses its narrow band
    // with visible gray support above and below, unlike the isolated stroke.
    if(distance(x,y,brow)<8&&!(gray(x,y-9)&&gray(x,y+9)))continue;
    core[y*w+x]=1;
  }
  // Keep only gray regions connected to the upper bangs. Pale isolated skin
  // highlights in the blink edit must never turn neutral iris/lash pixels into
  // fixed hair when transferred back to the open-eye mother.
  const connected=new Uint8Array(w*h),queue=new Int32Array(w*h);let n=0;
  for(let x=300;x<980;x++)for(let y=575;y<580;y++)if(core[y*w+x]){connected[y*w+x]=1;queue[n++]=y*w+x;}
  for(let q=0;q<n;q++){const p=queue[q],x=p%w,y=Math.floor(p/w);for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const xx=x+dx,yy=y+dy,at=yy*w+xx;if(xx<0||xx>=w||yy<575||yy>=731||!core[at]||connected[at])continue;connected[at]=1;queue[n++]=at;}}
  for(const {range:[x0,x1]}of Object.values(curves))for(let y=575;y<731;y++)for(let x=x0;x<x1;x++) {
    const i=(y*w+x)*4,[r,g,b,a]=head.data.subarray(i,i+4);
    if(!a||r-g>48||b-g<-17)continue;
    for(let dy=-1;dy<=1&&!hair[y*w+x];dy++)for(let dx=-1;dx<=1;dx++)if(connected[(y+dy)*w+x+dx]){hair[y*w+x]=1;break;}
  }
  const counts={hairPixels:0,recoveredLidPixels:0,browPixels:0};
  const recovered=[],hiddenLidColumns=[],lashCleanup={};
  for(const [side,{lid,brow,range:[x0,x1]}]of Object.entries(curves)) {
    const rim=masks[`source-eye-rim-${side}`],eyebrow=masks[`registered-brow-${side}`];
    rim.data.fill(0);eyebrow.data.fill(0);
    for(let y=575;y<731;y++)for(let x=x0;x<x1;x++) {
      const i=(y*w+x)*4,[r,g,b,a]=head.data.subarray(i,i+4);if(!a)continue;
      if(hair[y*w+x]) {
        head.data.copy(masks['registered-hair-front'].data,i,i,i+4);counts.hairPixels++;
        for(const t of ['lash-upper','lash-lower'])masks[`source-eye-${t}-${side}`].data[i+3]=0;
        continue;
      }
      const ld=distance(x,y,lid);
      if(ld<4&&r-g>28) {
        const alpha=Math.round(a*clamp((4-ld)/1.5)*clamp((210-g)/40));
        if(alpha) {
          head.data.copy(rim.data,i,i,i+4);rim.data[i+3]=alpha;
          masks['registered-hair-front'].data[i+3]=0;counts.recoveredLidPixels++;
          if((x===400||x===500||x===860)&&y>663)recovered.push({x,y,rgba:[r,g,b,a],alpha});
        }
      }
    }
    // Keep the entire actual brow stroke between its two dark native edges,
    // including the light gray interior. RGB thresholds must not hollow it.
    for(let x=brow[0][0];x<=brow.at(-1)[0];x++) {
      const ys=[];
      for(let y=Math.round(curveY(x,brow))-11;y<=Math.round(curveY(x,brow))+11;y++) {
        const i=(y*w+x)*4,[r,g,b,a]=head.data.subarray(i,i+4);
        if(!hair[y*w+x]&&a&&g<195&&r-g<35&&b-g>-20)ys.push(y);
      }
      if(!ys.length||ys.at(-1)-ys[0]>20)continue;
      for(let y=ys[0]-1;y<=ys.at(-1)+1;y++) {
        const i=(y*w+x)*4;if(hair[y*w+x])continue;
        head.data.copy(eyebrow.data,i,i,i+4);masks['registered-hair-front'].data[i+3]=0;counts.browPixels++;
      }
    }
    // The neutral mother has real bangs over the lid. Complete only those
    // hidden column profiles using adjacent visible profiles of this same lid;
    // these are explicitly inferred texels, not recovered visible artwork.
    const profiles=new Map();
    for(let x=lid[0][0];x<=lid.at(-1)[0];x++) {
      let cy=null,green=170,occluded=false;
      for(let y=Math.round(curveY(x,lid))-6;y<=Math.round(curveY(x,lid))+6;y++) {
        const i=(y*w+x)*4;if(rim.data[i+3]>120&&rim.data[i+1]<green){cy=y;green=rim.data[i+1];}
        for(let dx=-2;dx<=2;dx++)if(hair[y*w+x+dx])occluded=true;
      }
      if(cy!==null&&!occluded)profiles.set(x,cy);
    }
    const valid=[...profiles.keys()];
    for(let x=valid[0];x<=valid.at(-1);x++) {
      if(profiles.has(x))continue;
      const left=valid.findLast(v=>v<x),right=valid.find(v=>v>x);
      if(left===undefined||right===undefined||right-left>55)continue;
      const from=x-left<=right-x?left:right,sy=profiles.get(from);
      const t=(x-left)/(right-left),ty=Math.round(curveY(x,lid)+(profiles.get(left)-curveY(left,lid))*(1-t)+(profiles.get(right)-curveY(right,lid))*t);
      const copied=[];
      for(let y=Math.round(curveY(x,lid))-7;y<=Math.round(curveY(x,lid))+7;y++)rim.data[(y*w+x)*4+3]=0;
      for(let dy=-4;dy<=4;dy++) {
        const si=((sy+dy)*w+from)*4,ti=((ty+dy)*w+x)*4;
        if(!rim.data[si+3])continue;
        rim.data.copy(rim.data,ti,si,si+4);copied.push({target:[x,ty+dy],source:[from,sy+dy],alpha:rim.data[si+3]});
      }
      hiddenLidColumns.push({side,x,sourceX:from,sourceCenterY:sy,targetCenterY:ty,pixels:copied});
    }
    // Rejoin the one-pixel anti-alias around the real upper lash. A hard dark
    // threshold had left warm edge texels fixed in hair and isolated specks in
    // the moving lash. Never grow into gray bangs or alter iris/sclera pixels.
    const lash=masks[`source-eye-lash-upper-${side}`];
    const seedSeen=new Uint8Array(w*h),seedComponents=[];
    for(let y=650;y<731;y++)for(let x=x0;x<x1;x++) {
      const start=y*w+x;if(seedSeen[start]||!lash.data[start*4+3])continue;
      const points=[start];seedSeen[start]=1;
      for(let q=0;q<points.length;q++){const p=points[q],px=p%w,py=Math.floor(p/w);for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const xx=px+dx,yy=py+dy,np=yy*w+xx;if(xx<x0||xx>=x1||yy<650||yy>=731||seedSeen[np]||!lash.data[np*4+3])continue;seedSeen[np]=1;points.push(np);}}
      seedComponents.push(points);
    }
    let removedDetachedSeedPixels=0;
    for(const points of seedComponents)if(points.length<45){for(const p of points)lash.data[p*4+3]=0;removedDetachedSeedPixels+=points.length;}
    const seed=Buffer.from(lash.data);
    let recoveredEdgePixels=0,removedIsolatedPixels=0;
    for(let y=650;y<731;y++)for(let x=x0;x<x1;x++) {
      const p=y*w+x,i=p*4,[r,g,b,a]=head.data.subarray(i,i+4);
      if(!a||hair[p]||r-g<25||g>215)continue;
      let near=false;
      for(let dy=-2;dy<=2&&!near;dy++)for(let dx=-2;dx<=2;dx++)if(seed[((y+dy)*w+x+dx)*4+3]){near=true;break;}
      if(!near)continue;
      const alpha=Math.round(a*clamp((225-g)/60));
      if(alpha>lash.data[i+3]){head.data.copy(lash.data,i,i,i+4);lash.data[i+3]=alpha;recoveredEdgePixels++;}
      masks['registered-hair-front'].data[i+3]=0;
    }
    const seen=new Uint8Array(w*h),components=[];
    for(let y=650;y<731;y++)for(let x=x0;x<x1;x++) {
      const start=y*w+x;if(seen[start]||!lash.data[start*4+3])continue;
      const points=[start];seen[start]=1;
      for(let q=0;q<points.length;q++){const p=points[q],px=p%w,py=Math.floor(p/w);for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const xx=px+dx,yy=py+dy,np=yy*w+xx;if(xx<x0||xx>=x1||yy<650||yy>=731||seen[np]||!lash.data[np*4+3])continue;seen[np]=1;points.push(np);}}
      components.push(points);
    }
    for(const points of components)if(points.length<6){for(const p of points)lash.data[p*4+3]=0;removedIsolatedPixels+=points.length;}
    lashCleanup[side]={removedDetachedSeedPixels,recoveredEdgePixels,removedIsolatedPixels};
  }
  return {method:'continuous native lid/brow bands with blink-guided bang occlusion',visiblePixelSource:'sources/head-master.png',occlusionGuide:'sources/blink-master.png',curves,counts,recoveredNativePixels:recovered,hiddenLidCompletion:{method:'nearest visible same-lid column profile, interpolated center behind original bang occlusion',columns:hiddenLidColumns},lashCleanup};
}
