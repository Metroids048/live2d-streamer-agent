import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {prepareRigFaceImport,needsMeshTraceSupport} from '../src/rigging/import-face.mjs';
import {decodePng,encodePng} from '../src/artwork/png.mjs';

test('import joins jaw skin to the face without touching source assets or merging the neck',async t=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'rig-import-face-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const from=path.join(root,'artwork'),to=path.join(root,'rigging');
  await fs.mkdir(from);
  const layers=[];
  for(const [id,tags,x,y,pixels] of [
    ['neck',['neck'],2,4,[90,60,55,255]],
    ['f',['face'],1,2,[250,204,190,255,230,170,160,255]],
    ['c',['face','detail','chin-overlap'],2,2,[128,41,90,128,90,60,55,255]]
  ]) {
    const image={path:id+'.png',width:pixels.length/4,height:1};
    await fs.writeFile(path.join(from,image.path),encodePng({...image,data:Buffer.from(pixels)}));
    layers.push({id,tags,rect:{left:x,top:y,width:image.width,height:1},image});
  }
  const layoutFile=path.join(from,'layout.json'),layout={canvas:{width:8,height:8},layers};
  const original=JSON.stringify(layout);
  await fs.writeFile(layoutFile,original);
  const source={layoutFile,layout,parts:layers};
  const fixed=await prepareRigFaceImport(source,root,to);
  assert.deepEqual(fixed.parts.map(p=>p.id),['neck','f']);
  assert.deepEqual(fixed.parts[1].sourceLayerIds,['f','c']);
  assert.deepEqual(fixed.parts[1].geometry.canvasBounds,[1,2,4,3]);
  const pixels=decodePng(await fs.readFile(path.join(root,fixed.parts[1].imagePath))).data;
  assert.deepEqual([...pixels],[250,204,190,255,179,105,125,255,90,60,55,255]);
  assert.deepEqual(fixed.meshRestores.find(p=>p.layerId==='f'),{layerId:'f',path:path.join(root,fixed.parts[1].imagePath)});
  assert.equal(await fs.readFile(layoutFile,'utf8'),original);
  assert.deepEqual(await fs.readFile(path.join(path.dirname(fixed.layoutFile),fixed.layout.layers[0].image.path)),
    await fs.readFile(path.join(from,'neck.png')));
  const sourceChin=decodePng(await fs.readFile(path.join(from,'c.png')));
  assert.deepEqual([...sourceChin.data],[128,41,90,128,90,60,55,255]);

  for(const change of [{visible:false},{variant:{type:'switch'}},{rect:{...layers[2].rect,left:2.3}}]) {
    const custom={...source,layout:{...layout,layers:[layers[0],layers[1],{...layers[2],...change}]}};
    const separate=await prepareRigFaceImport(custom,root,to);
    assert.equal(separate.parts,custom.parts);
    assert.deepEqual(separate.layout.layers.map(p=>p.id),['neck','f','c']);
    assert.deepEqual(separate.layout.layers.map(({image,...p})=>p),custom.layout.layers.map(({image,...p})=>p));
    assert.deepEqual(separate.meshRestores.map(p=>p.layerId),['neck','f','c']);
  }
});

test('thin eye uses an expanded tracing raster and retains its original alpha for replacement',async t=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'rig-import-rim-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const folder=path.join(root,'artwork');await fs.mkdir(folder);
  const data=Buffer.alloc(7*7*4);data[(3*7+3)*4+3]=80;
  await fs.writeFile(path.join(folder,'rim.png'),encodePng({width:7,height:7,data}));
  const p={id:'rim',tags:['eye','rim','right'],image:{path:'rim.png',width:7,height:7},rect:{left:3,top:7,width:7,height:7}};
  const source={layout:{layers:[p],canvas:{width:12,height:16}},parts:[p],layoutFile:path.join(folder,'layout.json')};
  const imported=await prepareRigFaceImport(source,root,path.join(root,'rigging'));
  assert.equal(imported.parts,source.parts);
  assert.deepEqual(imported.meshRestores,[{layerId:'rim',path:path.join(folder,'rim.png')}]);
  const proxy=decodePng(await fs.readFile(path.join(path.dirname(imported.layoutFile),imported.layout.layers[0].image.path)));
  assert.equal(proxy.data[(3*7+0)*4+3],255);
  assert.equal(proxy.data[3],0);
  assert.deepEqual(decodePng(await fs.readFile(imported.meshRestores[0].path)).data,data);
});

test('split hair backs the crown and fades lower ends only over opaque rear hair',async t=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'rig-import-crown-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const folder=path.join(root,'artwork');await fs.mkdir(folder);
  const layers=[],originals=[];
  for(const [id,tags,top,rows] of [
    ['hair-back',['hair','back'],0,[[1,6,180,255],[1,7,180,255]]],
    ['hair-front',['hair','front'],3,[[1,3,100,255],[1,8,100,255]]],
    ['hair-temples',['hair','front','root'],0,[[1,2,200,255],[2,2,220,100],[1,6,200,255],[1,7,200,255],[2,7,200,255]]]
  ]){
    const width=4,height=8,data=Buffer.alloc(width*height*4);
    for(const [x,y,gray,alpha] of rows)data.set([gray,gray,gray,alpha],((y-top)*width+x)*4);
    const raster=encodePng({width,height,data});
    const image={path:id+'.png',width,height};
    originals.push(raster);
    await fs.writeFile(path.join(folder,image.path),raster);
    layers.push({id,tags,rect:{left:3,top,width,height},image});
  }
  const source={layout:{layers,canvas:{width:12,height:12}},parts:layers,layoutFile:path.join(folder,'layout.json')};
  const imported=await prepareRigFaceImport(source,root,path.join(root,'rigging'));
  const p=imported.parts[1],raster=decodePng(await fs.readFile(path.join(root,p.imagePath)));
  const pixel=(x,y)=>[...raster.data.subarray(((y-p.rect.top)*raster.width+x-p.rect.left)*4,((y-p.rect.top)*raster.width+x-p.rect.left)*4+4)];
  assert.deepEqual(pixel(4,2),[200,200,200,255]);
  assert.deepEqual(pixel(4,3),[100,100,100,255]);
  assert.deepEqual(pixel(5,2),[0,0,0,0]);
  assert.deepEqual(pixel(4,7),[0,0,0,0]);
  const temple=imported.meshRestores.find(x=>x.layerId==='hair-temples');
  assert.equal(imported.parts.find(p=>p.id==='hair-temples').sharesFringeJoin,true);
  const lock=decodePng(await fs.readFile(temple.path));
  const lockAlpha=(x,y)=>lock.data[(y*lock.width+x)*4+3];
  assert.equal(lockAlpha(1,2),255);
  assert.equal(lockAlpha(1,6),66);
  assert.equal(lockAlpha(1,7),0);
  assert.equal(lockAlpha(2,7),255);
  const patch=path.join(folder,'front-repair.png');
  const fixed=decodePng(originals[1]);
  fixed.data.set([40,50,60,255],4);
  await fs.writeFile(patch,encodePng(fixed));
  const joined=await prepareRigFaceImport({...source,manifest:{backend:{modelVersion:'anime-source-pixels-1'}}},
    root,path.join(root,'next-rigging'),{mergePortraitFringe:true,replacements:[{layerId:'hair-front',image:patch}]});
  assert.deepEqual(joined.parts.map(part=>part.id),['hair-back','hair-front']);
  assert.deepEqual(joined.composedReplacementIds,['hair-front']);
  const restored=decodePng(await fs.readFile(joined.meshRestores.find(p=>p.layerId==='hair-front').path));
  const joinedPixel=(x,y)=>[...restored.data.subarray((y*restored.width+x)*4,(y*restored.width+x+1)*4)];
  assert.deepEqual(joinedPixel(1,3),[40,50,60,255]);
  assert.deepEqual(joinedPixel(1,2),[200,200,200,255]);
  for(const [i,layer] of layers.entries())assert.deepEqual(await fs.readFile(path.join(folder,layer.image.path)),originals[i]);
});

test('high-pixel eye tracing support follows image-to-document scale without downsampling the artwork',async t=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'rig-import-hd-eye-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const folder=path.join(root,'artwork');await fs.mkdir(folder);
  const data=Buffer.alloc(21*21*4);data[(10*21+10)*4+3]=80;
  await fs.writeFile(path.join(folder,'lash.png'),encodePng({width:21,height:21,data}));
  const p={id:'lash',tags:['eye','lash','left'],image:{path:'lash.png',width:21,height:21},rect:{left:3,top:7,width:7,height:7}};
  const source={layout:{layers:[p],canvas:{width:800,height:800}},parts:[p],layoutFile:path.join(folder,'layout.json')};
  const imported=await prepareRigFaceImport(source,root,path.join(root,'rigging'));
  const proxy=decodePng(await fs.readFile(path.join(path.dirname(imported.layoutFile),imported.layout.layers[0].image.path)));
  assert.equal(proxy.width,21);assert.equal(proxy.height,21);
  assert.equal(proxy.data[(10*21+1)*4+3],255,'3 document units at 3 raster pixels per unit require 9px support');
  assert.deepEqual(decodePng(await fs.readFile(imported.meshRestores[0].path)).data,data);
});

test('nose, hidden closed eyes, clothes, legs and hair retain low-alpha contours through import tracing',async t=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'rig-import-body-edge-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const folder=path.join(root,'artwork');await fs.mkdir(folder);
  const tags=[['nose'],['eye','closed','right'],['body','upper'],['body','lower'],['leg','right'],
    ['hair','front'],['hair','root'],['hair','side','left'],['gesture','wave','rest'],['body','underlay','waist'],['reference']];
  const data=Buffer.alloc(21*21*4);
  for(const [x,y,alpha] of [[10,10,1],[19,2,128],[2,19,255]])data.set([57,119,203,alpha],(y*21+x)*4);
  const layers=[];
  for(const [i,tag] of tags.entries()) {
    const p={id:'part-'+i,tags:tag,image:{path:i+'.png',width:21,height:21},rect:{left:2,top:4,width:7,height:7},
      ...(i===1?{visible:false,variant:{type:'switch',parameter:'ParamEyeROpen'}}:{}),...(i===tags.length-1?{reference:true}:{})};
    layers.push(p);await fs.writeFile(path.join(folder,p.image.path),encodePng({width:21,height:21,data}));
  }
  const originals=await Promise.all(layers.map(p=>fs.readFile(path.join(folder,p.image.path))));
  assert.deepEqual(layers.map(needsMeshTraceSupport),[true,true,true,true,true,true,true,true,true,true,false]);
  assert.equal(needsMeshTraceSupport({...layers[0],reference:true}),false);
  const source={layout:{layers,canvas:{width:800,height:800}},parts:layers,layoutFile:path.join(folder,'layout.json')};
  const imported=await prepareRigFaceImport(source,root,path.join(root,'rigging'));
  assert.deepEqual(imported.meshRestores.map(x=>x.layerId),layers.filter(p=>!p.reference).map(p=>p.id));
  assert.equal(imported.parts,layers);
  for(const [i,p] of imported.layout.layers.entries()) {
    assert.deepEqual(p.rect,layers[i].rect);
    assert.equal(p.visible,layers[i].visible);
    assert.deepEqual(p.variant,layers[i].variant);
    const proxy=decodePng(await fs.readFile(path.join(path.dirname(imported.layoutFile),p.image.path)));
    assert.equal(proxy.width,21);assert.equal(proxy.height,21);
    if(!p.reference) {
      assert.equal(proxy.data[(10*21+1)*4+3],255,'even alpha=1 source pixels receive 9px mesh support');
      assert.equal(proxy.data[(2*21+19)*4+3],255,'disconnected semi-transparent details remain traceable');
      const restore=imported.meshRestores.find(x=>x.layerId===p.id);
      assert.equal(restore.path,path.join(folder,layers[i].image.path));
      assert.deepEqual(decodePng(await fs.readFile(restore.path)).data,data);
      for(let pixel=0;pixel<21*21;pixel++)assert.deepEqual(proxy.data.subarray(pixel*4,pixel*4+3),data.subarray(pixel*4,pixel*4+3));
    } else assert.deepEqual(proxy.data,data);
    assert.deepEqual(await fs.readFile(path.join(folder,layers[i].image.path)),originals[i]);
  }
});
