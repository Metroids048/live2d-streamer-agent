import { inflateSync } from 'node:zlib';
import { assertDimensions, encodePng } from './png.mjs';

// Narrow reader for the flat RGB8 PSD produced by See-Through. No PSD writer/importer.
// https://www.adobe.com/devnet-apps/photoshop/fileformatashtml/#50577409_75067
class Reader {
  constructor(bytes) { this.b=Buffer.from(bytes);this.p=0; }
  take(n) { if(!Number.isSafeInteger(n)||n<0||n>this.b.length-this.p)throw new Error('PSD_TRUNCATED');const out=this.b.subarray(this.p,this.p+n);this.p+=n;return out; }
  u8(){return this.take(1)[0];}u16(){return this.take(2).readUInt16BE();}i16(){return this.take(2).readInt16BE();}u32(){return this.take(4).readUInt32BE();}i32(){return this.take(4).readInt32BE();}str(n){return this.take(n).toString('ascii');}
  section(){return new Reader(this.take(this.u32()));}
}
function unpackPackBits(row,width) {
  const out=Buffer.alloc(width);let p=0,q=0;
  while(p<row.length){const n=row.readInt8(p++);if(n===-128)continue;const count=n<0?1-n:n+1;if(q+count>width)throw new Error('PSD_RLE_OVERFLOW');if(n<0){if(p>=row.length)throw new Error('PSD_RLE_TRUNCATED');out.fill(row[p++],q,q+count);}else{if(p+count>row.length)throw new Error('PSD_RLE_TRUNCATED');row.copy(out,q,p,p+count);p+=count;}q+=count;}
  if(q!==width)throw new Error('PSD_RLE_LENGTH_INVALID');return out;
}
function channelPixels(bytes,width,height) {
  const r=new Reader(bytes),compression=r.u16(),size=width*height;
  if(compression===0){const data=r.take(size);if(r.p!==r.b.length)throw new Error('PSD_CHANNEL_LENGTH_INVALID');return data;}
  if(compression===1){const lengths=Array.from({length:height},()=>r.u16()),out=Buffer.alloc(size);for(let y=0;y<height;y++)unpackPackBits(r.take(lengths[y]),width).copy(out,y*width);if(r.p!==r.b.length)throw new Error('PSD_CHANNEL_LENGTH_INVALID');return out;}
  if(compression===2){const out=inflateSync(r.take(r.b.length-r.p),{maxOutputLength:size});if(out.length!==size)throw new Error('PSD_CHANNEL_LENGTH_INVALID');return out;}
  throw new Error('PSD_COMPRESSION_UNSUPPORTED');
}
export function decodeLayeredPsd(bytes) {
  const r=new Reader(bytes);if(r.str(4)!=='8BPS'||r.u16()!==1)throw new Error('PSD_SIGNATURE_UNSUPPORTED');r.take(6);const channelCount=r.u16(),height=r.u32(),width=r.u32(),depth=r.u16(),mode=r.u16();assertDimensions(width,height);
  if(channelCount<3||depth!==8||mode!==3)throw new Error('PSD_REQUIRES_RGB8');r.section();r.section();const lm=r.section();if(!lm.b.length)throw new Error('PSD_NO_LAYERS');const layers=lm.section(),count=Math.abs(layers.i16());if(count<1||count>4096)throw new Error('PSD_LAYER_COUNT_INVALID');const records=[];let totalPixels=0;
  for(let i=0;i<count;i++){
    const top=layers.i32(),left=layers.i32(),bottom=layers.i32(),right=layers.i32(),w=right-left,h=bottom-top,n=layers.u16();if(n>16)throw new Error('PSD_CHANNEL_COUNT_UNSUPPORTED');
    const channels=Array.from({length:n},()=>({id:layers.i16(),length:layers.u32()}));if(layers.str(4)!=='8BIM')throw new Error('PSD_BLEND_SIGNATURE_INVALID');const blend=layers.str(4),opacity=layers.u8()/255,clipping=layers.u8(),flags=layers.u8();layers.u8();const extra=layers.section();const mask=extra.section();extra.section();const nameLen=extra.u8();let name=extra.take(nameLen).toString('latin1');extra.take((4-(nameLen+1)%4)%4);let group=false;
    while(extra.p+12<=extra.b.length){const sig=extra.str(4),key=extra.str(4),d=extra.section();if(!['8BIM','8B64'].includes(sig))throw new Error('PSD_EXTRA_SIGNATURE_INVALID');if(key==='luni'){const length=d.u32();name=new TextDecoder('utf-16be').decode(d.take(length*2));}if(key==='lsct'&&d.b.length>=4)group=d.u32()!==0;if(['lfx2','lrFX'].includes(key))throw new Error('PSD_EFFECTS_UNSUPPORTED');if(d.b.length%2&&extra.p<extra.b.length)extra.take(1);}
    if(group)throw new Error('PSD_GROUPS_UNSUPPORTED');if(w<0||h<0)throw new Error('PSD_RECT_INVALID');if(w&&h){assertDimensions(w,h);totalPixels+=w*h;if(totalPixels>64*1024*1024)throw new Error('PSD_TOTAL_PIXELS_LIMIT');}
    if(blend!=='norm'||clipping||mask.b.length||channels.some(c=>c.id< -1))throw new Error('PSD_BLEND_OR_MASK_UNSUPPORTED');
    records.push({name,width:w,height:h,rect:{left,top,width:w,height:h},channels,opacity,visible:!(flags&2)});
  }
  const parts=[];
  for(let i=0;i<records.length;i++){
    const rec=records[i],channels=new Map();for(const c of rec.channels){const payload=layers.take(c.length);if(rec.width&&rec.height)channels.set(c.id,channelPixels(payload,rec.width,rec.height));}
    if(!rec.width||!rec.height)continue;if(![0,1,2].every(id=>channels.has(id)))throw new Error('PSD_RGB_CHANNEL_MISSING');
    const data=Buffer.alloc(rec.width*rec.height*4);for(let p=0;p<rec.width*rec.height;p++){for(let c=0;c<3;c++)data[p*4+c]=channels.get(c)[p];data[p*4+3]=channels.has(-1)?channels.get(-1)[p]:255;}
    parts.push({id:`layer-${String(i).padStart(3,'0')}`,name:rec.name,png:encodePng({width:rec.width,height:rec.height,data}),rect:rec.rect,opacity:rec.opacity,visible:rec.visible,origin:'inpainted',inferredRegions:['Provider infers occluded content; per-pixel inference mask unavailable.']});
  }
  // PSD records are front-to-back; native PSD2Live Layout uses back-to-front.
  return {canvas:{width,height},parts:parts.reverse()};
}
