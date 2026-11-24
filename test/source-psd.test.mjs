import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {encodePng} from '../src/artwork/png.mjs';
import {exportSourcePsd} from '../src/artwork/source-psd.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'source-psd-test-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const pixels=Buffer.from(Array.from({length:6*4*4},(_,i)=>i%4===3?[0,64,128,255][Math.floor(i/4)%4]:(i*47)%256));
  await fs.writeFile(path.join(root,'source.png'),encodePng({width:6,height:4,data:pixels}));
  const image={path:'source.png',width:6,height:4};
  const layout={format:'psd2live-layout',version:1,canvas:{width:10,height:10},groups:[{path:'Face',visible:false,opacity:.75}],layers:[
    {id:'dense',name:'脸部',image,rect:{left:1.1,top:2.2,width:1.5,height:1},group:'Face',visible:true,opacity:.5},
    {id:'hidden',name:'隐藏替换',image,rect:{left:-.3,top:.6,width:3.25,height:2.75},visible:false,opacity:1}
  ]};
  const layoutPath=path.join(root,'layout.json');await fs.writeFile(layoutPath,JSON.stringify(layout));
  return {root,layoutPath,outputPath:path.join(root,'source.psd'),pixels};
}

test('source PSD refuses overwriting an existing source output',async t=>{
  const files=await fixture(t);await fs.writeFile(files.outputPath,'previous source');
  await assert.rejects(exportSourcePsd({...files,runtimeManifest:'unused'}),/SOURCE_PSD_OUTPUT_EXISTS/);
  assert.equal(await fs.readFile(files.outputPath,'utf8'),'previous source');
});

test('source PSD refuses a changed runtime before writing output',async t=>{
  const files=await fixture(t),component=path.join(files.root,'component.jar'),manifest=path.join(files.root,'runtime.json');
  await fs.writeFile(component,'changed');
  await fs.writeFile(manifest,JSON.stringify({runtimeJar:component,runtimeComponents:[{path:component,sha256:'0'.repeat(64)}],compiler:{path:component,sha256:'0'.repeat(64)}}));
  await assert.rejects(exportSourcePsd({...files,runtimeManifest:manifest}),/SOURCE_PSD_RUNTIME_HASH_MISMATCH/);
  await assert.rejects(fs.stat(files.outputPath),{code:'ENOENT'});
});

test('real PSD2Live writer/reader preserves fractional placement, source RGBA, hidden layers and groups',
  {skip:!process.env.SOURCE_PSD_RUNTIME_MANIFEST,timeout:180000},async t=>{
    const files=await fixture(t);
    const result=await exportSourcePsd({...files,runtimeManifest:process.env.SOURCE_PSD_RUNTIME_MANIFEST});
    assert.deepEqual(result.canvas,{width:40,height:40});assert.equal(result.layerCount,2);assert.equal(result.hiddenLayerCount,1);
    const report=JSON.parse(await fs.readFile(result.report.path,'utf8'));
    assert.equal(report.integerCanvasScale,4);assert.equal(report.groupCount,1);
    assert.deepEqual(report.layers.map(r=>[r.name,r.visible,r.bounds]),[
      ['脸部',true,{left:4,top:9,width:6,height:4}],['隐藏替换',false,{left:-1,top:2,width:13,height:11}]
    ]);
    assert.equal(report.groups[0].path,'Face');assert.equal(report.groups[0].visible,false);
    assert.ok(Math.abs(report.groups[0].opacity-.75)<=1/255);
    for(const layer of report.layers) {
      assert.equal(layer.sourceRgbaSha256,hash(files.pixels));assert.equal(layer.sourcePixelsChecked,24);
      assert.equal(layer.sourcePixelsMissingOrChanged,0);assert.equal(layer.maxSourceChannelError,0);assert.equal(layer.rgbaRoundTripExact,true);
    }
    assert.ok(report.maxLogicalRectError<=.501/4);
    const receipt=JSON.parse(await fs.readFile(result.provenance.path,'utf8'));
    assert.equal(receipt.psd.sha256,hash(await fs.readFile(result.psd.path)));assert.equal(receipt.helper.sha256,hash(await fs.readFile(receipt.helper.path)));
    assert.ok(receipt.runtimeComponents.length>0);
  });
