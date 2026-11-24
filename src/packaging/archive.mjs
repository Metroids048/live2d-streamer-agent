import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {reject} from './files.mjs';

const helper = fileURLToPath(new URL('./archive.py', import.meta.url));

export async function archive(request, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, rejectPromise) => {
    const child = spawn('python3', [helper], {stdio: ['pipe', 'pipe', 'pipe'], signal});
    let output = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => {
      output += chunk;
      if (output.length > 1024 * 1024) child.kill();
    });
    child.stderr.setEncoding('utf8').on('data', chunk => {stderr = (stderr + chunk).slice(-2000);});
    child.once('error', rejectPromise);
    child.once('close', code => {
      try {
        const reply = JSON.parse(output);
        if (code !== 0 || !reply.ok) reject('REFERENCE_INVALID', reply.error || '归档校验失败');
        resolve(reply.result);
      } catch (error) {
        if (!error.code) Object.assign(error, {code: 'PACKAGE_ARCHIVE_FAILED', stage: 'packaging'});
        rejectPromise(error);
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(request));
  });
}
