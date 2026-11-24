// Recover continuous straight RGBA from the opaque green editing canvas.
// Unlike the former hair cleanup, neither a binary alpha nor old edge RGB is
// substituted. Only chroma-adjacent mixed pixels are unmatted.
export function unmatteGreen(image) {
  const {width:w,height:h,data:src}=image;
  const out={width:w,height:h,data:Buffer.from(src)};
  const excess=i=>src[i+1]-Math.max(src[i],src[i+2]);
  const seed=i=>excess(i)<=25||(excess(i)<=100&&src[i]>100&&src[i+1]>180&&src[i+2]<130);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++) {
    const i=(y*w+x)*4,d=excess(i);
    if(seed(i))continue;
    if(d>=190){out.data.fill(0,i,i+4);continue;}
    let nearest=-1,dist=Infinity;
    for(let dy=-6;dy<=6;dy++)for(let dx=-6;dx<=6;dx++) {
      const xx=x+dx,yy=y+dy;
      if(xx<0||yy<0||xx>=w||yy>=h||dx*dx+dy*dy>=dist)continue;
      const j=(yy*w+xx)*4;
      if(seed(j)){nearest=j;dist=dx*dx+dy*dy;}
    }
    if(nearest<0){out.data.fill(0,i,i+4);continue;}
    const bg=[0,255,0],f=src.subarray(nearest,nearest+3);
    let num=0,den=0;
    for(let c=0;c<3;c++){num+=(src[i+c]-bg[c])*(f[c]-bg[c]);den+=(f[c]-bg[c])**2;}
    const a=Math.max(0,Math.min(1,num/den));
    if(a<.025){out.data.fill(0,i,i+4);continue;}
    for(let c=0;c<3;c++)out.data[i+c]=Math.round(Math.max(0,Math.min(255,(src[i+c]-(1-a)*bg[c])/a)));
    out.data[i+3]=Math.round(a*255);
  }
  // Neutral gray hair cannot contain a green key-color excess. Despill only
  // neutral/mixed boundary colors; genuine yellow/lime/red remains unchanged.
  for(let i=0;i<out.data.length;i+=4)if(out.data[i+3]&&out.data[i+2]>out.data[i]*.65&&out.data[i+1]>Math.max(out.data[i],out.data[i+2]))out.data[i+1]=Math.max(out.data[i],out.data[i+2]);
  return out;
}
