import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {parseArgs} from 'node:util';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {ffmpeg} from '../src/preview.mjs';

const {values:args}=parseArgs({options:{
  artwork:{type:'string'},output:{type:'string'},role:{type:'string'},seconds:{type:'string'},poses:{type:'boolean'}
}});
if(!args.artwork||!args.output||!args.role)throw Error('Use --artwork MANIFEST --output NEW_DIR --role teal|silver|chestnut');
if(!['teal','silver','chestnut'].includes(args.role))throw Error('Unknown role');

const fps=args.poses?2:30,seconds=Number(args.seconds??18),frameCount=Math.round(seconds*fps);
if(!Number.isFinite(seconds)||seconds<=0||seconds>18||frameCount<1)throw Error('Invalid seconds');
const liftTiming={start:3.8,holdStart:6.10,holdEnd:7.80,end:9.55};
const shoulderDegrees={teal:68,silver:61.5,chestnut:66.5}[args.role];
const elbowDegrees=12;
const waveTiming={start:liftTiming.holdStart,end:liftTiming.holdEnd,beats:2};
const waveDegrees={elbow:6,wrist:18};
const manifestPath=await fs.realpath(args.artwork),artworkMarker=path.sep+'artwork'+path.sep;
const artworkAt=manifestPath.lastIndexOf(artworkMarker);
if(artworkAt<0)throw Error('Artwork manifest is outside a revision artwork directory');
const revisionRoot=manifestPath.slice(0,artworkAt);
const manifestBytes=await fs.readFile(manifestPath),manifest=JSON.parse(manifestBytes);
if(!manifest.canvas?.width||!manifest.canvas?.height||!Array.isArray(manifest.parts))throw Error('Invalid artwork manifest');

const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const images=[];
for(const part of manifest.parts){
  const file=path.resolve(revisionRoot,part.path),bytes=await fs.readFile(file);
  if(part.sha256&&sha256(bytes)!==part.sha256)throw Error('Registered artwork changed: '+part.path);
  images.push({...part,src:'data:image/png;base64,'+bytes.toString('base64')});
}

const output=path.resolve(args.output);
await fs.mkdir(output);
const video=path.join(output,args.poses?'pose-proof-1080p2.mp4':'video-only-1080p30.mp4');
const encoder=spawn(ffmpeg,['-v','error','-f','image2pipe','-framerate',String(fps),'-vcodec','png','-i','pipe:0',
  '-an','-c:v','libx264','-preset','medium','-crf','17','-pix_fmt','yuv420p','-movflags','+faststart',video],
{stdio:['pipe','ignore','pipe']});
let encoderError='';encoder.stderr.on('data',chunk=>encoderError+=chunk);
const encoded=once(encoder,'close');

const require=createRequire(import.meta.url);
let playwright;
try{playwright=require('playwright');}
catch{playwright=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}
const browser=await playwright.chromium.launch({
  executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,
  args:['--disable-background-networking','--disable-default-apps','--disable-sync','--no-first-run','--enable-unsafe-swiftshader']
});
try{
  const page=await browser.newPage({viewport:{width:1920,height:1080}});
  await page.setContent('<canvas id="frame" width="1920" height="1080"></canvas>');
  await page.evaluate(async({manifest,images,role,seconds,liftTiming,shoulderDegrees,elbowDegrees,waveTiming,waveDegrees})=>{
    const canvas=document.getElementById('frame'),ctx=canvas.getContext('2d',{alpha:false});
    const loaded=new Map(await Promise.all(images.map(part=>new Promise((resolve,reject)=>{
      const image=new Image();image.onload=()=>resolve([part.id,{...part,image}]);image.onerror=reject;image.src=part.src;
    }))));
    const parts=manifest.parts.map(part=>loaded.get(part.id));
    const tag=(part,value)=>part.tags?.includes(value);
    const isHead=part=>tag(part,'face')||tag(part,'eye')||tag(part,'brow')||tag(part,'mouth')||
      tag(part,'head')||tag(part,'hair');
    const isWave=part=>tag(part,'wave')||tag(part,'gesture')&&tag(part,'arm');
    const chosenArm=role==='teal'?new Set(['wave-elbow-backing','wave-sleeve','wave-forearm','wave-rest-hand']):
      new Set(['wave-sleeve','wave-elbow-fold']);
    const body=parts.filter(part=>!isHead(part)&&!isWave(part)&&!part.variant);
    const head=parts.filter(part=>isHead(part));
    const backHead=head.filter(part=>tag(part,'hair')&&tag(part,'back'));
    const frontHead=head.filter(part=>!backHead.includes(part));
    const arm=parts.filter(part=>chosenArm.has(part.id));
    if(!arm.length)throw Error('No compatible arm artwork');
    const rig=parts.find(part=>part.rigging?.continuousWave)?.rigging.continuousWave;
    if(!rig?.shoulder)throw Error('Arm artwork lacks a shoulder pivot');
    const armBounds={
      left:Math.min(...arm.map(part=>part.rect.left)),
      top:Math.min(...arm.map(part=>part.rect.top)),
      right:Math.max(...arm.map(part=>part.rect.left+part.rect.width)),
      bottom:Math.max(...arm.map(part=>part.rect.top+part.rect.height))
    };
    const sleeveTexture=document.createElement('canvas');
    sleeveTexture.width=armBounds.right-armBounds.left;
    sleeveTexture.height=armBounds.bottom-armBounds.top;
    const sleeveContext=sleeveTexture.getContext('2d');
    for(const part of arm){
      const {left,top,width,height}=part.rect;
      sleeveContext.drawImage(part.image,left-armBounds.left,top-armBounds.top,width,height);
    }
    // These sprites were trimmed to fit a resting pose under the bodice.
    // Rebuild the hidden shoulder cap from a continuous band of sleeve pixels.
    const sleevePixels=sleeveContext.getImageData(0,0,sleeveTexture.width,sleeveTexture.height).data;
    const [shoulderX,shoulderY]=rig.shoulder;
    const [elbowX,elbowY]=rig.elbow;
    const [wristX,wristY]=rig.wrist;
    const capTop=shoulderY-79;
    const repairEnds=shoulderY+Math.min(278,(elbowY-shoulderY)*.87);
    const shoulderWidth={teal:132,silver:132,chestnut:133}[role];
    const sleeveRows=[];
    for(let y=capTop;y<=armBounds.bottom;y+=4){
      const ratio=Math.min(1,(y-capTop)/(repairEnds-capTop));
      const sampleY=y<repairEnds?shoulderY+97+(repairEnds-shoulderY-97)*ratio:y;
      const sourceRow=Math.min(sleeveTexture.height-1,Math.max(0,Math.round(sampleY-armBounds.top)));
      const offset=sourceRow*sleeveTexture.width*4+3;
      let left=0,right=sleeveTexture.width-1;
      if(y<repairEnds){
        while(left<right&&sleevePixels[offset+left*4]<64)left++;
        while(right>left&&sleevePixels[offset+right*4]<64)right--;
      }
      const sampledWidth=Math.max(1,right-left);
      const sampledCenter=armBounds.left+(right+left)/2;
      const merge=Math.min(1,Math.max(0,(y-shoulderY-90)/(repairEnds-shoulderY-90)));
      const blend=merge*merge*(3-2*merge);
      const center=shoulderX+(sampledCenter-shoulderX)*blend;
      const roundCap=Math.sqrt(1-Math.max(0,1-(y-capTop)/70)**2);
      const halfWidth=(shoulderWidth*(1-blend)+sampledWidth*blend)*roundCap/2;
      const sourceLeft=Math.max(0,left-3),sourceRight=Math.min(sleeveTexture.width,right+4);
      const scaleX=2*halfWidth/sampledWidth;
      sleeveRows.push([y,sourceRow,center+(sourceLeft-(left+right)/2)*scaleX,
        center+(sourceRight-(left+right)/2)*scaleX,sourceLeft,sourceRight]);
    }
    // Blend both joints in one mesh so the cuff stays attached to the hand.
    const flexCanvas=document.createElement('canvas');
    flexCanvas.width=sleeveTexture.width+640;
    flexCanvas.height=sleeveTexture.height+240;
    const flex=flexCanvas.getContext('webgl',{antialias:true,premultipliedAlpha:true});
    if(!flex)throw Error('WebGL required for preview arm mesh');
    const compile=(type,source)=>{
      const shader=flex.createShader(type);flex.shaderSource(shader,source);flex.compileShader(shader);
      if(!flex.getShaderParameter(shader,flex.COMPILE_STATUS))throw Error(flex.getShaderInfoLog(shader));
      return shader;
    };
    const program=flex.createProgram();
    flex.attachShader(program,compile(flex.VERTEX_SHADER,`
      attribute vec2 point;
      attribute vec2 source;
      varying vec2 uv;
      void main(){gl_Position=vec4(point,0.,1.);uv=source;}
    `));
    flex.attachShader(program,compile(flex.FRAGMENT_SHADER,`
      precision mediump float;
      varying vec2 uv;
      uniform sampler2D sprite;
      void main(){gl_FragColor=texture2D(sprite,uv);}
    `));
    flex.linkProgram(program);
    if(!flex.getProgramParameter(program,flex.LINK_STATUS))throw Error(flex.getProgramInfoLog(program));
    flex.useProgram(program);
    flex.viewport(0,0,flexCanvas.width,flexCanvas.height);
    flex.bindTexture(flex.TEXTURE_2D,flex.createTexture());
    flex.pixelStorei(flex.UNPACK_PREMULTIPLY_ALPHA_WEBGL,true);
    flex.texImage2D(flex.TEXTURE_2D,0,flex.RGBA,flex.RGBA,flex.UNSIGNED_BYTE,sleeveTexture);
    for(const name of [flex.TEXTURE_WRAP_S,flex.TEXTURE_WRAP_T])flex.texParameteri(flex.TEXTURE_2D,name,flex.CLAMP_TO_EDGE);
    for(const name of [flex.TEXTURE_MIN_FILTER,flex.TEXTURE_MAG_FILTER])flex.texParameteri(flex.TEXTURE_2D,name,flex.LINEAR);
    flex.bindBuffer(flex.ARRAY_BUFFER,flex.createBuffer());
    for(const [name,offset] of [['point',0],['source',8]]){
      const attribute=flex.getAttribLocation(program,name);
      flex.enableVertexAttribArray(attribute);
      flex.vertexAttribPointer(attribute,2,flex.FLOAT,false,16,offset);
    }

    const allVisible=[...body,...head,...arm],top=Math.min(...allVisible.map(part=>part.rect.top));
    const sourceHeight=manifest.canvas.height-top;
    const framing={teal:{scale:.54,targetTop:290},silver:{scale:.72,targetTop:203},chestnut:{scale:.52,targetTop:325}}[role];
    const scale=framing.scale;
    const sourceCenter=manifest.canvas.width/2,pivotY=top+sourceHeight*.68;
    const targetTop=framing.targetTop,targetPivotY=targetTop+(pivotY-top)*scale;
    const headFace=parts.find(part=>tag(part,'face'));
    const headPivot=[headFace.rect.left+headFace.rect.width/2,headFace.rect.top+headFace.rect.height*.78];
    const smooth=value=>{value=Math.max(0,Math.min(1,value));return value*value*(3-2*value);};
    const armLift=time=>{
      const {start,holdStart,holdEnd,end}=liftTiming;
      return smooth((time-start)/(holdStart-start))*(1-smooth((time-holdEnd)/(end-holdEnd)));
    };
    const waveBeat=time=>{
      const {start,end,beats}=waveTiming;
      if(time<=start||time>=end)return 0;
      const progress=(time-start)/(end-start);
      return Math.sin(Math.PI*beats*progress)**2;
    };
    const motionEnvelope=time=>smooth(Math.min(time/1.15,(seconds-time)/1.15,1));
    const blinkAmount=time=>Math.max(...[1.1,3.65,6.15,8.9,11.75,14.45,16.75].map(center=>
      smooth(Math.max(0,1-Math.abs(time-center)/.12))));
    const speech=[[.45,2.55],[3.05,4.3],[5.15,7.05],[8.25,10.25],[11.35,13.4],[14.35,17.25]];
    const talkAmount=time=>speech.some(([start,end])=>time>start&&time<end)?
      .18+.82*Math.abs(Math.sin(time*8.4+Math.sin(time*2.2)))**1.6:0;
    const drawPart=(part,alpha=1)=>{
      if(alpha<=.001)return;ctx.globalAlpha=alpha;
      const {left,top,width,height}=part.rect;ctx.drawImage(part.image,left,top,width,height);ctx.globalAlpha=1;
    };
    const drawHeadPart=(part,blink,talk)=>{
      const closed=tag(part,'closed'),eye=tag(part,'eye');
      if(eye){drawPart(part,closed?blink:1-blink);return;}
      if(tag(part,'mouth')){
        if(closed){drawPart(part,1-talk);return;}
        const {left,top,width,height}=part.rect,cx=left+width/2,cy=top+height/2;
        ctx.save();ctx.translate(cx,cy);ctx.scale(1,.28+.72*talk);ctx.translate(-cx,-cy);drawPart(part,.35+.65*talk);ctx.restore();return;
      }
      if(part.variant)return;
      drawPart(part);
    };
    const flexArm=(elbowBend,wristBend)=>{
      const vertices=[];
      for(const [y,row,left,right,uLeft,uRight] of sleeveRows){
        const elbow=elbowBend*smooth((y-elbowY+102)/204);
        const wrist=wristBend*smooth((y-wristY+38)/100);
        const ec=Math.cos(elbow),es=Math.sin(elbow);
        const wc=Math.cos(wrist),ws=Math.sin(wrist);
        for(const [x,u] of [[left,uLeft],[right,uRight]]){
          const handX=wristX+(x-wristX)*wc-(y-wristY)*ws;
          const handY=wristY+(x-wristX)*ws+(y-wristY)*wc;
          const dx=elbowX+(handX-elbowX)*ec-(handY-elbowY)*es-armBounds.left+560;
          const dy=elbowY+(handX-elbowX)*es+(handY-elbowY)*ec-armBounds.top+120;
          vertices.push(2*dx/flexCanvas.width-1,1-2*dy/flexCanvas.height,
            u/sleeveTexture.width,(row+.5)/sleeveTexture.height);
        }
      }
      flex.clear(flex.COLOR_BUFFER_BIT);
      flex.bufferData(flex.ARRAY_BUFFER,new Float32Array(vertices),flex.STREAM_DRAW);
      flex.drawArrays(flex.TRIANGLE_STRIP,0,vertices.length/4);
    };
    const drawArm=(lift,bodyAngle)=>{
      const [sx,sy]=rig.shoulder;
      const shoulderJoin=smooth(lift*2.7);
      const inset={teal:27,silver:34,chestnut:37}[role]*shoulderJoin;
      ctx.save();
      ctx.translate(sx+inset,sy-19*shoulderJoin);
      // Near the held pose, offset the torso tilt so the hand stays below the shoulder.
      const heldBodyAngle=-4.5*Math.PI/180;
      ctx.rotate(shoulderDegrees*lift*Math.PI/180-(bodyAngle-heldBodyAngle)*lift**3);
      ctx.translate(-sx,-sy);
      ctx.drawImage(flexCanvas,armBounds.left-560,armBounds.top-120);
      ctx.restore();
    };
    window.renderFrame=time=>{
      const backdrop=ctx.createRadialGradient(960,430,80,960,520,1040);
      backdrop.addColorStop(0,'#6f8c9a');backdrop.addColorStop(.56,'#3c5968');backdrop.addColorStop(1,'#112b3a');
      ctx.fillStyle=backdrop;ctx.fillRect(0,0,1920,1080);
      const env=motionEnvelope(time);
      const bodyWave=(Math.sin(time*Math.PI*2/6.8-.65)+.28*Math.sin(time*Math.PI*2/3.4+.8))*env;
      const bodyAngle=bodyWave*7.5*Math.PI/180;
      const bodyX=(72*Math.sin(time*Math.PI*2/8.6-.55)+22*Math.sin(time*Math.PI*2/4.3+.6))*env;
      const bodyY=14*Math.sin(time*Math.PI*2/4.9+.2)*env;
      const bodyShear=.04*Math.sin(time*Math.PI*2/7.1+.5)*env;
      const headWave=(Math.sin(time*Math.PI*2/4.2+.75)+.3*Math.sin(time*Math.PI*2/2.1-.25))*env;
      const headAngle=headWave*9*Math.PI/180;
      const headX=headWave*20,headY=7*Math.sin(time*Math.PI*2/3.6+.4)*env;
      const blink=blinkAmount(time),talk=talkAmount(time);
      const drawHeadGroup=group=>{
        ctx.save();ctx.translate(...headPivot);ctx.translate(headX,headY);ctx.rotate(headAngle);
        ctx.transform(1,0,headWave*.05,1,0,0);ctx.translate(-headPivot[0],-headPivot[1]);
        group.forEach(part=>drawHeadPart(part,blink,talk));ctx.restore();
      };
      ctx.save();ctx.translate(960+bodyX,targetPivotY+bodyY);ctx.rotate(bodyAngle);ctx.scale(scale,scale);
      ctx.transform(1,0,bodyShear,1,0,0);ctx.translate(-sourceCenter,-pivotY);
      const lift=armLift(time);
      const toRadians=Math.PI/180;
      const elbowBend=(elbowDegrees*lift-waveDegrees.elbow*waveBeat(time-.08))*toRadians;
      const wristBend=-waveDegrees.wrist*waveBeat(time)*toRadians;
      flexArm(elbowBend,wristBend);
      drawHeadGroup(backHead);
      drawArm(lift,bodyAngle);
      body.forEach(part=>drawPart(part));
      drawHeadGroup(frontHead);
      ctx.restore();
      const shade=ctx.createLinearGradient(0,875,0,1080);shade.addColorStop(0,'rgba(0,0,0,0)');shade.addColorStop(1,'rgba(0,0,0,.22)');
      ctx.fillStyle=shade;ctx.fillRect(0,875,1920,205);
      return canvas.toDataURL('image/png').slice('data:image/png;base64,'.length);
    };
  },{manifest,images,role:args.role,seconds,liftTiming,shoulderDegrees,elbowDegrees,waveTiming,waveDegrees});

  for(let frame=0;frame<frameCount;frame++){
    const png=Buffer.from(await page.evaluate(time=>window.renderFrame(time),frame/fps),'base64');
    if(!encoder.stdin.write(png))await once(encoder.stdin,'drain');
  }
  encoder.stdin.end();
  const [code]=await encoded;
  if(code!==0)throw Error('ffmpeg failed: '+encoderError);
}finally{
  if(!encoder.killed)encoder.kill();
  await browser.close();
}

const videoBytes=await fs.readFile(video);
const provenance={schemaVersion:1,scope:'video-only',role:args.role,renderer:'Codex canvas video-layer edit',
  sourceArtworkManifest:{path:manifestPath,bytes:manifestBytes.length,sha256:sha256(manifestBytes)},
  packageModified:false,width:1920,height:1080,fps,seconds,frameCount,
  motion:{reference:'星汐-自然动作预览.mp4',bodySwayDegrees:7.5,bodyTravelPixels:94,headSwayDegrees:9,
    armMotion:'outward raise below shoulder height, two small wave beats, then a return to rest',
    liftTiming,shoulderDegrees,elbowDegrees,waveTiming,waveDegrees,
    armLayering:'continuous arm behind bodice and front hair',
    shoulderJoin:'round shoulder cap and upper sleeve reconstructed from the original sleeve texture',
    elbowMotion:'continuous textured sleeve mesh with a gentle forearm follow-through after the wrist',
    shoulderPivot:images.find(part=>part.rigging?.continuousWave)?.rigging.continuousWave.shoulder},
  video:{file:path.basename(video),bytes:videoBytes.length,sha256:sha256(videoBytes)},createdAt:new Date().toISOString()};
await fs.writeFile(path.join(output,'render-provenance.json'),JSON.stringify(provenance,null,2)+'\n',{flag:'wx'});
process.stdout.write(JSON.stringify({output,...provenance.video,frameCount,seconds})+'\n');
