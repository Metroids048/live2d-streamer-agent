// Sample the real open and closed lash ink in source coordinates. A rigid
// translation also drags the corners; a flat crop exposes the eye above them.
function trace(part,smooth) {
  const {image:{width,height,data},rect}=part;
  const line=Array.from({length:width},(_,x)=>{
    let moment=0,mass=0;
    for(let y=0;y<height;y++) {
      const i=(width*y+x)*4;
      const ink=Math.max(0,235-.299*data[i]-.587*data[i+1]-.114*data[i+2])*data[i+3];
      moment+=ink*(y+.5);mass+=ink;
    }
    return mass?rect.top+moment/mass*rect.height/height:null;
  });
  return x=>{
    const center=Math.floor((x-rect.left)*width/rect.width);
    if(!smooth||line[center]==null)return line[center];
    const neighbors=line.slice(Math.max(0,center-2),center+3).filter(v=>v!=null).sort((a,b)=>a-b);
    return neighbors[Math.floor(neighbors.length/2)];
  };
}

export function halfBlinkMaterials(parts,{noLowerLash=[],portrait=false}={}) {
  const profiles=new Map();
  for(const side of ['left','right']) {
    const get=(...tags)=>parts.find(p=>['eye',side,...tags].every(t=>p.tags.includes(t)));
    const upper=get('lash','upper'),closed=get('closed'),white=get('white');
    if(!upper||!closed||!white)continue;
    const inferred=noLowerLash.includes(side),a=trace(upper,inferred),b=trace(closed,inferred),r=white.rect;
    const profile=x=>{
      const start=a(x),end=b(x);
      if(start==null||end==null)return {dy:0,cut:start??r.top+r.height*.5};
      if(!inferred){const dy=Math.max(0,Math.min(r.height,(end-start)*.5));return {dy,cut:start+dy};}
      const u=(x-r.left)/r.width;
      const middle=Math.max(0,1-(2*u-1)**2);
      const corner=portrait?Math.min(1,middle*1.8):1;
      const dy=corner*Math.max(0,Math.min(r.height,Math.max((end-start)*.57,r.height*.31*middle)));
      return {dy,cut:start+dy+middle};
    };
    profiles.set(side,profile);
  }
  return parts.map(p=>{
    if(!p.tags.includes('eye'))return p;
    if(p.tags.includes('closed'))return {...p,visible:false};
    if(p.tags.includes('fold'))return {...p,opacity:(p.opacity??1)*(portrait?0:.12)};
    const side=p.tags.includes('left')?'left':'right';
    if(p.tags.includes('rim'))return {...p,opacity:(p.opacity??1)*(noLowerLash.includes(side)?.1:.3)};
    const profile=profiles.get(side);if(!profile)return p;
    const {image,rect}=p,{width,height}=image,upper=p.tags.includes('upper')&&p.tags.includes('lash');
    if(!upper&&!p.tags.includes('white')&&!p.tags.includes('iris'))return p;
    const contours=Array.from({length:width},(_,x)=>profile(rect.left+(x+.5)*rect.width/width));
    const unit=rect.height/height;
    if(!upper) {
      const data=Buffer.from(image.data);
      for(let y=0;y<height;y++)for(let x=0;x<width;x++){
        const i=(y*width+x)*4+3,coverage=Math.min(1,Math.max(0,(rect.top+(y+1)*unit-contours[x].cut)/unit));
        data[i]=Math.round(data[i]*coverage);
      }
      return {...p,image:{...image,data}};
    }
    const h=height+Math.ceil(Math.max(...contours.map(c=>c.dy))/unit),data=Buffer.alloc(width*h*4);
    for(let x=0;x<width;x++)for(let y=0;y<h;y++){
      const sy=y-contours[x].dy/unit,row=Math.floor(sy),t=sy-row,i=(y*width+x)*4;
      let alpha=0,channels=[0,0,0];
      for(const [yy,w] of [[row,1-t],[row+1,t]])if(yy>=0&&yy<height&&w) {
        const j=(yy*width+x)*4,a=image.data[j+3]*w;
        alpha+=a;for(let c=0;c<3;c++)channels[c]+=a*image.data[j+c];
      }
      if(alpha){data[i+3]=Math.round(alpha);for(let c=0;c<3;c++)data[i+c]=Math.round(channels[c]/alpha);}
    }
    return {...p,rect:{...rect,height:h*unit},image:{...image,height:h,data}};
  });
}
