import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {inspectLeafCapability, defaultLeafInputMap} from '../src/runtime/leaf/index.mjs';

async function installation(t, version) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leaf-readonly-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const app = path.join(root, 'VTubeLeaf.app'); await fs.mkdir(path.join(app, 'Contents'), {recursive: true});
  await fs.writeFile(path.join(app, 'Contents/Info.plist'), `<plist><key>CFBundleShortVersionString</key><string>${version}</string></plist>`);
  await fs.writeFile(path.join(root, 'settings-sentinel.json'), JSON.stringify({model: 'active-r02', camera: false, session: 'other-session'}));
  return {root, app};
}

test('只读源码能力与真实运行分层；无控制与恢复冒充', async t => {
  const f = await installation(t, '1.3.1');
  const before = await fs.readFile(path.join(f.root, 'settings-sentinel.json'));
  const report = await inspectLeafCapability({leafAppPath: f.app, sessionId: 'new-session', modelId: 'new-model'});
  assert.equal(report.capabilities.importModel.status, 'supported');
  assert.equal(report.capabilities.parameterWrite.method, 'local_ui');
  assert.equal(report.capabilities.publicControlApi.status, 'unsupported');
  assert.equal(report.capabilities.agentBaselineRestore.status, 'unsupported');
  assert.equal(report.sourceVerification.installedBinaryMatch, 'not_verified');
  assert.ok(Object.values(report.verification).every(value => value === 'not_run'));
  assert.equal(report.defaultInputMap.ParamMouthForm, 'mouthSmile');
  assert.equal(report.defaultInputMap.ParamMouthOpenY, 'mouthOpen');
  assert.ok(!('ParamMouthA' in defaultLeafInputMap));
  assert.equal(report.importLimits.fileBytes, 128 * 1024 ** 2);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'settings-sentinel.json')), before);
  const other = await inspectLeafCapability({leafAppPath: f.app, sessionId: 'other', modelId: 'other'});
  assert.deepEqual(other, report); // No session/model control state is created or shared.
});

test('缺应用或非核查版本时不能继承supported断言', async t => {
  const f = await installation(t, '9.9.9');
  for (const app of [f.app, path.join(f.root, 'missing.app')]) {
    const report = await inspectLeafCapability({leafAppPath: app});
    assert.ok(Object.values(report.capabilities).every(value => value.status === 'unknown'));
    assert.equal(report.importLimits, null); assert.deepEqual(report.defaultInputMap, {});
  }
});

test('只接受固定提交的已核源码收据；取消不触发副作用', async t => {
  const f = await installation(t, '1.3.1');
  await fs.writeFile(path.join(f.root, 'source-receipt.json'), '[]');
  await assert.rejects(inspectLeafCapability({leafAppPath: f.app, leafSourceRoot: f.root}), /Unrecognized/);
  await assert.rejects(inspectLeafCapability({signal: AbortSignal.abort()}), {name: 'AbortError'});
});
