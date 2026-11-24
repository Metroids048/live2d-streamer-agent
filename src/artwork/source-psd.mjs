import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {decodePng} from './png.mjs';

const exec=promisify(execFile),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const projectRoot=fileURLToPath(new URL('../../',import.meta.url));
const helper=fileURLToPath(new URL('../../scripts/source-psd/SourcePsd.kt',import.meta.url));
const exists=async file=>{try{await fs.lstat(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
async function record(file) {
  const absolute=await fs.realpath(file),bytes=await fs.readFile(absolute);
  return {path:absolute,bytes:bytes.length,sha256:hash(bytes)};
}

// Detached source-file conversion. Never connects to an editor or changes a production stage.
export async function exportSourcePsd({layoutPath,outputPath,runtimeManifest,reportPath,javaPath,signal}) {
  layoutPath=await fs.realpath(layoutPath);outputPath=path.resolve(outputPath);
  reportPath=path.resolve(reportPath??outputPath.replace(/\.psd$/i,'')+'.readback.json');
  const receiptPath=outputPath+'.provenance.json';
  if(!/\.psd$/i.test(outputPath)||new Set([layoutPath,outputPath,reportPath,receiptPath]).size!==4)throw new Error('SOURCE_PSD_PATHS_INVALID');
  for(const file of [outputPath,reportPath,receiptPath])if(await exists(file))throw new Error('SOURCE_PSD_OUTPUT_EXISTS: '+file);
  const input=JSON.parse(await fs.readFile(layoutPath,'utf8')),base=path.dirname(layoutPath);
  if(input.format!=='psd2live-layout'||input.version!==1||!Array.isArray(input.layers)||!input.layers.length)throw new Error('SOURCE_PSD_LAYOUT_INVALID');
  const inputs=[await record(layoutPath)],sourcePixels=[];
  for(const layer of input.layers) {
    const relative=layer.image?.path;
    if(typeof relative!=='string'||path.isAbsolute(relative)||relative.includes('\\')||relative.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error('SOURCE_PSD_IMAGE_PATH_INVALID');
    const file=await fs.realpath(path.join(base,relative));
    if(!file.startsWith(base+path.sep))throw new Error('SOURCE_PSD_IMAGE_OUTSIDE_LAYOUT');
    if(!inputs.some(r=>r.path===file))inputs.push(await record(file));
    const image=decodePng(await fs.readFile(file));
    if(image.width!==layer.image.width||image.height!==layer.image.height)throw new Error('SOURCE_PSD_IMAGE_DIMENSIONS_MISMATCH');
    sourcePixels.push({width:image.width,height:image.height,rgbaSha256:hash(image.data)});
  }
  runtimeManifest=await fs.realpath(runtimeManifest);
  const runtime=JSON.parse(await fs.readFile(runtimeManifest,'utf8'));
  if(!Array.isArray(runtime.runtimeComponents)||!runtime.runtimeComponents.length||!runtime.compiler?.path||
    runtime.runtimeComponents[0].path!==runtime.runtimeJar)throw new Error('SOURCE_PSD_RUNTIME_MANIFEST_INVALID');
  const components=[];
  for(const expected of [...runtime.runtimeComponents,runtime.compiler]) {
    const actual=await record(expected.path);
    if(actual.sha256!==expected.sha256)throw new Error('SOURCE_PSD_RUNTIME_HASH_MISMATCH: '+expected.path);
    components.push(actual);
  }
  javaPath=await fs.realpath(javaPath??(await fs.readFile(path.join(projectRoot,'.local/tools/psd2live/build/run/java'),'utf8')).trim());
  const helperRecord=await record(helper),javaRecord=await record(javaPath),runtimeRecord=await record(runtimeManifest);
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'source-psd-'));
  try {
    const jar=path.join(directory,'source-psd.jar'),classpath=components.slice(0,-1).map(r=>r.path).join(path.delimiter);
    await exec(javaPath,['-cp',runtime.compiler.path+path.delimiter+classpath,'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler',
      '-jvm-target','21','-no-stdlib','-no-reflect','-Xfriend-paths='+runtime.runtimeJar,'-classpath',classpath,'-d',jar,helper],
      {timeout:120000,maxBuffer:65536,signal});
    await exec(javaPath,['-Djava.awt.headless=true','-Xmx2500m','-cp',jar+path.delimiter+classpath,
      'io.github.psd2live.application.SourcePsdKt',layoutPath,outputPath,reportPath],{timeout:180000,maxBuffer:65536,signal});
    for(const expected of inputs)if((await record(expected.path)).sha256!==expected.sha256)throw new Error('SOURCE_PSD_INPUT_CHANGED: '+expected.path);
    const readback=JSON.parse(await fs.readFile(reportPath,'utf8')),psd=await record(outputPath);
    if(readback.status!=='passed'||readback.sourceLayoutSha256!==inputs[0].sha256||readback.psdSha256!==psd.sha256||
      readback.layerCount!==input.layers.length||!readback.layers.every((r,i)=>r.rgbaRoundTripExact&&r.sourcePixelsMissingOrChanged===0&&r.maxSourceChannelError===0&&
        r.sourceWidth===sourcePixels[i].width&&r.sourceHeight===sourcePixels[i].height&&r.sourceRgbaSha256===sourcePixels[i].rgbaSha256))throw new Error('SOURCE_PSD_READBACK_INVALID');
    const tool=await record(jar),toolPath=path.join(path.dirname(outputPath),'source-psd-tool-'+tool.sha256.slice(0,16)+'.jar');
    if(await exists(toolPath)) {
      if((await record(toolPath)).sha256!==tool.sha256)throw new Error('SOURCE_PSD_TOOL_HASH_MISMATCH');
    } else await fs.copyFile(jar,toolPath,fs.constants.COPYFILE_EXCL);
    const receipt={schemaVersion:1,scope:'source PSD conversion/readback only',createdAt:new Date().toISOString(),
      inputs,runtimeManifest:runtimeRecord,runtimeComponents:components.slice(0,-1),compiler:components.at(-1),java:javaRecord,
      helper:helperRecord,compiledTool:await record(toolPath),psd,readback:await record(reportPath)};
    await fs.writeFile(receiptPath,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
    return {status:'passed',psd,report:receipt.readback,provenance:await record(receiptPath),canvas:readback.psdCanvas,
      layerCount:readback.layerCount,hiddenLayerCount:readback.hiddenLayerCount};
  } finally {await fs.rm(directory,{recursive:true,force:true});}
}
