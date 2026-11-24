import {existsSync} from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const localFfmpeg=path.join(os.homedir(),'.local/bin/ffmpeg');
export const ffmpeg=process.env.LIVE2D_FFMPEG||(existsSync(localFfmpeg)?localFfmpeg:'ffmpeg');
const exec=promisify(execFile);

// Crop values belong to the checked source, not to an arbitrary uploaded image.
export async function finishPreview(directory,crop) {
  const source=path.join(directory,'tml.mp4');
  const output=path.join(directory,'半身制作预览-6秒.mp4');
  if(!Array.isArray(crop)||crop.length!==4||!crop.every(Number.isInteger)) throw new Error('缺少已检查素材的半身取景范围');
  const [x,y,w,h]=crop;
  if(x<0||y<0||w<=0||h<=0||x+w>1024||y+h>1024) throw new Error('半身取景超出制作画布');
  await exec(ffmpeg,['-v','error','-y','-i',source,'-vf',`crop=${w}:${h}:${x}:${y},scale=768:-2`,
    '-t','6','-r','24','-an','-c:v','libx264','-crf','18','-pix_fmt','yuv420p','-movflags','+faststart',output]);
  const cover=path.join(directory,'半身预览.png');
  await exec(ffmpeg,['-v','error','-y','-ss','0.3','-i',output,'-frames:v','1','-update','1',cover]);
  const probe=await exec(ffmpeg,['-hide_banner','-i',output,'-f','null','-'],{maxBuffer:1024*1024});
  const duration=/Duration: (\d+):(\d+):([\d.]+)/.exec(probe.stderr);
  const seconds=duration?Number(duration[1])*3600+Number(duration[2])*60+Number(duration[3]):null;
  if(seconds!==6) throw new Error('半身制作预览时长不是六秒');
  const check={kind:'制作引擎动画，非真人摄像头或声音实录',duration:seconds,fps:24,audio:false,
    source,output,cover,crop:{x,y,width:w,height:h,sourceSize:1024},checkedAt:new Date().toISOString()};
  await fs.writeFile(path.join(directory,'预览检查.json'),JSON.stringify(check,null,2)+'\n');
  return {previews:[output,path.join(directory,'tml.gif')],cover,check};
}
