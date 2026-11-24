import { deflateSync, inflateSync } from 'node:zlib';

const signature = Buffer.from([137,80,78,71,13,10,26,10]);
const table = Array.from({length:256}, (_,n) => { for(let k=0;k<8;k++) n=(n&1)?0xedb88320^(n>>>1):n>>>1; return n>>>0; });
export function crc32(bytes) { let n=0xffffffff; for(const b of bytes) n=table[(n^b)&255]^(n>>>8); return (n^0xffffffff)>>>0; }
export function assertDimensions(width,height) {
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>8192||height>8192||width*height>16*1024*1024) throw new Error('IMAGE_DIMENSIONS_INVALID');
}
function chunk(type,data) { const tag=Buffer.from(type), out=Buffer.alloc(data.length+12); out.writeUInt32BE(data.length); tag.copy(out,4); data.copy(out,8);out.writeUInt32BE(crc32(out.subarray(4,-4)),out.length-4);return out; }
export function encodePng({width,height,data}) {
  assertDimensions(width,height); if(data.length!==width*height*4) throw new Error('PNG_PIXELS_INVALID');
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=6;
  const rows=Buffer.alloc(height*(width*4+1));for(let y=0;y<height;y++) Buffer.from(data.buffer,data.byteOffset+y*width*4,width*4).copy(rows,y*(width*4+1)+1);
  return Buffer.concat([signature,chunk('IHDR',ihdr),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}
function paeth(a,b,c) { const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c; }
// Strict 8-bit non-interlaced decoder; unsupported formats are errors, never blank replacements.
export function decodePng(bytes) {
  const b=Buffer.from(bytes);if(b.length<33||!b.subarray(0,8).equals(signature))throw new Error('PNG_SIGNATURE_INVALID');
  let pos=8,width,height,color,palette,alpha,ended=false;const blocks=[];
  while(pos<b.length) {
    if(pos+12>b.length)throw new Error('PNG_TRUNCATED');const size=b.readUInt32BE(pos),type=b.toString('ascii',pos+4,pos+8);pos+=8;
    if(size>b.length-pos-4)throw new Error('PNG_TRUNCATED');const d=b.subarray(pos,pos+size);
    if(crc32(b.subarray(pos-4,pos+size))!==b.readUInt32BE(pos+size))throw new Error('PNG_CRC_INVALID');pos+=size+4;
    if(type==='IHDR') { if(width||d.length!==13)throw new Error('PNG_HEADER_INVALID'); width=d.readUInt32BE();height=d.readUInt32BE(4);assertDimensions(width,height);color=d[9];if(d[8]!==8||d[10]!==0||d[11]!==0||d[12]!==0||![0,2,3,4,6].includes(color))throw new Error('PNG_FORMAT_UNSUPPORTED'); }
    else if(type==='PLTE')palette=d;else if(type==='tRNS')alpha=d;else if(type==='IDAT')blocks.push(d);else if(type==='IEND'){ended=true;break;}
    else if(type[0]===type[0].toUpperCase())throw new Error('PNG_CRITICAL_CHUNK_UNSUPPORTED');
  }
  if(!width||!ended||!blocks.length)throw new Error('PNG_INCOMPLETE');
  const channels={0:1,2:3,3:1,4:2,6:4}[color],stride=width*channels;
  const raw=inflateSync(Buffer.concat(blocks),{maxOutputLength:(stride+1)*height});if(raw.length!==(stride+1)*height)throw new Error('PNG_DATA_LENGTH_INVALID');
  const pixels=Buffer.alloc(stride*height);
  for(let y=0;y<height;y++) { const filter=raw[y*(stride+1)];if(filter>4)throw new Error('PNG_FILTER_INVALID');for(let x=0;x<stride;x++){const a=x>=channels?pixels[y*stride+x-channels]:0,bv=y?pixels[(y-1)*stride+x]:0,c=y&&x>=channels?pixels[(y-1)*stride+x-channels]:0; pixels[y*stride+x]=(raw[y*(stride+1)+x+1]+[0,a,bv,Math.floor((a+bv)/2),paeth(a,bv,c)][filter])&255;}}
  const data=Buffer.alloc(width*height*4);
  for(let i=0;i<width*height;i++) {const p=i*channels,q=i*4;
    if(color===6){pixels.copy(data,q,p,p+4);continue;}
    if(color===3){const n=pixels[p];if(!palette||n*3+2>=palette.length)throw new Error('PNG_PALETTE_INVALID');palette.copy(data,q,n*3,n*3+3);data[q+3]=alpha?.[n]??255;}
    else {data[q]=pixels[p];data[q+1]=color===2?pixels[p+1]:pixels[p];data[q+2]=color===2?pixels[p+2]:pixels[p];data[q+3]=color===4?pixels[p+1]:255;
      if(alpha&&color===0&&pixels[p]===alpha.readUInt16BE())data[q+3]=0;
      if(alpha&&color===2&&pixels[p]===alpha.readUInt16BE()&&pixels[p+1]===alpha.readUInt16BE(2)&&pixels[p+2]===alpha.readUInt16BE(4))data[q+3]=0;
    }
  }
  return {width,height,data,hasAlpha:[4,6].includes(color)||Boolean(alpha)};
}
export function alphaBounds(image) {
  let left=image.width,top=image.height,right=-1,bottom=-1,opaquePixels=0,transparentPixels=0;
  for(let y=0;y<image.height;y++)for(let x=0;x<image.width;x++){const a=image.data[(y*image.width+x)*4+3];if(a){left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);opaquePixels++;}if(a<255)transparentPixels++;}
  return {left,top,width:Math.max(0,right-left+1),height:Math.max(0,bottom-top+1),opaquePixels,transparentPixels};
}
export function cropPng(image,bounds) {
  const data=Buffer.alloc(bounds.width*bounds.height*4);
  for(let y=0;y<bounds.height;y++) image.data.copy(data,y*bounds.width*4,((bounds.top+y)*image.width+bounds.left)*4,((bounds.top+y)*image.width+bounds.left+bounds.width)*4);
  return {width:bounds.width,height:bounds.height,data};
}
export function composite(canvas,parts) {
  assertDimensions(canvas.width,canvas.height);const data=Buffer.alloc(canvas.width*canvas.height*4);
  for(const {image,rect,visible=true,opacity=1} of parts) {if(!visible)continue;
    const x0=Math.max(0,Math.floor(rect.left)),y0=Math.max(0,Math.floor(rect.top)),x1=Math.min(canvas.width,Math.ceil(rect.left+rect.width)),y1=Math.min(canvas.height,Math.ceil(rect.top+rect.height));
    for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++) {const sx=Math.min(image.width-1,Math.max(0,Math.floor((x+.5-rect.left)*image.width/rect.width))),sy=Math.min(image.height-1,Math.max(0,Math.floor((y+.5-rect.top)*image.height/rect.height))),s=(sy*image.width+sx)*4,d=(y*canvas.width+x)*4,sa=image.data[s+3]/255*opacity,da=data[d+3]/255,a=sa+da*(1-sa);if(!a)continue;for(let c=0;c<3;c++)data[d+c]=Math.round((image.data[s+c]*sa+data[d+c]*da*(1-sa))/a);data[d+3]=Math.round(a*255);}
  }
  return {...canvas,data};
}
