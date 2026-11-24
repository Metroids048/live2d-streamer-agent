import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {materializeFlash} from '../src/artwork/materialize.mjs';
import {decodePng,encodePng,composite} from '../src/artwork/png.mjs';

test('a raised sleeve retains the source neckline and separates its sloping cuff from the sash and skirt ink',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'wave-cap-test-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await fs.mkdir(path.join(dir,'artwork'));
  const sourcePath=path.resolve('evidence/single-image-live2d/00/hachi-front.png');
  const fixture=path.resolve('evidence/single-image-live2d/02/hachi-native-material-development');
  const record=JSON.parse(await fs.readFile(path.join(fixture,'provenance.json')));
  const source=decodePng(await fs.readFile(sourcePath));
  const base=record.parts.find(p=>p.id==='generated-raised-arm');
  const image=decodePng(await fs.readFile(path.join(fixture,base.file)));
  const wave=composite(source,[{image,rect:base.rect}]);
  // Simulate the provider redrawing a different neckline on the attachment.
  // Registration must restore the source without changing the actual hand.
  for(let y=190;y<=196;y++)for(let x=427;x<=434;x++){
    const offset=4*(y*wave.width+x);
    if(wave.data[offset+3]>200)wave.data.set([112,54,155],offset);
  }
  const result=await materializeFlash({parts:[{id:'wave',providerLabel:'gesture:wave:raised',png:encodePng(wave)}]},
      {sourcePath,taskRoot:dir,brief:{imageObservation:{materialRegions:record.regions}}});
  const part=key=>result.parts.find(p=>p.tags.join(':')==='gesture:wave:'+key);
  const raised=part('raised'),rest=part('rest');
  assert.ok(raised&&!raised.reference&&!raised.visible&&rest?.visible);
  const full=p=>composite(source,[{image:decodePng(p.png),rect:p.rect}]);
  const up=full(raised),down=full(rest);
  const pixel=(im,x,y)=>Array.from(im.data.subarray(4*(y*im.width+x),4*(y*im.width+x+1)));
  assert.deepEqual(pixel(up,428,192),pixel(source,428,192));
  assert.equal(pixel(down,439,241)[3],255); // detached inner cuff
  assert.equal(pixel(down,466,315)[3],0);   // keeps the original outline with the skirt
  assert.equal(pixel(down,467,315)[3],255); // removes the adjacent resting skin
  const cleared={...source,data:Buffer.from(source.data)};
  for(let i=3;i<down.data.length;i+=4)if(down.data[i])cleared.data[i]=0;
  const rect={left:0,top:0,width:source.width,height:source.height};
  const restored=composite(source,[{rect,image:cleared},{image:decodePng(rest.png),rect:rest.rect}]);
  assert.deepEqual(restored.data,composite(source,[{rect,image:source}]).data);
});
