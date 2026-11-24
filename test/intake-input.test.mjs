import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {prepareInput,BRIEF_SCHEMA,validateBrief} from '../src/intake/index.mjs';
import {finalizeBrief} from '../src/intake/brief.mjs';

const exec=promisify(execFile),project=fileURLToPath(new URL('../',import.meta.url));
const evidence=path.join(project,'evidence/single-image-live2d/01');
const sha=b=>createHash('sha256').update(b).digest('hex');
const rights={source:'测试人员自己绘制的几何 fixture，非角色主案例',license:'允许本地测试、修改；不公开再分发',allowDerivatives:true,allowRedistribution:false,userDeclared:true};
const description='用这张图做一个直播模型，保留人物特征。';
const attr=fields=>({...fields,source:'default',quote:''});

// Only the resolver and semantic vision are mocks. Pillow decodes real files.
function vision(request,overrides={}) {
  const response={schemaVersion:1,inputSha256:request.inputSha256,descriptionSha256:request.descriptionSha256,originalDescription:request.description,
    imageObservation:{framing:'full_body',characterCount:1,appearance:[{feature:'shape',observation:'test-only colored rectangle'}],visibleParts:['fixture_shape'],occludedParts:[],uncertainties:['几何图只用于解码与合同测试，不是角色视觉验收。']},
    intent:{framing:attr({value:'preserve_source'}),preserve:[{feature:'shape',detail:'test-only colored rectangle',source:'image',quote:''}],appearanceChanges:[],headMotion:attr({yawDegrees:15,pitchDegrees:10,rollDegrees:10}),eyes:attr({blink:true,gaze:true}),mouth:attr({speech:true,closeOnSilence:true,shapes:[]}),expressions:[],actions:[],clothingVariants:[],targetRuntimes:[],deliverables:[]},inferences:[],unresolved:[],unsupported:[]};
  return Object.assign(response,overrides);
}
test('a requested surprised expression uses the native surprise binding ID without losing its original quote',()=>{
  const raw=vision({description:'要微笑、惊讶和害羞'});
  raw.intent.expressions=[
    {id:'smile',label:'微笑',source:'user',quote:'微笑'},
    {id:'surprised',label:'惊讶',source:'user',quote:'惊讶'},
    {id:'shy',label:'害羞',source:'user',quote:'害羞'},
  ];
  const {brief}=finalizeBrief(raw);
  assert.deepEqual(brief.intent.expressions,[raw.intent.expressions[0],{...raw.intent.expressions[1],id:'surprise'},raw.intent.expressions[2]]);
  assert.equal(raw.intent.expressions[1].id,'surprised');
  assert.equal(brief.originalDescription,raw.originalDescription);
});
test('the preset library request is not a bespoke gesture or expression',()=>{
  const quote='常用动作和表情',raw=vision({description:'请加挥手、微笑和常用动作和表情'});
  const wave={id:'wave',label:'挥手',source:'user',quote:'挥手'};
  const smile={id:'smile',label:'微笑',source:'user',quote:'微笑'};
  raw.intent.actions=[wave,{id:'common_action_presets',label:'常用动作',source:'user',quote}];
  raw.intent.expressions=[smile,{id:'common_expression_presets',label:'常用表情',source:'user',quote}];
  const {brief}=finalizeBrief(raw,{streamerPresets:true});
  assert.deepEqual(brief.intent.actions.map(x=>x.id),['wave','reset']);
  assert.deepEqual(brief.intent.expressions.map(x=>x.id),['smile','angry','surprise']);
  assert.deepEqual(brief.presetLibraryRequests.map(x=>[x.group,x.quote]),[['actions',quote],['expressions',quote]]);
  assert.equal(raw.intent.actions.length,2);
});
async function setup(t) {
  await fs.mkdir(evidence,{recursive:true});
  const dir=await fs.mkdtemp(path.join(evidence,'test-temp-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const fixtures=path.join(dir,'fixtures');await fs.mkdir(fixtures);
  await exec('/usr/bin/python3',['-c',String.raw`
from PIL import Image, ImageCms
import os, sys, struct, zlib
d=sys.argv[1]
im=Image.new('RGBA',(40,64),(70,120,160,0))
for y in range(8,56):
 for x in range(8,32): im.putpixel((x,y),(90,160,200,190))
im.save(os.path.join(d,'transparent.png'))
exif=Image.Exif(); exif[274]=6; exif[270]='private fixture metadata'
profile=ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes()
im.save(os.path.join(d,'alpha-icc.png'),icc_profile=profile)
Image.new('RGB',(40,24),(130,100,60)).save(os.path.join(d,'rotated.jpg'),exif=exif,icc_profile=profile)
Image.new('CMYK',(12,12),(10,20,30,40)).save(os.path.join(d,'unprofiled.jpg'))
def chunk(tag,data): return struct.pack('>I',len(data))+tag+data+struct.pack('>I',zlib.crc32(tag+data)&0xffffffff)
header=struct.pack('>IIBBBBB',9000,1,8,2,0,0,0)
open(os.path.join(d,'huge.png'),'wb').write(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',header)+chunk(b'IDAT',zlib.compress(b'\0'+b'\0'*27000))+chunk(b'IEND',b''))
rgb16_header=struct.pack('>IIBBBBB',1,1,16,2,0,0,0)
open(os.path.join(d,'rgb16.png'),'wb').write(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',rgb16_header)+chunk(b'IDAT',zlib.compress(b'\0\xff\xff\0\0\0\0'))+chunk(b'IEND',b''))
`,fixtures]);
  const taskRoot=path.join(dir,'task');await fs.mkdir(path.join(taskRoot,'input'),{recursive:true});
  const request={imageRef:'fixture-image-1',description,rights:structuredClone(rights)};
  let visualCalls=0,resolverCalls=0;
  const ctx={root:dir,taskRoot,taskId:'fixture-task',candidateId:'fixture-candidate',revision:'r01',parentRevision:null,
    resolveImage:async(ref,identity)=>{
      resolverCalls++;assert.equal(ref,request.imageRef);assert.equal(identity.taskRoot,taskRoot);assert.equal(identity.taskId,'fixture-task');
      const target=path.join(taskRoot,'input/source.png');
      try {await fs.copyFile(path.join(fixtures,'transparent.png'),target,fs.constants.COPYFILE_EXCL);} catch(e) {if(e.code!=='EEXIST') throw e;}
      return {path:target,mimeType:'image/png',source:'test_fixture'};
    },
    describeImage:async r=>{visualCalls++;assert.deepEqual(r.outputSchema,BRIEF_SCHEMA);assert.equal(path.isAbsolute(r.image.path),true);return vision(r);},
  };
  return {dir,fixtures,taskRoot,request,ctx,counts:()=>({visualCalls,resolverCalls})};
}
async function fixtureResolver(s,name,mimeType) {
  const target=path.join(s.taskRoot,'input',name);await fs.copyFile(path.join(s.fixtures,name),target);
  s.ctx.resolveImage=async()=>({path:target,mimeType,source:'test_fixture'});return target;
}

test('a quoted reversible control reconstructs only its anchored material and never accepts a design for the user',()=>{
  const words='抬手打招呼，摘下蝴蝶结';
  const req={description:words,inputSha256:sha('image'),descriptionSha256:sha(words)};
  const raw=vision(req);
  const parts=[
    ['actions','wave','抬手打招呼','gesture:wave:rest','gesture:wave:hidden_hand','HIDDEN_HAND_DESIGN_UNCONFIRMED'],
    ['clothingVariants','chest_bow','摘下蝴蝶结','appearance:chest_bow','appearance:chest_bow:underlay','CHEST_BOW_UNDERLAY_DESIGN_UNCONFIRMED'],
  ];
  raw.imageObservation.materialRegions=[];
  for(const [list,id,quote,anchor,region,code] of parts){
    raw.intent[list].push({id,label:quote,source:'user',quote});
    raw.imageObservation.materialRegions.push({semantic:anchor,box:[0.1,0.2,0.3,0.4]});
    raw.inferences.push({region,proposal:'未确认的原始推断',changesIdentity:true,accepted:false,source:'default',quote:''});
    raw.unresolved.push({code,question:'这块应该如何补绘？',quote});
  }
  assert.deepEqual(validateBrief(raw,words,req.inputSha256,req.descriptionSha256),[]);
  const chosen=finalizeBrief(raw);
  assert.deepEqual(chosen.issues,[]);
  assert.equal(chosen.brief.defaultsApplied.filter(s=>s.startsWith('source-preserving-material:')).length,2);
  assert(chosen.brief.inferences.every(i=>!i.changesIdentity&&!i.accepted));
  assert(raw.inferences.every(i=>i.changesIdentity&&i.proposal==='未确认的原始推断'));
  const noSleeve=structuredClone(raw);noSleeve.imageObservation.materialRegions.shift();
  assert(finalizeBrief(noSleeve).issues.some(i=>i.code===parts[0][5]));
  const redesign=structuredClone(raw);redesign.intent.appearanceChanges.push({feature:'袖口',detail:'更换',source:'user',quote:'抬手打招呼'});
  assert.equal(finalizeBrief(redesign).issues.filter(i=>i.code==='DESIGN_CONFIRMATION_REQUIRED').length,2);
  for(const region of [{semantic:parts[0][3],box:[0,0,1,1]},{semantic:'face',box:[0.5,0.1,0.3,0.9]}]){
    const invalid=structuredClone(raw);invalid.imageObservation.materialRegions.push(region);
    assert(validateBrief(invalid,words,req.inputSha256,req.descriptionSha256).length>0);
  }
});

test('real transparent PNG is decoded, privately snapshotted and idempotently reused',async t=>{
  const s=await setup(t),bundle=await prepareInput(s.request,s.ctx);
  assert.equal(bundle.status,'completed');assert.equal(bundle.sourceImage.width,40);assert.equal(bundle.sourceImage.height,64);assert.equal(bundle.sourceImage.hasAlpha,true);
  assert.equal(bundle.inputSha256,sha(await fs.readFile(path.join(s.fixtures,'transparent.png'))));
  assert.equal(bundle.brief.originalDescription,description);assert.equal(bundle.brief.outputFraming,'full_body');
  assert.deepEqual(bundle.brief.intent.expressions.map(x=>x.id),['happy','angry']);
  assert.equal(bundle.rights.publicRedistributionAllowed,false);assert.equal(bundle.rights.verification,'user_declared');
  for(const a of bundle.artifacts) {assert.equal(path.isAbsolute(a.path),false);assert.equal(a.sha256,sha(await fs.readFile(path.join(s.taskRoot,a.path))));}
  const pub=await fs.readFile(path.join(s.taskRoot,'intake/public-provenance.json'),'utf8');assert.equal(pub.includes(description),false);assert.equal(pub.includes('fixture-task'),false);
  assert.equal((await fs.stat(path.join(s.taskRoot,'intake/private-request.json'))).mode&0o777,0o600);
  const mtime=(await fs.stat(path.join(s.taskRoot,'intake/normalized.png'))).mtimeMs;
  const repeated=await prepareInput(s.request,s.ctx);assert.equal(repeated.status,'completed');assert.equal(s.counts().visualCalls,1);
  const reordered={...s.request,rights:Object.fromEntries(Object.entries(s.request.rights).reverse())};
  assert.equal((await prepareInput(reordered,s.ctx)).status,'completed');
  assert.equal((await fs.stat(path.join(s.taskRoot,'intake/normalized.png'))).mtimeMs,mtime);
  assert.equal((await fs.readdir(path.join(s.taskRoot,'intake'))).some(n=>n.endsWith('.tmp')||n==='.lock'),false);
});

test('runtime compatibility uncertainty becomes an auditable downstream check, not missing user input',async t=>{
  const s=await setup(t),quote='可直播使用的 Live2D 资源包';
  s.request.description=`请把这张图做成${quote}。`;
  const pending={code:'LIVE2D_DELIVERY_COMPATIBILITY_UNVERIFIED',question:'实际制作链能否交付原生模型并完成运行验证？',quote};
  const unsupported={request:quote,reason:'尚无法确认下游原生交付及目标运行器兼容性，保留要求。',quote};
  let raw;
  s.ctx.describeImage=async r=>(raw=vision(r,{unresolved:[pending],unsupported:[unsupported]}));
  const b=await prepareInput(s.request,s.ctx);
  assert.equal(b.status,'completed');assert.deepEqual(b.unresolved,[]);
  assert.deepEqual(b.brief.unresolved,[]);assert.deepEqual(b.brief.unsupported,[]);
  assert.deepEqual(b.brief.deferredRequirements,[{...pending,stage:'runtime',status:'not_run',unsupported:[unsupported]}]);
  const check=b.checks.find(c=>c.name==='live2d_delivery_compatibility');
  assert.equal(check.layer,'runtime');assert.equal(check.status,'not_run');assert(check.note.includes(unsupported.reason));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(s.taskRoot,'intake/vision-response.json'),'utf8')),raw);
  assert.deepEqual(raw.unresolved,[pending]);assert.deepEqual(raw.unsupported,[unsupported]);
  assert.deepEqual((await prepareInput(s.request,s.ctx)).brief,b.brief);
});

test('an exact unique observation resolves a feature alias and preserves a downstream approval requirement',async t=>{
  const s=await setup(t),quote='外发图片或付费时先暂停';
  s.request.description+=quote;
  let raw;
  s.ctx.describeImage=async r=>{
    raw=vision(r,{unresolved:[{code:'EXTERNAL_SHARING_OR_PAYMENT_APPROVAL_REQUIRED',question:'等待用户授权',quote}]});
    raw.intent.preserve[0].feature='shape_detail';
    return raw;
  };
  const b=await prepareInput(s.request,s.ctx);
  assert.equal(b.status,'completed');
  assert.equal(b.brief.intent.preserve[0].feature,'shape');
  assert.deepEqual(b.brief.externalApprovalNotes,raw.unresolved);
  const ambiguous=structuredClone(raw);
  ambiguous.imageObservation.appearance.push({...ambiguous.imageObservation.appearance[0],feature:'other'});
  assert.deepEqual(validateBrief(ambiguous,s.request.description,b.inputSha256,b.descriptionSha256),
    ['brief: image preservation has no matching observation']);
});

test('unknown compatibility codes, user design questions and unmatched unsupported requests remain blocking',async t=>{
  const s=await setup(t),quote='直播模型';
  s.ctx.describeImage=async r=>vision(r,{
    unresolved:[{code:'LIVE2D_DELIVERY_COMPATIBILITY_UNVERIFIED',question:'下游运行验收待做',quote},{code:'OTHER_COMPATIBILITY_UNVERIFIED',question:'未知问题需保留',quote},{code:'DESIGN_CHOICE_REQUIRED',question:'需用户选择设计',quote}],
    unsupported:[{request:'另一项请求',reason:'真实不支持项',quote},{request:quote,reason:'引文不匹配不能关联',quote:''}],
  });
  const b=await prepareInput(s.request,s.ctx);
  assert.equal(b.status,'needs_input');
  assert.deepEqual(b.unresolved.map(x=>x.code),['OTHER_COMPATIBILITY_UNVERIFIED','DESIGN_CHOICE_REQUIRED','REQUEST_UNSUPPORTED','REQUEST_UNSUPPORTED']);
  assert.equal(b.brief.deferredRequirements.length,1);assert.deepEqual(b.brief.deferredRequirements[0].unsupported,[]);
  assert.equal(b.brief.unsupported.length,2);
});

test('real JPEG EXIF rotation and ICC conversion retain original hash and remove metadata',async t=>{
  const s=await setup(t);await fixtureResolver(s,'rotated.jpg','image/jpeg');
  const b=await prepareInput(s.request,s.ctx);assert.equal(b.status,'completed');
  assert.deepEqual([b.sourceImage.width,b.sourceImage.height,b.sourceImage.orientation,b.sourceImage.hasAlpha],[24,40,1,false]);
  assert.equal(b.imageNormalization.originalOrientation,6);assert.notEqual(b.inputSha256,b.sourceImage.sha256);
  assert.ok(b.imageNormalization.conversions.includes('embedded_icc_to_srgb'));
  const probe=await exec('/usr/bin/python3',['-c',"from PIL import Image; import sys,json; i=Image.open(sys.argv[1]); i.load(); print(json.dumps({'exif':dict(i.getexif()),'info':list(i.info)}))",path.join(s.taskRoot,b.sourceImage.path)]);
  assert.deepEqual(JSON.parse(probe.stdout),{exif:{},info:[]});
});

test('ICC conversion keeps actual alpha values; 16-bit RGB PNG is not silently reduced to 8-bit',async t=>{
  const s=await setup(t);await fixtureResolver(s,'alpha-icc.png','image/png');
  const b=await prepareInput(s.request,s.ctx);assert.equal(b.status,'completed');assert.equal(b.sourceImage.hasAlpha,true);
  const probe=await exec('/usr/bin/python3',['-c',"from PIL import Image; import sys,json; i=Image.open(sys.argv[1]); i.load(); print(json.dumps([i.getpixel((0,0))[3],i.getpixel((12,12))[3]]))",path.join(s.taskRoot,b.sourceImage.path)]);
  assert.deepEqual(JSON.parse(probe.stdout),[0,190]);
  const rgb=await setup(t);await fixtureResolver(rgb,'rgb16.png','image/png');
  const bad=await prepareInput(rgb.request,rgb.ctx);assert.equal(bad.status,'needs_input');assert.equal(bad.error.code,'IMAGE_BIT_DEPTH_UNSUPPORTED');
});

test('actual bytes govern format; mismatched extension is disclosed, fake MIME and corrupt images refused',async t=>{
  const s=await setup(t);const target=path.join(s.taskRoot,'input/mislabeled.jpg');await fs.copyFile(path.join(s.fixtures,'transparent.png'),target);
  s.ctx.resolveImage=async()=>({path:target,mimeType:'image/png'});
  const good=await prepareInput(s.request,s.ctx);assert.equal(good.status,'completed');assert.ok(good.warnings.some(x=>x.includes('扩展名')));
  s.ctx.resolveImage=async()=>({path:target,mimeType:'image/jpeg'});
  assert.equal((await prepareInput(s.request,s.ctx)).error.code,'IMAGE_MIME_MISMATCH');
  const corrupt=await setup(t),file=path.join(corrupt.taskRoot,'input/broken.png');
  await fs.writeFile(file,(await fs.readFile(path.join(corrupt.fixtures,'transparent.png'))).subarray(0,28));
  corrupt.ctx.resolveImage=async()=>({path:file,mimeType:'image/png'});
  const bad=await prepareInput(corrupt.request,corrupt.ctx);assert.equal(bad.status,'needs_input');assert.equal(bad.error.code,'IMAGE_DECODE_FAILED');assert.equal(corrupt.counts().visualCalls,0);
});

test('text paths, URLs, multi-images and old material IDs never become local image access',async t=>{
  const s=await setup(t);
  for(const imageRef of ['/etc/passwd','../private.png','file:///x.png','https://example.test/x.png','a/b.png','a\\b.png',['a','b']]) {
    const b=await prepareInput({...s.request,imageRef},s.ctx);assert.equal(b.status,'needs_input');
  }
  assert.equal((await prepareInput({...s.request,material_id:'tml'},s.ctx)).status,'needs_input');
  const missing=await prepareInput({...s.request,imageRef:''},s.ctx);assert.equal(missing.error.code,'IMAGE_REQUIRED');assert.ok(missing.error.message.includes('无需提供 PSD'));
  assert.equal(s.counts().resolverCalls,0);
});

test('cross-session, cross-task and escaping symlinks are refused after controlled resolution',async t=>{
  const s=await setup(t);
  s.ctx.resolveImage=async()=>{throw Object.assign(new Error('private details must not leak'),{code:'SESSION_MISMATCH'});};
  const cross=await prepareInput(s.request,s.ctx);assert.equal(cross.error.code,'SESSION_MISMATCH');assert.equal(JSON.stringify(cross).includes('private details'),false);
  s.ctx.resolveImage=async()=>({path:path.join(s.fixtures,'transparent.png')});
  assert.equal((await prepareInput(s.request,s.ctx)).error.code,'IMAGE_REFERENCE_INVALID');
  const link=path.join(s.taskRoot,'input/link.png');await fs.symlink(path.join(s.fixtures,'transparent.png'),link);
  s.ctx.resolveImage=async()=>({path:link});assert.equal((await prepareInput(s.request,s.ctx)).error.code,'IMAGE_REFERENCE_INVALID');
  s.ctx.resolveImage=async()=>({path:'../fixtures/transparent.png'});assert.equal((await prepareInput(s.request,s.ctx)).error.code,'IMAGE_REFERENCE_INVALID');
  const output=await setup(t);await fs.symlink(output.fixtures,path.join(output.taskRoot,'intake'));
  assert.equal((await prepareInput(output.request,output.ctx)).error.code,'OUTPUT_INVALID');
});

test('dimension and byte bounds are checked before expensive raster allocation; CMYK is explicit',async t=>{
  const s=await setup(t);await fixtureResolver(s,'huge.png','image/png');
  const huge=await prepareInput(s.request,s.ctx);assert.equal(huge.status,'needs_input');assert.equal(huge.error.code,'IMAGE_DIMENSIONS_EXCEEDED');
  const large=await setup(t),file=path.join(large.taskRoot,'input/large.png');const fd=await fs.open(file,'w');await fd.truncate(16*1024*1024+1);await fd.close();
  large.ctx.resolveImage=async()=>({path:file,mimeType:'image/png'});assert.equal((await prepareInput(large.request,large.ctx)).error.code,'IMAGE_TOO_LARGE');
  const cmyk=await setup(t);await fixtureResolver(cmyk,'unprofiled.jpg','image/jpeg');assert.equal((await prepareInput(cmyk.request,cmyk.ctx)).error.code,'CMYK_PROFILE_REQUIRED');
});

test('missing vision blocks after real decode rather than inventing a half-body brief',async t=>{
  const s=await setup(t);delete s.ctx.describeImage;
  const b=await prepareInput(s.request,s.ctx);assert.equal(b.status,'blocked');assert.equal(b.error.code,'BACKEND_UNAVAILABLE');assert.equal(b.brief,null);assert.equal(b.sourceImage.width,40);
});

test('user full-body scope, specific emotions and actions survive; unseen body needs design confirmation',async t=>{
  const s=await setup(t);s.request.description='保留全身，做害羞和困倦两个表情，再做一个比心动作。';
  s.ctx.describeImage=async r=>{
    const b=vision(r);b.intent.framing={value:'full_body',source:'user',quote:'保留全身'};
    b.intent.expressions=[{id:'shy',label:'害羞',source:'user',quote:'害羞'},{id:'sleepy',label:'困倦',source:'user',quote:'困倦'}];
    b.intent.actions=[{id:'heart',label:'比心',source:'user',quote:'比心动作'}];return b;
  };
  const b=await prepareInput(s.request,s.ctx);assert.equal(b.status,'completed');assert.equal(b.brief.outputFraming,'full_body');assert.deepEqual(b.brief.intent.expressions.map(x=>x.id),['shy','sleepy']);assert.equal(b.brief.intent.actions[0].id,'heart');
  const portrait=await setup(t);portrait.request.description='做成全身。';
  portrait.ctx.describeImage=async r=>{const b=vision(r);b.imageObservation.framing='portrait';b.intent.framing={value:'full_body',source:'user',quote:'做成全身'};return b;};
  const p=await prepareInput(portrait.request,portrait.ctx);assert.equal(p.status,'needs_input');assert.ok(p.unresolved.some(x=>x.code==='BODY_DESIGN_REQUIRED'));assert.equal(p.brief.outputFraming,'full_body');
});

test('unknown framing with a visible waist supports half-body without inventing missing coverage',()=>{
  const raw=vision({description:'做成半身。',inputSha256:'a'.repeat(64),descriptionSha256:sha('做成半身。')});
  raw.intent.framing={value:'half_body',source:'user',quote:'做成半身'};
  raw.imageObservation.framing='unknown';
  raw.imageObservation.visibleParts=['头顶及头发外轮廓','双肩、胸部、腰部和胯部','双侧衣袖、袖口、手腕及双手'];
  raw.imageObservation.occludedParts=['画面下缘之外的膝部、小腿和双脚'];
  assert.deepEqual(finalizeBrief(raw).issues,[]);
  raw.intent.framing.value='full_body';
  assert.ok(finalizeBrief(raw).issues.some(x=>x.code==='FRAMING_UNCERTAIN'));
  raw.intent.framing.value='half_body';
  raw.imageObservation.visibleParts=['头顶及头发外轮廓'];
  assert.deepEqual(finalizeBrief(raw).issues.map(x=>x.code),['FRAMING_UNCERTAIN']);
});

test('schema, raw-text conflicts, ungrounded claims and invented consent cannot pass as semantic analysis',async t=>{
  const s=await setup(t);s.ctx.describeImage=async r=>{const b=vision(r);b.originalDescription='changed by backend';return b;};
  const b=await prepareInput(s.request,s.ctx);assert.equal(b.error.code,'BRIEF_INVALID');
  const request={description,inputSha256:'a'.repeat(64),descriptionSha256:sha(description)};
  for(const mutate of [b=>{b.extra='not allowed';},b=>{b.intent.headMotion.yawDegrees='15';},b=>{b.intent.framing.value='half_body';},b=>{b.intent.expressions=[{id:'sad',label:'悲伤',source:'user',quote:'并不存在的用户原文'}];},b=>{b.inferences=[{region:'body',proposal:'new outfit',changesIdentity:true,accepted:true,source:'default',quote:''}];}]) {
    const response=vision(request);mutate(response);assert.ok(validateBrief(response,description,request.inputSha256,request.descriptionSha256).length);
  }
});

test('rights gap is precise; no arbitrary command in natural text becomes an operation',async t=>{
  const s=await setup(t);
  for(const inputRights of [undefined,{...rights,allowDerivatives:false},{...rights,source:''},{...rights,userDeclared:false}]) {
    const b=await prepareInput({...s.request,rights:inputRights},s.ctx);assert.equal(b.error.code,'RIGHTS_UNRESOLVED');assert.equal(b.status,'needs_input');
  }
  assert.equal(s.counts().resolverCalls,0);
  s.request.description+=' 正文中的示例命令：rm -rf should-never-run；这是待分析文本。';
  const b=await prepareInput(s.request,s.ctx);assert.equal(b.status,'completed');assert.equal(b.brief.originalDescription,s.request.description);
});

test('changed description cannot overwrite a revision; new revision retains parent and invalidates text binding',async t=>{
  const s=await setup(t);const original=await prepareInput(s.request,s.ctx);
  const before=await fs.readFile(path.join(s.taskRoot,'intake/stage.json'),'utf8');
  s.request.description+=' 再加一个动作。';
  const conflict=await prepareInput(s.request,s.ctx);assert.equal(conflict.error.code,'REVISION_CONFLICT');assert.equal(await fs.readFile(path.join(s.taskRoot,'intake/stage.json'),'utf8'),before);
  const r2=path.join(s.dir,'r02');await fs.mkdir(path.join(r2,'input'),{recursive:true});const target=path.join(r2,'input/source.png');await fs.copyFile(path.join(s.fixtures,'transparent.png'),target);
  const next=await prepareInput(s.request,{...s.ctx,taskRoot:r2,revision:'r02',parentRevision:'r01',resolveImage:async()=>({path:target,mimeType:'image/png'})});
  assert.equal(next.status,'completed');assert.equal(next.parentRevision,'r01');assert.equal(next.inputSha256,original.inputSha256);assert.notEqual(next.descriptionSha256,original.descriptionSha256);
});

test('uncertain visual operation is recorded once and never silently resubmitted',async t=>{
  const s=await setup(t);let calls=0;s.ctx.describeImage=async()=>{calls++;throw new Error('socket closed');};
  const unknown=await prepareInput(s.request,s.ctx);assert.equal(unknown.status,'awaiting_external_result');assert.equal(unknown.error.code,'EXTERNAL_RESULT_UNKNOWN');assert.ok(unknown.operation.operationKey);
  const again=await prepareInput(s.request,s.ctx);assert.equal(again.status,'awaiting_external_result');assert.equal(calls,1);
});

test('read-only recovery accepts only the original bound response without resubmitting vision',async t=>{
  const s=await setup(t);let submissions=0,queries=0,original;
  s.ctx.describeImage=async r=>{submissions++;original=r;throw new Error('lost connection after submission');};
  const pending=await prepareInput(s.request,s.ctx);assert.equal(pending.status,'awaiting_external_result');
  delete s.ctx.describeImage;
  s.ctx.recoverDescription=async r=>{
    queries++;assert.equal(r.operationKey,original.operationKey);assert.deepEqual(r.operation,pending.operation);
    assert.deepEqual(r.image,original.image);assert.deepEqual(r.outputSchema,BRIEF_SCHEMA);return vision(r);
  };
  const recovered=await prepareInput(s.request,s.ctx);assert.equal(recovered.status,'completed');assert.equal(recovered.operation.status,'completed');assert.equal(submissions,1);assert.equal(queries,1);
  assert.equal(JSON.parse(await fs.readFile(path.join(s.taskRoot,'intake/analysis-operation.json'),'utf8')).status,'completed');
  const cached=await prepareInput(s.request,s.ctx);assert.deepEqual(cached,recovered);assert.equal(queries,1);assert.equal(submissions,1);
  await fs.rm(path.join(s.taskRoot,'intake/vision-response.json'));
  const missing=await prepareInput(s.request,s.ctx);assert.equal(missing.error.code,'CACHE_CHANGED');assert.equal(queries,1);assert.equal(submissions,1);
});

test('missing or failed recovery stays awaiting and never triggers a fresh analysis',async t=>{
  const s=await setup(t);let submissions=0,queries=0;
  s.ctx.describeImage=async()=>{submissions++;throw new Error('unknown original result');};
  await prepareInput(s.request,s.ctx);
  const operationBefore=await fs.readFile(path.join(s.taskRoot,'intake/analysis-operation.json'),'utf8');
  for(const result of [null,undefined,'throw']) {
    s.ctx.recoverDescription=async()=>{queries++;if(result==='throw') throw new Error('private recovery details');return result;};
    const b=await prepareInput(s.request,s.ctx);assert.equal(b.status,'awaiting_external_result');assert.equal(b.error.code,'EXTERNAL_RESULT_UNKNOWN');
    assert.equal(JSON.stringify(b).includes('private recovery details'),false);
    assert.equal(await fs.readFile(path.join(s.taskRoot,'intake/analysis-operation.json'),'utf8'),operationBefore);
    await assert.rejects(fs.access(path.join(s.taskRoot,'intake/vision-response.json')),{code:'ENOENT'});
  }
  assert.equal(queries,3);assert.equal(submissions,1);
});

test('recovery validates original image/text binding and rejects changed operation records',async t=>{
  const s=await setup(t);s.ctx.describeImage=async()=>{throw new Error('unknown');};await prepareInput(s.request,s.ctx);
  let queries=0;s.ctx.recoverDescription=async r=>{queries++;return vision(r,{inputSha256:'0'.repeat(64)});};
  const invalid=await prepareInput(s.request,s.ctx);assert.equal(invalid.status,'blocked');assert.equal(invalid.error.code,'BRIEF_INVALID');
  assert.equal((await prepareInput(s.request,s.ctx)).error.code,'BRIEF_INVALID');assert.equal(queries,1);
  const changed=await setup(t);changed.ctx.describeImage=async()=>{throw new Error('unknown');};await prepareInput(changed.request,changed.ctx);
  const file=path.join(changed.taskRoot,'intake/analysis-operation.json');
  const operation=JSON.parse(await fs.readFile(file,'utf8'));operation.operationKey='intake-vision-'+ '0'.repeat(64);await fs.writeFile(file,JSON.stringify(operation));
  changed.ctx.recoverDescription=async()=>{throw new Error('must not query a mismatched operation');};
  const bad=await prepareInput(changed.request,changed.ctx);assert.equal(bad.status,'blocked');assert.equal(bad.error.code,'CACHE_CHANGED');
});

test('cache corruption invalidates the visual result; cancellation does not call backends',async t=>{
  const s=await setup(t);await prepareInput(s.request,s.ctx);
  await fs.writeFile(path.join(s.taskRoot,'intake/normalized.png'),'modified');
  assert.equal((await prepareInput(s.request,s.ctx)).error.code,'CACHE_CHANGED');assert.equal(s.counts().visualCalls,1);
  const cancelled=await setup(t),controller=new AbortController();controller.abort();
  const b=await prepareInput(cancelled.request,{...cancelled.ctx,signal:controller.signal});assert.equal(b.error.code,'CANCELLED');assert.equal(cancelled.counts().resolverCalls,0);
});
