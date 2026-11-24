import test from 'node:test';
import assert from 'node:assert/strict';
import {halfBlinkMaterials} from '../src/artwork/blink-contour.mjs';
import {composite} from '../src/artwork/png.mjs';

test('half blink follows the observed closed arc: canthi stay pinned and only visible sclera remains',()=>{
  const layer=(tags,color,mark)=>{
    const width=9,height=9,data=Buffer.alloc(width*height*4);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(mark(x,y))data.set([...color,255],(y*width+x)*4);
    return {image:{data,width,height},rect:{left:0,top:0,width,height},tags:['eye',...tags,'left'],visible:!tags.includes('closed')};
  };
  const parts=[layer(['white'],[255,255,255],(x,y)=>y>=2&&y<=7),layer(['lash','upper'],[0,0,0],(x,y)=>y===2),
    layer(['closed'],[0,0,0],(x,y)=>y===2+Math.min(x,8-x)),layer(['rim'],[200,110,110],(x,y)=>y===0),
    layer(['fold'],[75,35,25],(x,y)=>x===4&&y===1)];
  const frame=composite({width:9,height:9},halfBlinkMaterials(parts));
  const at=(x,y)=>[...frame.data.subarray((9*y+x)*4,(9*y+x)*4+4)];
  assert.deepEqual(at(4,0),[200,110,110,77]);assert.deepEqual(at(0,2),[0,0,0,255]);assert.deepEqual(at(4,4),[0,0,0,255]);
  assert.equal(at(4,2)[3],0);assert.deepEqual(at(0,3),[255,255,255,255]);
  const portrait=composite({width:9,height:9},halfBlinkMaterials(parts,{portrait:true}));
  assert.equal(at(4,1)[3],31);
  assert.equal(portrait.data[(9+4)*4+3],0,'the separate open-eye fold has disappeared by half closure');
});
