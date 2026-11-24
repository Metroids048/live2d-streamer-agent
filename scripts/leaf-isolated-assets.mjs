import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {brotliDecompressSync} from 'node:zlib';

// Renderer resources from the notarized macOS 1.3.1 arm64 release. Read them in memory.
export const stagePath='/assets/frame-loop-D_ViqMgU.js';
const expected = {
  [stagePath]:'1f6a275d736d55db6f6736233a23469a17768385a0cc5edf4f0596d0528bb097',
  '/assets/event-L1QSropA.js':'1d8aeddddb2691f9db407d640cc8c9dc0b633ca17990c53323daef835a66d689',
  '/assets/i18n-CsZDD26x.js':'53da8cc1667b2ef7241c3f55a40a4db0ee47e0c7055867f355003d318e491665',
  '/assets/cubism4.es-Clqtf-mN.js':'9e0435e008487729b76790dcaf97abc1c1bf8d8c3ab218ff4bfc70798e45000e',
  '/runtime/live2dcubismcore.min.js':'25ae938cb4fe282ce189b357bcc97e603d1e1f7ec78bf04150d401c23cdc792f',
  '/assets/preload-helper-BXl3LOEh.js':'d887044e7c17fd90344fc4f74f53cac686584daf2a458ab2136d36f1946e9ab6',
};

export async function readInstalledRenderer() {
  const app='/Applications/VTubeLeaf.app/Contents';
  const plist=await fs.readFile(app+'/Info.plist','utf8');
  if (!/<key>CFBundleShortVersionString<\/key>\s*<string>1\.3\.1<\/string>/.test(plist)) throw Error('需要本机 macOS VTubeLeaf 1.3.1');
  const binary=await fs.readFile(app+'/MacOS/VTubeLeaf');
  if(binary.readUInt32BE(0)!==0xcafebabe) throw Error('版本不匹配：需要包含 arm64 的通用二进制');
  let arm;
  for(let i=0;i<binary.readUInt32BE(4);i++){
    const k=8+i*20, at=binary.readUInt32BE(k+8);
    if(binary.readUInt32BE(k)===0x0100000c) arm=binary.subarray(at,at+binary.readUInt32BE(k+12));
  }
  if(!arm) throw Error('安装包缺少 arm64 切片');
  const files=new Map();
  for(const [name,hash] of Object.entries(expected)){
    // The Mach-O chained pointer stores the file offset in its lower 32 bits.
    // PHF entries store (name pointer, name length, compressed data pointer, data length).
    const at=arm.indexOf(name), pointer=Buffer.alloc(4);
    if(at<0) throw Error('发布资源缺失 '+name);
    pointer.writeUInt32LE(at);
    for(let k=arm.indexOf(pointer); k>=0 && k+32<=arm.length; k=arm.indexOf(pointer,k+1)){
      if(arm.readBigUInt64LE(k+8)!==BigInt(name.length)) continue;
      const offset=arm.readUInt32LE(k+16), length=Number(arm.readBigUInt64LE(k+24));
      if(offset!==at+name.length || length<1 || length>2_000_000 || offset+length>arm.length) continue;
      const js=brotliDecompressSync(arm.subarray(offset,offset+length),{maxOutputLength:2_000_000});
      if(createHash('sha256').update(js).digest('hex')!==hash) throw Error('发布资源 SHA256 不符 '+name);
      files.set(name,js); break;
    }
    if(!files.has(name)) throw Error('无法定位发布资源 '+name);
  }
  return {files, hashes:expected};
}
