import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const run=promisify(execFile);

// Only the local worker resolves this item. Neither its value nor command
// output is included in task records, the environment of children, or chat.
export async function runningHubCredential({env=process.env,platform=process.platform,read=run}={}) {
  if(env.RUNNINGHUB_API_KEY)return env.RUNNINGHUB_API_KEY;
  if(platform!=='darwin')return undefined;
  try {
    const {stdout}=await read('/usr/bin/security',
      ['find-generic-password','-s','live2d-streamer.runninghub','-a','live2d-streamer','-w'],
      {timeout:10000,maxBuffer:4096,encoding:'utf8'});
    const value=stdout.trim();
    return value&&value.length<=1024&&!/\s/.test(value)?value:undefined;
  }catch{return undefined;}
}
