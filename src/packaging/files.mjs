import * as fs from 'node:fs/promises';
import {constants, createReadStream} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Fault} from '../rpc.mjs';

export function reject(code, message) {
  const error = new Fault(code, message);
  Object.assign(error, {code, stage: 'packaging', retryable: false});
  throw error;
}

export function relativePath(value) {
  if (typeof value !== 'string' || !value || value !== value.normalize('NFC') ||
      /[\\\x00-\x1f\x7f:]/u.test(value) || path.posix.isAbsolute(value) ||
      value.split('/').some(p => !p || p === '.' || p === '..' || p.startsWith('.') ||
        /^(?:sessions?|credentials?|secrets?)(?:[.-]|$)/i.test(p))) {
    reject('REFERENCE_INVALID', '产物路径必须为不含越界、隐藏或私有目录的包内相对路径');
  }
  return value;
}

export async function regular(root, relative) {
  relativePath(relative);
  const file = path.join(root, relative);
  let cursor = root;
  try {
    for (const part of relative.split('/')) {
      cursor = path.join(cursor, part);
      if ((await fs.lstat(cursor)).isSymbolicLink()) reject('REFERENCE_INVALID', '产物或父目录不能是符号链接');
    }
    if (!(await fs.lstat(file)).isFile() || await fs.realpath(file) !== file) {
      reject('REFERENCE_INVALID', '产物必须是本任务的普通文件');
    }
  } catch (error) {
    if (error.code === 'ENOENT') reject('REFERENCE_INVALID', `缺少资源：${relative}`);
    throw error;
  }
  return file;
}

export async function digest(file) {
  const hash = createHash('sha256');
  let bytes = 0;
  const stream = createReadStream(file, {flags: constants.O_RDONLY | constants.O_NOFOLLOW});
  for await (const chunk of stream) {hash.update(chunk); bytes += chunk.length;}
  return {sha256: hash.digest('hex'), bytes};
}

export async function artifact(root, relative, role) {
  return {role, path: relative, ...await digest(await regular(root, relative))};
}

export async function json(root, relative) {
  const file = await regular(root, relative);
  if ((await fs.stat(file)).size > 16 * 1024 * 1024) reject('REFERENCE_INVALID', 'JSON 清单过大');
  try {return JSON.parse(await fs.readFile(file, 'utf8'));}
  catch {reject('REFERENCE_INVALID', `JSON 无效：${relative}`);}
}

export async function inventory(root) {
  const result = [];
  async function walk(relative = '') {
    const entries = await fs.readdir(path.join(root, relative), {withFileTypes: true});
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      relativePath(next);
      if (entry.isSymbolicLink()) reject('REFERENCE_INVALID', '资源包不能含符号链接');
      if (entry.isDirectory()) await walk(next);
      else result.push(await artifact(root, next, 'package-member'));
    }
  }
  await walk();
  return result;
}

export async function writeJson(file, value) {
  await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', {flag: 'wx'});
}
