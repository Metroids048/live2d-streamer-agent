import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
import {readInstalledRenderer,stagePath} from './leaf-isolated-assets.mjs';
import {renderCheck} from './leaf-isolated-render.mjs';
import {importInCleanLeaf} from './leaf-isolated-import.mjs';
import {inspectModel} from '../src/packaging/model.mjs';
import {verifyPackageArchive} from '../src/packaging/index.mjs';
import {digest} from '../src/packaging/files.mjs';
import {verifyCoverage} from '../src/packaging/controls.mjs';

const origin='http://leaf-isolated.invalid';
const pageHtml='<html><head><meta charset="utf-8"><style>*{margin:0}#stage{width:360px;height:420px}</style></head><body><div id="stage"></div></body></html>';
const require=createRequire(import.meta.url);
function browserLibrary(){
  try { return require('playwright'); }
  catch { return require(process.env.LEAF_PROBE_PLAYWRIGHT ?? path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
}

export function packageControls(manifest) {
  const {expressions,motions}=manifest;
  verifyCoverage(manifest.requirementCoverage?.requested,expressions,motions);
  const motion=motions.find(item=>item.id==='dyn_wave');
  if(!motion?.leafId || expressions.some(row=>!row.leafId)) throw Error('运行包缺少必需的控制索引');
  return {
    expressions:expressions.map(({id,name,leafId,exclusiveGroup})=>
      ({id,name,leafId,kind:exclusiveGroup==='emotion'?'emotion':'appearance'})),
    motion
  };
}

export async function probe(options){
  if(!options.output || !!options.package===!!options['technical-model']) throw Error('指定 --package ZIP --sha256 HEX 或 --technical-model MODEL，并指定新的 --output DIR');
  const temp=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'leaf-render-')));
  let browser;
  try {
    let entry, controls, sources, native;
    if(options.package) {
      const file=await fs.realpath(options.package), zip=await digest(file);
      if(!options.sha256 || options.sha256!==zip.sha256) throw Error('下载 ZIP 与已登记 SHA256 不符');
      const extracted=path.join(temp,'extracted');
      native=await verifyPackageArchive(file,zip,extracted);
      const manifest=JSON.parse(await fs.readFile(path.join(extracted,'manifest.json')));
      if(!manifest.modelPath) throw Error('需要含运行模型的完整包或运行包');
      const loaded=await importInCleanLeaf(file,path.join(temp,'leaf-library'));
      entry=loaded.entry;
      const sourceModel=path.dirname(path.join(extracted,manifest.modelPath));
      if(path.basename(entry)!==path.basename(manifest.modelPath))throw Error('Leaf 导入了另一个入口');
      for(const rel of loaded.resources) {
        if((await digest(path.join(sourceModel,rel))).sha256!==(await digest(path.join(path.dirname(entry),rel))).sha256)
          throw Error('隔离 Leaf 导入后的资源与下载副本不一致');
      }
      controls=packageControls(manifest);
      sources={mode:'verified-zip',chatDownload:'not_observed_by_probe',identity:native.identity,zip,
        isolatedImport:{implementation:loaded.implementation,verifiedFiles:loaded.resources.length}};
    } else {
      entry=await fs.realpath(options['technical-model']);
      const parseControl=(id,kind)=>({id,leafId:id,kind});
      const selected=options.emotion??[];
      if(!options['turn-only'] && (!selected.length || !options.motion)) throw Error('技术示例需指定 --emotion Leaf索引（可多次）和 --motion 组:序号');
      controls={expressions:[...selected.map(id=>parseControl(id,'emotion')),...(options.appearance??[]).map(id=>parseControl(id,'appearance'))],motion:{leafId:options.motion}};
      sources={mode:'technical-input',input:path.basename(entry),appearance:options.appearance?.length?'requested':'not_tested'};
    }
    const dir=path.dirname(entry), name=path.basename(entry), model=await inspectModel(dir,name);
    for(const control of controls.expressions) {
      const indexed=model.expressions.find(e=>e.leafId===control.leafId);
      if(!indexed) throw Error('无法定位模型表情 '+control.leafId);
      control.name=indexed.name;
    }
    const approved=new Map(model.files.map(f=>[f,path.join(dir,f)]));
    const modelFiles=await Promise.all(model.files.map(async file=>({file,...await digest(approved.get(file))})));
    const {files,hashes}=await readInstalledRenderer();
    browser=await browserLibrary().chromium.launch({executablePath:process.env.LEAF_PROBE_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-background-networking']});
    const ctx=await browser.newContext({viewport:{width:360,height:420},serviceWorkers:'block',permissions:[]});
    await ctx.route('**/*',async route=>{
      const req=route.request(), url=new URL(req.url());
      if(req.method()!=='GET' || url.origin!==origin) return route.abort();
      if(url.pathname==='/') return route.fulfill({contentType:'text/html',body:pageHtml});
      if(files.has(url.pathname)) return route.fulfill({contentType:'text/javascript',body:files.get(url.pathname)});
      if(url.pathname.startsWith('/model-file/')) {
        const key=decodeURIComponent(url.pathname.slice('/model-file/'.length));
        if(approved.has(key)) return route.fulfill({contentType:'application/octet-stream',body:await fs.readFile(approved.get(key))});
      }
      return route.abort();
    });
    const page=await ctx.newPage(); await page.goto(origin);
    const result=await page.evaluate(renderCheck,{stagePath,turnOnly:!!options['technical-model'] && !!options['turn-only'],turnInput:options['technical-model']?options['turn-input']:undefined,drawables:options['technical-model']?options.drawable:[],
      eyeSweep:!!options['eye-sweep'],info:{id:'isolated',name:'isolated',path:name,entry:name,files:model.files},controls});
    const {contactSheet,poseFrames,...data}=result;
    const output=path.resolve(options.output);
    const proof={source:sources,engineAssets:hashes,modelFiles,cleanArchive:native??null,
      checks:{...Object.fromEntries(['controlsObserved','motionReturned','restored'].map(k=>[k,data[k]])),desktopImport:'not_run',liveTracking:'not_run'},
      ...data};
    await fs.mkdir(output); await fs.writeFile(path.join(output,'frames.png'),Buffer.from(contactSheet,'base64'));
    for(const [name,png] of Object.entries(poseFrames??{})) await fs.writeFile(path.join(output,name+'.png'),Buffer.from(png,'base64'));
    await fs.writeFile(path.join(output,'result.json'),JSON.stringify(proof,null,2)+'\n');
    return proof;
  } finally {
    try {await browser?.close();} finally {await fs.rm(temp,{recursive:true,force:true});}
  }
}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href){
  const strings=['package','sha256','technical-model','motion','output','turn-input'];
  const {values}=parseArgs({options:{...Object.fromEntries(strings.map(k=>[k,{type:'string'}])),
    emotion:{type:'string',multiple:true},appearance:{type:'string',multiple:true},
    drawable:{type:'string',multiple:true},'eye-sweep':{type:'boolean'},'turn-only':{type:'boolean'}}});
  const proof=await probe(values); console.log(JSON.stringify({...proof.checks,...(proof.turnCheck?{turn:proof.turnCheck.passed}:{})}));
  if(proof.turnCheck ? !proof.turnCheck.passed : (!proof.controlsObserved || !proof.motionReturned || !proof.restored)) process.exitCode=2;
}
