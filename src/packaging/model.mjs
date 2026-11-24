import * as fs from 'node:fs/promises';
import path from 'node:path';
import {json, regular, relativePath, reject} from './files.mjs';

/** Structural closure only; decoding Cubism and judging art require the native host. */
export async function inspectModel(root, modelPath) {
  relativePath(modelPath);
  if (!modelPath.endsWith('.model3.json')) reject('REFERENCE_INVALID', '模型入口必须是 model3.json');
  const model = await json(root, modelPath), refs = model.FileReferences;
  if (model.Version !== 3 || !refs || typeof refs !== 'object') reject('REFERENCE_INVALID', '模型索引必须为 Cubism model3 v3');
  const allowed = new Set(['Moc', 'Textures', 'Physics', 'Pose', 'DisplayInfo', 'UserData', 'Expressions', 'Motions']);
  for (const key of Object.keys(refs)) if (!allowed.has(key)) reject('REFERENCE_INVALID', `尚未支持的运行引用：${key}`);
  const directory = path.posix.dirname(modelPath), files = new Set([modelPath]);
  const resolve = value => {
    relativePath(value);
    return directory === '.' ? value : `${directory}/${value}`;
  };
  async function read(reference, kind) {
    const name = resolve(reference), file = await regular(root, name);
    if (!(await fs.stat(file)).size) reject('REFERENCE_INVALID', `运行资源为空：${name}`);
    if (kind === 'json') await json(root, name);
    if (kind === 'moc' || kind === 'png') {
      const handle = await fs.open(file, 'r');
      try {
        const header = Buffer.alloc(8); await handle.read(header, 0, 8, 0);
        if (kind === 'moc' && header.subarray(0, 4).toString() !== 'MOC3' ||
            kind === 'png' && !header.equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
          reject('REFERENCE_INVALID', `运行资源格式不符：${name}`);
        }
      } finally {await handle.close();}
    }
    files.add(name); return name;
  }
  await read(refs.Moc, 'moc');
  if (!Array.isArray(refs.Textures) || !refs.Textures.length) reject('REFERENCE_INVALID', '模型缺少图集索引');
  for (const texture of refs.Textures) await read(texture, 'png');
  for (const key of ['Physics', 'Pose', 'DisplayInfo', 'UserData']) if (refs[key] !== undefined) await read(refs[key], 'json');
  const expressions = [], motions = [];
  if (refs.Expressions !== undefined && !Array.isArray(refs.Expressions)) reject('REFERENCE_INVALID', '表情索引无效');
  for (const [index, item] of (refs.Expressions ?? []).entries()) {
    if (!item || typeof item.Name !== 'string' || !item.Name) reject('REFERENCE_INVALID', '表情名称缺失');
    const file = await read(item.File, 'json');
    expressions.push({name: item.Name, file, leafId: String(index)});
  }
  if (refs.Motions !== undefined && (!refs.Motions || typeof refs.Motions !== 'object' || Array.isArray(refs.Motions))) reject('REFERENCE_INVALID', '动作索引无效');
  for (const [group, items] of Object.entries(refs.Motions ?? {})) {
    if (!Array.isArray(items)) reject('REFERENCE_INVALID', '动作分组无效');
    for (const [index, item] of items.entries()) {
      const file = await read(item.File, 'json');
      if (item.Sound !== undefined) await read(item.Sound, 'sound');
      motions.push({group, index, file, leafId: `${group}:${index}`});
    }
  }
  return {modelPath, directory, display: refs.DisplayInfo && resolve(refs.DisplayInfo), physics: refs.Physics && resolve(refs.Physics), files: [...files].sort(), expressions, motions};
}
