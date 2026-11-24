import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanAlpha,extractPixels,insidePolygon,composeRegisteredFace,recoverDetachedEyeContours,completeCleanEyeSupport,extractClosedEyeContours} from '../src/artwork/hd-materialize.mjs';
import {encodePng,decodePng} from '../src/artwork/png.mjs';
import {repairEyeOwnership} from '../src/artwork/hd-eye-ownership.mjs';

test('HD extraction preserves source pixels and native canvas dimensions',()=>{
  const source={width:7,height:5,data:Buffer.from(Array.from({length:7*5*4},(_,i)=>i%4===3?255:i%251))};
  const extracted=decodePng(encodePng(extractPixels(source,(x,y)=>insidePolygon(x,y,[[1,1],[6,1],[6,4],[1,4]]))));
  assert.equal(extracted.width,7);assert.equal(extracted.height,5);
  for(let y=0;y<5;y++)for(let x=0;x<7;x++){
    const i=(y*7+x)*4;
    if(x>=1&&x<6&&y>=1&&y<4)assert.deepEqual(extracted.data.subarray(i,i+4),source.data.subarray(i,i+4));
    else assert.equal(extracted.data[i+3],0);
  }
});

test('matte cleanup changes alpha only and leaves the opaque character interior',()=>{
  const source={width:20,height:20,data:Buffer.alloc(20*20*4)};
  for(let y=3;y<17;y++)for(let x=3;x<17;x++)source.data.set([231,175,142,255],(y*20+x)*4);
  source.data.set([255,0,0,255],(10*20+2)*4);source.data.set([255,255,0,255],(10*20+17)*4);
  const cleaned=cleanAlpha(source);
  assert.equal(cleaned.data[(10*20+2)*4+3],0);assert.equal(cleaned.data[(10*20+17)*4+3],0);
  assert.equal(cleaned.data[(10*20+10)*4+3],255);
  for(let i=0;i<source.data.length;i+=4)assert.deepEqual(cleaned.data.subarray(i,i+3),source.data.subarray(i,i+3));
  assert.equal(source.data[(10*20+2)*4+3],255);
});

test('registered face removes fixed eye rims, mouth rim and lower-lip shadow using clean skin',()=>{
  const image=color=>({width:1254,height:1254,data:Buffer.from(Array(1254*1254).fill(color).flat())});
  const clean=image([250,220,215,255]),source=image([240,200,190,255]);
  const at=(im,x,y)=>im.data.subarray((y*im.width+x)*4,(y*im.width+x)*4+4);
  source.data.set([80,30,20,255],(961*1254+552)*4);
  source.data.set([120,50,40,255],(1020*1254+627)*4);
  source.data.set([90,40,30,255],(700*1254+400)*4);
  source.data.set([100,60,50,255],(755*1254+860)*4);
  clean.data[(1040*1254+729)*4+3]=0;
  const face=composeRegisteredFace(clean,source);
  for(const [x,y]of [[552,961],[627,1020],[400,700],[860,755]])assert.deepEqual(at(face,x,y),at(clean,x,y));
  assert.deepEqual(at(face,627,900),at(source,627,900));
  assert.deepEqual(at(face,480,980),at(source,480,980));
  assert.deepEqual(at(face,729,1040),at(source,729,1040),'a narrower inferred oval must not punch a hole in the real jaw');
  const feather=at(face,519,980);
  assert.ok(feather[0]>240&&feather[0]<250,'transition retains a gradual source-to-clean skin blend');
  assert.deepEqual(at(source,552,961),Buffer.from([80,30,20,255]),'input remains immutable');
});

test('detached eye contours retain source RGB in eye layers while connected bangs and brows stay fixed',()=>{
  const blank=()=>({width:1254,height:1254,data:Buffer.alloc(1254*1254*4)});
  const masks=Object.fromEntries(['registered-hair-front',...['right','left'].flatMap(s=>['rim','lash-upper','lash-lower'].map(p=>`source-eye-${p}-${s}`))].map(id=>[id,blank()]));
  const hair=masks['registered-hair-front'];
  const set=(x,y,c=[190,95,80,253])=>hair.data.set(c,(y*1254+x)*4);
  set(375,675);set(860,666);set(400,605);
  for(let y=400;y<=680;y++)set(500,y,[145,130,142,253]);
  assert.deepEqual(recoverDetachedEyeContours(masks),{right:1,left:1});
  assert.deepEqual([...masks['source-eye-lash-upper-right'].data.subarray((675*1254+375)*4,(675*1254+375)*4+4)],[190,95,80,253]);
  assert.equal(hair.data[(675*1254+375)*4+3],0);
  assert.equal(hair.data[(605*1254+400)*4+3],253,'brow stays fixed');
  assert.equal(hair.data[(680*1254+500)*4+3],253,'root-connected hair stays fixed');
});

test('clean skin fills outer-eye alpha holes without changing the jaw or source support color',()=>{
  const skin={width:1254,height:1254,data:Buffer.alloc(1254*1254*4)};
  for(let y=625;y<805;y++)for(let x=400;x<866;x++)skin.data.set([251,211,204,255],(y*1254+x)*4);
  skin.data.set([245,190,180,253],(1100*1254+630)*4);
  completeCleanEyeSupport(skin);
  for(const [x,y]of [[340,740],[910,740]])assert.deepEqual([...skin.data.subarray((y*1254+x)*4,(y*1254+x)*4+4)],[251,211,204,255]);
  assert.deepEqual([...skin.data.subarray((1100*1254+630)*4,(1100*1254+630)*4+4)],[245,190,180,253]);
  assert.equal(skin.data[(900*1254+340)*4+3],0,'eye support must not expand the jaw');
});

test('closed eye retains true lash and light crease RGB without a broad skin patch',()=>{
  const source={width:1254,height:1254,data:Buffer.alloc(1254*1254*4)};
  for(let y=700;y<780;y++)for(let x=330;x<580;x++)source.data.set([252,211,202,253],(y*1254+x)*4);
  source.data.set([45,25,35,253],(740*1254+430)*4);
  source.data.set([200,172,170,253],(727*1254+500)*4);
  const closed=extractClosedEyeContours(source,'right');
  for(const [x,y]of [[430,740],[500,727]])assert.deepEqual(closed.data.subarray((y*1254+x)*4,(y*1254+x)*4+4),source.data.subarray((y*1254+x)*4,(y*1254+x)*4+4));
  assert.equal(closed.data[(740*1254+450)*4+3],0,'redundant skin must be transparent');
  assert.equal(source.data[(740*1254+450)*4+3],253,'mother pixels remain immutable');
});

test('eye ownership keeps connected bangs fixed, whole brow highlights, and traces hidden lid completion',()=>{
  const blank=()=>({width:1254,height:1254,data:Buffer.alloc(1254*1254*4)});
  const ids=['registered-hair-front',...['right','left'].flatMap(s=>[`registered-brow-${s}`,...['rim','lash-upper','lash-lower','white','iris'].map(p=>`source-eye-${p}-${s}`)])];
  const masks=Object.fromEntries(ids.map(id=>[id,blank()])),head=blank(),blink=blank();
  const put=(im,x,y,c)=>im.data.set(c,(y*1254+x)*4),at=(im,x,y)=>im.data.subarray((y*1254+x)*4,(y*1254+x)*4+4);
  for(let x=410;x<490;x++)for(let y=639;y<645;y++)put(head,x,y,[125,70,60,253]);
  for(let x=454;x<=460;x++)for(let y=575;y<=660;y++){put(head,x,y,[170,150,160,253]);put(blink,x,y,[170,150,160,253]);}
  for(let x=395;x<410;x++)for(let y=592;y<=603;y++)put(head,x,y,y===592||y===603?[90,80,85,253]:[234,221,220,253]);
  for(let x=370;x<420;x++)for(let y=674;y<679;y++){put(head,x,y,[45,25,35,253]);put(masks['source-eye-lash-upper-right'],x,y,[45,25,35,253]);}
  put(head,560,652,[60,30,40,253]);put(masks['source-eye-lash-upper-right'],560,652,[60,30,40,253]);
  put(masks['source-eye-iris-right'],460,717,[220,140,5,253]);put(masks['source-eye-white-right'],390,717,[250,245,252,255]);
  const before=Object.fromEntries(['source-eye-iris-right','source-eye-white-right'].map(id=>[id,Buffer.from(masks[id].data)]));
  const metadata=repairEyeOwnership(masks,head,blink);
  assert.deepEqual(at(masks['registered-hair-front'],457,641),at(head,457,641),'actual bang remains at its mother coordinates');
  assert.deepEqual(at(masks['registered-brow-right'],400,598),at(head,400,598),'light gray brow interior is not thresholded into a hole');
  assert.equal(masks['source-eye-lash-upper-right'].data[(652*1254+560)*4+3],0,'isolated threshold speck is not a moving lash');
  assert.deepEqual(at(masks['source-eye-lash-upper-right'],390,676),at(head,390,676),'connected real lash stroke is preserved');
  for(const[id,bytes]of Object.entries(before))assert.deepEqual(masks[id].data,bytes,'iris and sclera raster stay unchanged');
  const completion=metadata.hiddenLidCompletion.columns.find(c=>c.x===457&&c.side==='right');
  assert.ok(completion?.pixels.length,'hidden lid beneath the fixed bang is completed');
  for(const p of completion.pixels){const actual=at(masks['source-eye-rim-right'],...p.target),source=at(head,...p.source);assert.deepEqual(actual.subarray(0,3),source.subarray(0,3),'inferred hidden RGB traces to the same head mother');assert.equal(actual[3],p.alpha);}
  assert.deepEqual(at(head,457,641),Buffer.from([170,150,160,253]),'mother is immutable');
});
