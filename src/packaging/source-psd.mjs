import * as fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {exportSourcePsd} from '../artwork/source-psd.mjs';
import {artifact,json,regular,relativePath,reject,writeJson} from './files.mjs';
import {archive} from './archive.mjs';

const keys=['taskId','candidateId','revision','parentRevision','inputSha256','descriptionSha256'];
const identity=bundle=>Object.fromEntries(keys.map(k=>[k,bundle[k]]));
const same=(a,b)=>keys.every(k=>a[k]===b[k]);
const projectRoot=fileURLToPath(new URL('../../',import.meta.url));
const paths={sourcePsdPath:'editable/source/source.psd',sourcePsdReadbackPath:'editable/source/readback.json',sourcePsdProvenancePath:'editable/source/provenance.json'};
const publicTool=record=>({name:path.basename(record.path),sha256:record.sha256,bytes:record.bytes});
const validRecord=record=>record&&/^[a-f0-9]{64}$/.test(record.sha256)&&Number.isSafeInteger(record.bytes)&&record.bytes>0;

// Packaging owns this offline conversion. It never opens or replays an editor project.
export async function packageSourcePsd(root,dynamics,items,content,ctx) {
  const artworkStage=await artifact(root,'artwork/stage.json');
  const artwork=await json(root,'artwork/stage.json');
  if(artwork.schemaVersion!==1||artwork.stage!=='artwork'||artwork.status!=='completed'||!same(artwork,dynamics)||
    artwork.unresolved?.length||!Array.isArray(artwork.artifacts)||!Array.isArray(artwork.checks)||
    artwork.checks.some(c=>['failed','blocked'].includes(c.status))||artwork.layoutPath!==dynamics.layoutPath||artwork.artworkManifestPath!==dynamics.artworkManifestPath)
    reject('REFERENCE_INVALID','高清源PSD需要同版已完成Artwork和完整身份绑定');
  const sourceItems=new Map();
  for(const expected of artwork.artifacts) {
    const actual=await artifact(root,expected.path,expected.role),upstream=items.get(expected.path);
    if(sourceItems.has(expected.path)||actual.sha256!==expected.sha256||actual.bytes!==expected.bytes||
      upstream?.sha256!==expected.sha256||upstream?.bytes!==expected.bytes)reject('REFERENCE_INVALID','Artwork源图与动态候选哈希不符');
    sourceItems.set(expected.path,actual);
  }
  const required=relative=>{relativePath(relative);const record=sourceItems.get(relative);if(!record)reject('REFERENCE_INVALID','源PSD缺少已绑定源文件：'+relative);return record;};
  const layoutRecord=required(artwork.layoutPath),manifestRecord=required(artwork.artworkManifestPath);
  const manifest=await json(root,artwork.artworkManifestPath);
  if(!same(manifest,dynamics))reject('REFERENCE_INVALID','Artwork清单身份不符');
  const layout=await json(root,artwork.layoutPath);
  if(!Array.isArray(layout.layers)||!layout.layers.length)reject('REFERENCE_INVALID','源PSD缺少实际Layout图层');
  const layers=layout.layers.map(layer=>{
    relativePath(layer.image?.path);
    return {id:layer.id,rect:layer.rect,...required(path.posix.join(path.posix.dirname(artwork.layoutPath),layer.image.path))};
  });
  let runtimeManifest=ctx.sourcePsdRuntimeManifest;
  if(!runtimeManifest) {
    const owner=path.resolve(ctx.root??projectRoot),config=await json(owner,'config/psd2live-runtime.json');
    runtimeManifest=await regular(owner,config.manifest);
    if((await artifact(owner,config.manifest)).sha256!==config.manifestSha256)reject('REFERENCE_INVALID','高清源PSD运行清单已改变');
  }
  const work=path.join(path.dirname(content),'source-psd-work');
  await fs.mkdir(work); // Never silently reuse an old output with the same name.
  try {
    const convert=ctx.sourcePsdExporter??exportSourcePsd;
    const exported=await convert({layoutPath:await regular(root,artwork.layoutPath),outputPath:path.join(work,'source.psd'),runtimeManifest,signal:ctx.signal});
    const readback=JSON.parse(await fs.readFile(exported.report.path,'utf8'));
    const receipt=JSON.parse(await fs.readFile(exported.provenance.path,'utf8'));
    if(readback.status!=='passed'||readback.sourceLayoutSha256!==layoutRecord.sha256||readback.layers?.length!==layers.length)
      reject('REFERENCE_INVALID','高清源PSD读回未绑定本版Layout');
    for(const [i,row] of readback.layers.entries())if(row.id!==layers[i].id)reject('REFERENCE_INVALID','高清源PSD图层ID顺序不符');
    await fs.mkdir(path.join(content,'editable/source'),{recursive:true});
    await fs.copyFile(exported.psd.path,path.join(content,paths.sourcePsdPath),fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);
    const psd=await artifact(content,paths.sourcePsdPath,'source_psd');
    if(psd.sha256!==readback.psdSha256||psd.sha256!==exported.psd.sha256||psd.bytes!==exported.psd.bytes)
      reject('REFERENCE_INVALID','高清源PSD复制哈希不符');
    await writeJson(path.join(content,paths.sourcePsdReadbackPath),{...readback,...identity(dynamics),sourceLayout:artwork.layoutPath,psd:paths.sourcePsdPath});
    const proof=await artifact(content,paths.sourcePsdReadbackPath,'source_psd_readback');
    const layoutRoot=path.posix.dirname(artwork.layoutPath),editableLayoutRoot='editable/source/layout';
    const copySource=async(record,relative)=>{
      relativePath(relative);
      const dest=path.posix.join(editableLayoutRoot,relative);
      await fs.mkdir(path.dirname(path.join(content,dest)),{recursive:true});
      await fs.copyFile(await regular(root,record.path),path.join(content,dest),fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);
      const copy=await artifact(content,dest);
      if(copy.sha256!==record.sha256||copy.bytes!==record.bytes)reject('REFERENCE_INVALID','编辑源图层复制哈希不符');
      return copy;
    };
    const editableLayout=await copySource(layoutRecord,path.posix.basename(artwork.layoutPath)),editableLayers=[];
    for(const record of new Map(layers.map(record=>[record.path,record])).values())
      editableLayers.push(await copySource(record,path.posix.relative(layoutRoot,record.path)));
    const provenance={schemaVersion:1,kind:'source-psd-provenance',...identity(dynamics),
      source:{artworkStage,manifest:manifestRecord,layout:layoutRecord,
        layers:layers.map((row,i)=>({...row,rgbaSha256:readback.layers[i].sourceRgbaSha256,width:readback.layers[i].sourceWidth,height:readback.layers[i].sourceHeight}))},
      conversion:{implementation:'PSD2Live 3.6.7 LayoutManifest/PsdWriter/PsdReader',runtimeManifest:publicTool(receipt.runtimeManifest),
        runtimeComponents:receipt.runtimeComponents.map(publicTool),compiler:publicTool(receipt.compiler),java:publicTool(receipt.java),
        helper:publicTool(receipt.helper),compiledTool:publicTool(receipt.compiledTool)},psd,readback:proof,
      editableLayout,editableLayers,limitations:readback.limitations};
    await writeJson(path.join(content,paths.sourcePsdProvenancePath),provenance);
    // Conversion must not race a source revision update.
    for(const expected of [...sourceItems.values(),provenance.source.artworkStage]) {
      const actual=await artifact(root,expected.path);if(actual.sha256!==expected.sha256||actual.bytes!==expected.bytes)reject('REFERENCE_INVALID','高清源PSD转换期间源文件已改变');
    }
    return {...paths,sourcePsdContract:1,sourceLayoutPath:editableLayout.path};
  } finally {await fs.rm(work,{recursive:true,force:true});}
}

export async function verifySourcePsd(root,manifest,files) {
  if(manifest.sourcePsdContract!==1)reject('REFERENCE_INVALID','缺少高清源PSD包装契约');
  for(const key of Object.keys(paths))if(!files.has(relativePath(manifest[key])))reject('REFERENCE_INVALID','高清源PSD产物未登记');
  if(manifest.sourcePsdPath===manifest.psdPath)reject('REFERENCE_INVALID','高清源PSD与引擎原生PSD必须分别保留');
  const report=await json(root,manifest.sourcePsdReadbackPath),provenance=await json(root,manifest.sourcePsdProvenancePath);
  const psd=files.get(manifest.sourcePsdPath),proof=files.get(manifest.sourcePsdReadbackPath);
  if(report.schemaVersion!==1||report.status!=='passed'||!same(report,manifest)||!same(provenance,manifest)||
    provenance.kind!=='source-psd-provenance'||provenance.schemaVersion!==1||!validRecord(provenance.source?.artworkStage)||
    !validRecord(provenance.source?.manifest)||!validRecord(provenance.source?.layout)||
    report.sourceLayout!==provenance.source.layout.path||report.sourceLayoutSha256!==provenance.source.layout.sha256||
    report.psd!==manifest.sourcePsdPath||report.psdSha256!==psd.sha256||report.psdBytes!==psd.bytes||
    provenance.psd?.path!==psd.path||provenance.psd?.sha256!==psd.sha256||provenance.psd?.bytes!==psd.bytes||
    provenance.readback?.path!==proof.path||provenance.readback?.sha256!==proof.sha256||provenance.readback?.bytes!==proof.bytes)
    reject('REFERENCE_INVALID','高清源PSD身份、源Layout或读回哈希不符');
  const scale=report.integerCanvasScale,layers=report.layers,source=provenance.source.layers,conversion=provenance.conversion;
  if(!conversion||![conversion.runtimeManifest,conversion.compiler,conversion.java,conversion.helper,conversion.compiledTool].every(validRecord)||
    !Array.isArray(conversion.runtimeComponents)||!conversion.runtimeComponents.length||!conversion.runtimeComponents.every(validRecord))reject('REFERENCE_INVALID','高清源PSD缺少成熟工具来源哈希');
  if(!Number.isSafeInteger(scale)||scale<1||!Array.isArray(layers)||!layers.length||layers.length!==report.layerCount||!Array.isArray(source)||source.length!==layers.length||
    !Number.isFinite(report.maxLogicalRectError)||report.maxLogicalRectError>.501/scale)reject('REFERENCE_INVALID','高清源PSD比例或布局读回不符');
  for(const [i,row] of layers.entries())if(row.id!==source[i]?.id||!validRecord(source[i])||row.sourceRgbaSha256!==source[i].rgbaSha256||
    !/^[a-f0-9]{64}$/.test(row.sourceRgbaSha256)||row.sourceWidth!==source[i].width||row.sourceHeight!==source[i].height||
    ![row.sourceWidth,row.sourceHeight].every(n=>Number.isSafeInteger(n)&&n>0)||
    row.sourcePixelsChecked!==row.sourceWidth*row.sourceHeight||row.sourcePixelsMissingOrChanged!==0||row.maxSourceChannelError!==0||row.rgbaRoundTripExact!==true||
    !['left','top','width','height'].every(k=>Number.isSafeInteger(row.bounds?.[k])&&Number.isFinite(source[i].rect?.[k])&&Math.abs(row.bounds[k]/scale-source[i].rect[k])<=.502/scale)||
    row.bounds.width<row.sourceWidth||row.bounds.height<row.sourceHeight||!Number.isFinite(row.maxLogicalRectError)||row.maxLogicalRectError>.501/scale)
    reject('REFERENCE_INVALID','高清源PSD存在源像素丢失或未验证图层');
  if(manifest.sourceLayoutPath!==undefined||provenance.editableLayout!==undefined) {
    const layoutPath=relativePath(manifest.sourceLayoutPath);
    const records=new Map((provenance.editableLayers??[]).map(record=>[record.path,record]));
    const matches=(actual,expected)=>actual&&expected&&actual.sha256===expected.sha256&&actual.bytes===expected.bytes;
    if(layoutPath!==provenance.editableLayout?.path||!matches(files.get(layoutPath),provenance.editableLayout)||
      !matches(provenance.editableLayout,provenance.source.layout)||!layoutPath.startsWith('editable/source/layout/'))
      reject('REFERENCE_INVALID','编辑布局缺失或与原版哈希不符');
    const layout=await json(root,layoutPath);
    if(!Array.isArray(layout.layers)||layout.layers.length!==source.length)reject('REFERENCE_INVALID','编辑布局图层数量不符');
    for(const [i,layer] of layout.layers.entries()) {
      const dest=path.posix.join(path.posix.dirname(layoutPath),relativePath(layer.image?.path));
      if(layer.id!==source[i].id||!matches(records.get(dest),source[i])||!matches(files.get(dest),source[i]))
        reject('REFERENCE_INVALID','编辑布局图层缺失或与源文件不符');
    }
  }
  const bytes=await fs.readFile(await regular(root,manifest.sourcePsdPath));
  const inspected=await archive({action:'psd',file:await regular(root,manifest.sourcePsdPath)});
  const width=bytes.readUInt32BE(18),height=bytes.readUInt32BE(14);
  if(width!==report.psdCanvas?.width||height!==report.psdCanvas?.height||width!==report.logicalCanvas?.width*scale||height!==report.logicalCanvas?.height*scale||
    inspected.rasterLayerCount!==report.layerCount)reject('REFERENCE_INVALID','高清源PSD实际画布或图层数不符');
  return {status:'passed',width,height,layerCount:layers.length,sourcePixelsChecked:layers.reduce((n,row)=>n+row.sourcePixelsChecked,0),sourcePixelsMissingOrChanged:0,scope:'source fidelity only; not Artwork/rig/runtime acceptance'};
}
