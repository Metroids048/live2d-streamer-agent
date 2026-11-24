import {test} from 'node:test';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('registered Hachi face separation preserves visible pixels across translation and new iris color; ambiguous/unseen anatomy stays absent',async()=>{
  const script=fileURLToPath(new URL('./facial-materials-check.py',import.meta.url));
  await promisify(execFile)('/usr/bin/python3',['-B',script],{timeout:15000});
});

test('a same-intake registered garment can restore the occluded waist on a wave and all original RGBA on return',async()=>{
  const script=fileURLToPath(new URL('./body-materials-check.py',import.meta.url));
  await promisify(execFile)('/usr/bin/python3',['-B',script],{timeout:15000});
});
