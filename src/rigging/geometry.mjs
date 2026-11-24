import {inflateSync} from 'node:zlib';

const signature=Buffer.from([137,80,78,71,13,10,26,10]);
const crcTable=Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
export function crc32(bytes) {let n=0xffffffff;for(const b of bytes)n=crcTable[(n^b)&255]^(n>>>8);return (n^0xffffffff)>>>0;}

// Analysis only. No generated/edited images; reject unsupported encodings explicitly.
export function decodePng(bytes) {
  const b=Buffer.from(bytes);if(!b.subarray(0,8).equals(signature))throw new Error('PNG_SIGNATURE');
  let width,height,type,channels,palette,transparency,ended=false,header=false;const data=[];
  for(let at=8;at<b.length;) {
    if(at+12>b.length)throw new Error('PNG_TRUNCATED');
    const length=b.readUInt32BE(at),tag=b.toString('ascii',at+4,at+8),end=at+12+length;
    if(end>b.length||length>67108864)throw new Error('PNG_CHUNK_LENGTH');
    const p=b.subarray(at+8,at+8+length);
    if(crc32(b.subarray(at+4,at+8+length))!==b.readUInt32BE(at+8+length))throw new Error('PNG_CRC');
    if(!header&&tag!=='IHDR')throw new Error('PNG_HEADER');
    if(tag==='IHDR') {
      if(header||length!==13)throw new Error('PNG_HEADER');header=true;
      width=p.readUInt32BE(0);height=p.readUInt32BE(4);type=p[9];channels=({0:1,2:3,3:1,4:2,6:4})[type];
      if(!width||!height||width*height>16777216||p[8]!==8||!channels||p[10]||p[11]||p[12])throw new Error('PNG_UNSUPPORTED_ENCODING');
    } else if(tag==='PLTE')palette=p;
    else if(tag==='tRNS')transparency=p;
    else if(tag==='IDAT')data.push(p);
    else if(tag==='IEND') {if(length||end!==b.length)throw new Error('PNG_TRAILING_DATA');ended=true;break;}
    else if(tag[0]===tag[0].toUpperCase())throw new Error('PNG_UNSUPPORTED_CRITICAL_CHUNK');
    at=end;
  }
  if(!header||!ended||!data.length||type===3&&(!palette||palette.length%3))throw new Error('PNG_INCOMPLETE');
  const stride=width*channels,size=(stride+1)*height;
  const packed=inflateSync(Buffer.concat(data),{maxOutputLength:size});if(packed.length!==size)throw new Error('PNG_DECODE_LENGTH');
  const raw=Buffer.alloc(stride*height),rgba=Buffer.alloc(width*height*4);
  const paeth=(a,c,d)=>{const p=a+c-d,x=Math.abs(p-a),y=Math.abs(p-c),z=Math.abs(p-d);return x<=y&&x<=z?a:y<=z?c:d;};
  for(let y=0;y<height;y++) {
    const filter=packed[y*(stride+1)];if(filter>4)throw new Error('PNG_FILTER');
    for(let x=0;x<stride;x++) {
      const i=y*stride+x,a=x>=channels?raw[i-channels]:0,c=y?raw[i-stride]:0,d=y&&x>=channels?raw[i-stride-channels]:0;
      raw[i]=(packed[y*(stride+1)+1+x]+([0,a,c,Math.floor((a+c)/2),paeth(a,c,d)][filter]))&255;
    }
  }
  for(let i=0;i<width*height;i++) {
    const s=i*channels,o=i*4;
    if(type===6)raw.copy(rgba,o,s,s+4);
    else if(type===4) {rgba[o]=rgba[o+1]=rgba[o+2]=raw[s];rgba[o+3]=raw[s+1];}
    else if(type===3) {const n=raw[s];if(n*3+2>=palette.length)throw new Error('PNG_PALETTE');palette.copy(rgba,o,n*3,n*3+3);rgba[o+3]=transparency?.[n]??255;}
    else if(type===2) {raw.copy(rgba,o,s,s+3);rgba[o+3]=transparency?.length===6&&raw[s]===transparency.readUInt16BE(0)&&raw[s+1]===transparency.readUInt16BE(2)&&raw[s+2]===transparency.readUInt16BE(4)?0:255;}
    else {rgba[o]=rgba[o+1]=rgba[o+2]=raw[s];rgba[o+3]=transparency?.length===2&&raw[s]===transparency.readUInt16BE(0)?0:255;}
  }
  return {width,height,rgba};
}

// Compare render-space alpha at each pixel: a correct total on a displaced pink rim must fail.
export function eyeRimFade(open,half,closed) {
  if([half,closed].some(im=>im.width!==open.width||im.height!==open.height))throw new Error('RIM_RENDER_CAMERA_CHANGED');
  let fullAlpha=0,halfAlpha=0,closedAlpha=0,deviation=0;
  for(let i=3;i<open.rgba.length;i+=4) {
    const a=open.rgba[i],h=half.rgba[i];fullAlpha+=a;halfAlpha+=h;closedAlpha+=closed.rgba[i];
    deviation+=Math.abs(h-.30*a);
  }
  return {fullAlpha,halfAlpha,closedAlpha,halfRatio:fullAlpha?halfAlpha/fullAlpha:null,
    normalizedDeviation:fullAlpha?deviation/fullAlpha:null,passed:fullAlpha>0&&closedAlpha===0&&deviation<=.04*fullAlpha};
}

// A crease belonging to the upper lid must move with its aperture. Fading a
// stationary duplicate cannot satisfy this check, even if its total alpha falls.
export function eyeRimAperture(open,half,closed) {
  if([half,closed].some(im=>im.width!==open.width||im.height!==open.height))throw new Error('RIM_RENDER_CAMERA_CHANGED');
  const measure=im=>{let top=im.height,bottom=-1,peak=0,pixels=0;
    for(let y=0;y<im.height;y++)for(let x=0;x<im.width;x++){const a=im.rgba[(y*im.width+x)*4+3];peak=Math.max(peak,a);if(a>=16){top=Math.min(top,y);bottom=Math.max(bottom,y);pixels++;}}
    return {height:Math.max(0,bottom-top+1),peak,pixels};
  };
  const full=measure(open),mid=measure(half),end=measure(closed),heightRatio=full.height?mid.height/full.height:null;
  return {full,half:mid,closed:end,heightRatio,passed:full.pixels>0&&mid.pixels>0&&end.peak===0&&mid.peak>=full.peak*.8&&heightRatio>.15&&heightRatio<.8};
}

export function alphaGeometry(image,rect) {
  const {width,height,rgba}=image;let left=width,top=height,right=-1,bottom=-1,count=0,sx=0,sy=0;
  const rows=Array.from({length:height},()=>({left:width,right:-1,count:0}));
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(rgba[(y*width+x)*4+3]>=16) {
    left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);count++;sx+=x+.5;sy+=y+.5;
    rows[y].left=Math.min(rows[y].left,x);rows[y].right=Math.max(rows[y].right,x);rows[y].count++;
  }
  if(!count)throw new Error('PART_EMPTY_ALPHA');
  const band=Math.max(1,Math.ceil((bottom-top+1)*.08));let rootX=0,roots=0,tipX=0,tips=0;
  for(let y=top;y<=bottom;y++)for(let x=left;x<=right;x++)if(rgba[(y*width+x)*4+3]>=16) {
    if(y<top+band){rootX+=x+.5;roots++;}if(y>bottom-band){tipX+=x+.5;tips++;}
  }
  // Support points sampled at actual opaque-area quartiles. These are measured silhouette
  // coordinates, not assumed eye/jaw positions or a semantic landmark detector.
  const areaRow=fraction=>{let n=0;for(let y=top;y<=bottom;y++){n+=rows[y].count;if(n>=count*fraction)return y;}return bottom;};
  const upper=areaRow(.25),lower=areaRow(.75),pw=right-left+1,ph=bottom-top+1;
  const point=(x,y)=>[(x-left)/pw,(y-top)/ph];
  const contourControls=[point(rows[upper].left,upper+.5),point(rows[upper].right+1,upper+.5),point(rows[lower].left,lower+.5),point(rows[lower].right+1,lower+.5),point(tipX/tips,bottom+1)];
  const distinct=new Set(contourControls.map(p=>p.join(':'))).size===5&&upper<lower;
  // Side contacts anchor eyelids and mouth corners at the actual opaque ends.
  const edgeCentre=side=>{
    const edge=side==='left'?left:right;let sum=0,n=0;
    for(let y=top;y<=bottom;y++)if(rows[y].count&&rows[y][side]===edge){sum+=y+.5;n++;}
    return point(side==='left'?left:right+1,sum/n);
  };
  const arcControls=[edgeCentre('left'),point(rootX/roots,top),edgeCentre('right'),point(tipX/tips,bottom+1)];
  const canvas=(x,y)=>[rect.left+x/width*rect.width,rect.top+y/height*rect.height];
  return {alphaThreshold:16,opaquePixels:count,coverage:count/(width*height),
    pixelBounds:[left,top,right+1,bottom+1],canvasBounds:[...canvas(left,top),...canvas(right+1,bottom+1)],
    centroid:canvas(sx/count,sy/count),
    arcControls,root:[(rootX/roots-left)/(right-left+1),0],tip:[(tipX/tips-left)/(right-left+1),1],
    contourControls:distinct?contourControls:null,contourControlMethod:'alpha_area_quartile_supports',
    confidence:'alpha_geometry_only',semanticLandmarksVerified:false};
}

export function pixelDifference(a,b) {
  if(a.width!==b.width||a.height!==b.height)throw new Error('RENDER_CAMERA_CHANGED');let changedPixels=0;
  for(let i=0;i<a.rgba.length;i+=4) {
    // Ignore RGB carried by fully transparent pixels.
    if(a.rgba[i+3]===0&&b.rgba[i+3]===0)continue;
    if(a.rgba[i+3]!==b.rgba[i+3]||a.rgba[i]!==b.rgba[i]||a.rgba[i+1]!==b.rgba[i+1]||a.rgba[i+2]!==b.rgba[i+2])changedPixels++;
  }
  return {changedPixels,totalPixels:a.width*a.height};
}

export function inspectTopology(vertices,triangles) {
  const points=new Map(vertices.map(([id,x,y])=>[id,[x,y]])),edges=new Map();const issues=[];
  for(const [id,x,y] of vertices)if(!Number.isInteger(id)||!Number.isFinite(x)||!Number.isFinite(y))issues.push({code:'INVALID_VERTEX',id});
  if(points.size!==vertices.length)issues.push({code:'DUPLICATE_VERTEX'});
  let sign=0;
  for(const [id,a,b,c] of triangles) {
    const p=points.get(a),q=points.get(b),r=points.get(c);
    if(!p||!q||!r||new Set([a,b,c]).size!==3){issues.push({code:'INVALID_TRIANGLE',id});continue;}
    const area=(q[0]-p[0])*(r[1]-p[1])-(q[1]-p[1])*(r[0]-p[0]);
    if(!Number.isFinite(area)||Math.abs(area)<1e-10)issues.push({code:'DEGENERATE_TRIANGLE',id});
    else if(sign&&Math.sign(area)!==sign)issues.push({code:'INCONSISTENT_WINDING',id});else sign=Math.sign(area);
    for(const [x,y] of [[a,b],[b,c],[c,a]]){const key=[x,y].sort((u,v)=>u-v).join(':');edges.set(key,(edges.get(key)??0)+1);}
  }
  for(const [edge,count] of edges)if(count>2)issues.push({code:'NON_MANIFOLD_EDGE',edge,count});
  if(vertices.length<3||!triangles.length)issues.push({code:'EMPTY_TOPOLOGY'});
  return {ok:issues.length===0,vertices:vertices.length,triangles:triangles.length,issues,
    scope:'rest topology only; posed folds, clipping leaks and visual quality require actual pose review'};
}

export function inspectGif(bytes) {
  const b=Buffer.from(bytes);if(!['GIF87a','GIF89a'].includes(b.toString('ascii',0,6))||b.length<14)throw new Error('GIF_HEADER');
  let at=13,frames=0,durationCs=0,delay=0;
  if(b[10]&128)at+=3*2**((b[10]&7)+1);
  const subblocks=()=>{for(;;){if(at>=b.length)throw new Error('GIF_TRUNCATED');const size=b[at++];if(!size)break;at+=size;if(at>b.length)throw new Error('GIF_TRUNCATED');}};
  while(at<b.length) {
    const tag=b[at++];if(tag===0x3b)return {frames,durationSeconds:durationCs/100,width:b.readUInt16LE(6),height:b.readUInt16LE(8)};
    if(tag===0x21) {
      if(at>=b.length)throw new Error('GIF_TRUNCATED');const kind=b[at++];
      if(kind===0xf9) {if(at+6>b.length||b[at]!==4||b[at+5]!==0)throw new Error('GIF_CONTROL');delay=b.readUInt16LE(at+2);at+=6;}
      else subblocks();
    } else if(tag===0x2c) {
      if(at+9>b.length)throw new Error('GIF_TRUNCATED');const flags=b[at+8];at+=9;if(flags&128)at+=3*2**((flags&7)+1);
      if(at>=b.length)throw new Error('GIF_TRUNCATED');at++;subblocks();frames++;durationCs+=delay;delay=0;
    } else throw new Error('GIF_BLOCK');
  }
  throw new Error('GIF_TRAILER_MISSING');
}
