import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

const revision = '5cdca0d6f45b7db05c56423d906382cae95603df';
const repository = 'https://github.com/moonrailgun/vtubeleaf';
const evidence = (file, lines, note) => ({file, lines, note,
  url: `${repository}/blob/${revision}/${file}#L${lines[0]}`});

// Source-reviewed v1.3.1 capabilities, not observations of the active avatar.
const reviewed = {
  importModel: {status: 'supported', method: 'local_ui', evidence: evidence('src-tauri/src/models.rs', [971, 1071], 'model3 v3 + relative Moc/Textures/Physics/Expressions/Motions copied into private library')},
  reopen: {status: 'supported', method: 'local_ui', evidence: evidence('src/state.ts', [645, 664], 'Per-model profile storage and switch; settings load/save in lib.rs 92-127; actual candidate reopen not_run')},
  parameterRead: {status: 'supported', method: 'in_app_only', evidence: evidence('src/renderer.ts', [437, 502], 'Core parameter access is in the renderer; no external parameter RPC')},
  parameterWrite: {status: 'supported', method: 'local_ui', evidence: evidence('src/studio.ts', [1316, 1326], 'UI setParameterOverride clamps native parameters; not VTS Public API')},
  expressions: {status: 'supported', method: 'local_ui_or_hotkey', evidence: evidence('src/renderer.ts', [253, 270], 'Native expressions use numeric index IDs; VTS-only resources use vts:<file>')},
  scopedExpressionToggle: {status: 'supported', method: 'local_ui_or_hotkey', evidence: evidence('src/renderer.ts', [957, 988], 'toggleExpression(id) enables or releases that expression layer without clearing other IDs')},
  motions: {status: 'supported', method: 'local_ui_or_hotkey', evidence: evidence('src/renderer.ts', [865, 908], 'Native motion IDs are <group>:<index>; once/loop/hold')},
  expressionReset: {status: 'supported', method: 'local_ui_or_hotkey', evidence: evidence('src/renderer.ts', [990, 1001], 'Clear expression layers; not a cross-session baseline restore API')},
  stateRestore: {status: 'supported', method: 'local_ui', evidence: evidence('src/studio.ts', [1327, 1340], 'Restore saved default appearance in current model UI; not Agent session/model/hash baseline isolation')},
  inputMapping: {status: 'supported', method: 'local_ui', evidence: evidence('src/state.ts', [710, 742], 'Default mouthSmile drives ParamMouthForm; advanced visemes not implied')},
  publicControlApi: {status: 'unsupported', method: null, evidence: evidence('src-tauri/src/lib.rs', [743, 783], 'Tauri invoke is internal; registered commands do not expose external avatar parameter/expression/motion RPC')},
  agentBaselineRestore: {status: 'unsupported', method: null, evidence: evidence('src/renderer.ts', [990, 1001], 'UI clear is not an Agent-owned session/model/hash baseline protocol')},
  vbridgerProfile: {status: 'unknown', method: null, evidence: evidence('src/vts.ts', [92, 123], 'VTS config importer is present; a .vbridger file is not a verified Leaf profile')},
};

export const defaultLeafInputMap = Object.freeze({
  ParamAngleX: 'yaw', ParamAngleY: 'pitch', ParamAngleZ: 'roll',
  ParamEyeLOpen: 'eyeLeft', ParamEyeROpen: 'eyeRight',
  ParamMouthOpenY: 'mouthOpen', ParamMouthForm: 'mouthSmile',
  ParamEyeLSmile: 'mouthSmile', ParamEyeRSmile: 'mouthSmile',
  ParamEyeBallX: 'gazeX', ParamEyeBallY: 'gazeY',
  ParamBrowLY: 'browLeft', ParamBrowRY: 'browRight', ParamMouthX: 'mouthX',
  ParamBodyAngleX: 'bodyYaw', ParamBodyAngleY: 'bodyPitch', ParamBodyAngleZ: 'bodyRoll',
});

/** Reads installation metadata only. Never starts Leaf, reads a profile, or sends IPC. */
export async function inspectLeafCapability(ctx = {}) {
  ctx.signal?.throwIfAborted();
  const appPath = ctx.leafAppPath ?? '/Applications/VTubeLeaf.app';
  let version = null, installed = false;
  try {
    const plist = await fs.readFile(path.join(appPath, 'Contents/Info.plist'), 'utf8');
    installed = true;
    version = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)?.[1] ?? null;
  } catch (error) {if (error.code !== 'ENOENT') throw error;}
  const matches = installed && version === '1.3.1';
  const capabilities = structuredClone(reviewed);
  if (!matches) for (const item of Object.values(capabilities)) {
    item.reviewedStatus = item.status;
    item.status = 'unknown';
  }
  let sourceVerification = {status: 'source_review_snapshot', revision, installedBinaryMatch: 'not_verified'};
  if (ctx.leafSourceRoot) {
    // Optional read-only verification of the fixed source receipt, not a live API probe.
    const rawReceipt = await fs.readFile(path.join(ctx.leafSourceRoot, 'source-receipt.json'));
    if (createHash('sha256').update(rawReceipt).digest('hex') !== 'c8317bc2b66195df5f2bcc308f0c0c3326e26f7404c503107adedd8b630b4301') throw new Error('Unrecognized Leaf source receipt');
    const receipt = JSON.parse(rawReceipt.toString('utf8'));
    const files = [];
    for (const source of receipt) {
      if (path.isAbsolute(source.path) || source.path.split(/[\\/]/).some(p => p === '..')) throw new Error('Invalid Leaf source receipt');
      const data = await fs.readFile(path.join(ctx.leafSourceRoot, source.path));
      const sha256 = createHash('sha256').update(data).digest('hex');
      if (sha256 !== source.sha256) throw new Error('Leaf source receipt hash mismatch');
      files.push({path: source.path, sha256, bytes: data.length});
    }
    sourceVerification = {...sourceVerification, status: 'snapshot_hashes_verified', files};
  }
  return {
    runtime: 'VTubeLeaf', installed, version, reviewedVersion: '1.3.1',
    repository, revision, sourceVerification, capabilities,
    importLimits: matches ? {fileBytes: 128 * 1024 * 1024, totalBytes: 512 * 1024 * 1024, entries: 2048} : null,
    defaultInputMap: matches ? defaultLeafInputMap : {},
    verification: {candidateLoaded: 'not_run', nativeReopen: 'not_run',
      expressionsAndReset: 'not_run', liveTracking: 'not_run', latency: 'not_run',
      obsBilibili: 'not_run', userAcceptance: 'not_run'},
    warnings: ['能力来自固定源码核查，不等于新候选运行通过。',
      '现有 VTS adapter 不支持 Leaf；本模块不提供远程控制，也不改写活动模型或 profile。',
      'MouthForm 默认来源为 mouthSmile；不代表支持 A/I/U/E/O、舌头或 VBridger 高级输入。'],
  };
}
