const { assert } = require('chai');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdtemp, writeFile, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { startServer } = require('../app');
const { InspectorConnection } = require('../services/InspectorConnection');
const { terminateProcess } = require('../services/NodeRuntime');

const children = new Set();
const connections = new Set();
let directory;
let server;

async function api(route, method = 'GET', body) {
  const response = await fetch(`${server.origin}${route}`, {
    method, headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
}

async function launchFixture(extension = 'cjs') {
  const marker = path.join(directory, '실행 기록.txt');
  const entry = path.join(directory, `공백 있는 진입점.${extension}`);
  await writeFile(entry, `process.getBuiltinModule('fs').appendFileSync(process.argv[2], '진입\\n');\ndebugger;\nprocess.getBuiltinModule('fs').appendFileSync(process.argv[2], '종료 뒤 실행\\n');\nsetInterval(() => {}, 1000);`);
  const args = ['--inspect-brk=127.0.0.1:0', '--stack-trace-limit=42', entry, marker, '공백 있는 값', '', '--name'];
  const env = { FIRST: '첫 값', SECOND: '다른 값', BACKDO_RESTORE_CONTEXT: '원래 사용자 값' };
  const child = spawn(process.execPath, args, { cwd: directory, env, argv0: 'backdo-test-node', stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  const ws = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stderr.on('data', chunk => {
      const match = String(chunk).match(/Debugger listening on (ws:\/\/[^\s]+)/);
      if (match) resolve(match[1]);
    });
  });
  return { child, ws, port: Number(new URL(ws).port), marker, args, env };
}

async function attach(ws) {
  const client = new InspectorConnection(ws);
  connections.add(client);
  const paused = once(client, 'Debugger.paused');
  await client.request('Runtime.enable');
  await client.request('Debugger.enable');
  await client.request('Runtime.runIfWaitingForDebugger');
  await paused;
  return client;
}

async function values(client) {
  const response = await client.request('Runtime.evaluate', {
    expression: '({argv:[...process.argv], execArgv:[...process.execArgv], cwd:process.cwd(), env:{...process.env}, argv0:process.argv0, execPath:process.execPath, umask:process.umask(), uid:process.geteuid?.(), gid:process.getegid?.()})',
    returnByValue: true, silent: true,
  });
  assert.isUndefined(response.exceptionDetails);
  return response.result.value;
}

describe('포트만 받는 실제 서버 연동', function() {
  this.timeout(30_000);
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'backdo-server-'));
    server = await startServer({ port: 0 });
  });
  afterEach(async () => {
    // 테스트가 만든 원래 프로세스도 연결 해제 전에 종료한다.
    for (const child of children) await terminateProcess(child.pid, child);
    await server?.close();
    for (const connection of connections) await connection.close();
    children.clear();
    connections.clear();
    await rm(directory, { recursive: true, force: true });
  });

  for (const extension of ['cjs', 'mjs']) {
    it(`${extension} 실행 정보를 ws로 읽고 환경 전체를 유지하여 같은 포트에 재시작한다`, async () => {
      const fixture = await launchFixture(extension);
      const registered = await api('/sessions', 'POST', { port: fixture.port, kind: 'node' });
      assert.strictEqual(registered.status, 200);
      const session = registered.body;
      const client = await attach(session.ws);
      assert.strictEqual((await api(`/sessions/${session.id}?ready=true`)).status, 200);
      const before = await values(client);
      assert.include(before.env, fixture.env);
      assert.notProperty(session, 'env');
      const sourcePause = once(client, 'Debugger.paused');
      await client.request('Debugger.resume');
      await sourcePause;
      assert.strictEqual(await readFile(fixture.marker, 'utf8'), '진입\n');

      const response = await api(`/sessions/${session.id}/restart`, 'POST', { ws: session.ws });
      assert.strictEqual(response.status, 200, JSON.stringify(response.body));
      const next = response.body;
      assert.notStrictEqual(next.pid, fixture.child.pid);
      assert.notStrictEqual(next.ws, session.ws);
      assert.strictEqual(next.port, fixture.port);
      assert.strictEqual(await readFile(fixture.marker, 'utf8'), '진입\n', '종료 전에 ws를 끊어 뒷부분을 실행하면 안 된다');
      const restarted = await attach(next.ws);
      const after = await values(restarted);
      assert.deepEqual(after.argv, before.argv);
      assert.deepEqual(after.env, before.env, '환경변수 일부만 추리거나 내부 전달 키를 남기면 안 된다');
      assert.strictEqual(after.cwd, before.cwd);
      assert.strictEqual(after.argv0, 'backdo-test-node');
      for (const key of ['execPath', 'umask', 'uid', 'gid']) assert.strictEqual(after[key], before[key], key);
      assert.deepEqual(after.execArgv, [`--inspect-brk=127.0.0.1:${fixture.port}`, '--stack-trace-limit=42']);
      assert.strictEqual((await api(`/sessions/${session.id}/restart`, 'POST', { ws: session.ws })).status, 400);
    });
  }

  it('더미를 실제 생성·측정·종료해도 사용자 정지와 실행 횟수는 유지한다', async () => {
    const fixture = await launchFixture();
    const { body: session } = await api('/sessions', 'POST', { port: fixture.port, kind: 'node' });
    const client = await attach(session.ws);
    await api(`/sessions/${session.id}?ready=true`);
    const endpoint = `/sessions/${session.id}/calibrations/11111111-2222-3333-4444-555555555555`;
    const created = await api(endpoint, 'POST', {});
    assert.strictEqual(created.status, 200);
    assert.notStrictEqual(Number(new URL(created.body.ws).port), fixture.port);
    const dummy = new InspectorConnection(created.body.ws);
    connections.add(dummy);
    await dummy.request('Runtime.enable');
    await dummy.request('Debugger.enable');
    const script = await dummy.request('Runtime.compileScript', {
      expression: 'const value = 1;', sourceURL: 'backdo-calibration:///test.js', persistScript: true,
    });
    assert.isAbove((await dummy.request('Debugger.getPossibleBreakpoints', {
      start: { scriptId: script.scriptId, lineNumber: 0 },
    })).locations.length, 0);
    await api(endpoint, 'DELETE');
    assert.strictEqual(server.manager.usage.calibrations, 0);
    assert.strictEqual(server.manager.usage.calibrationsCreated, 1);
    assert.strictEqual(server.manager.usage.calibrationsDisposed, 1);
    assert.strictEqual((await values(client)).argv[1], fixture.args[2]);
    assert.strictEqual(await readFile(fixture.marker, 'utf8').catch(() => ''), '');
    assert.strictEqual((await api(endpoint, 'DELETE')).status, 204);
  });

  it('첫 정지 전 측정·재시작 요청은 사용자 코드를 실행하지 않고 거절한다', async () => {
    const fixture = await launchFixture();
    const { body: session } = await api('/sessions', 'POST', { port: fixture.port, kind: 'node' });
    const result = await api(`/sessions/${session.id}/calibrations/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`, 'POST', {});
    assert.strictEqual(result.status, 400);
    assert.strictEqual((await api(`/sessions/${session.id}/restart`, 'POST', { ws: session.ws })).status, 400);
    assert.strictEqual(server.manager.usage.calibrations, 0);
    assert.strictEqual(await readFile(fixture.marker, 'utf8').catch(() => ''), '');
  });

  it('생성 중 취소된 더미도 남기지 않는다', async () => {
    const fixture = await launchFixture();
    const { body: session } = await api('/sessions', 'POST', { port: fixture.port, kind: 'node' });
    await attach(session.ws);
    await api(`/sessions/${session.id}?ready=true`);
    const endpoint = `/sessions/${session.id}/calibrations/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`;
    const creating = api(endpoint, 'POST', {});
    // 서버에 요청이 도착한 뒤 생성이 진행 중인 시점에 취소한다.
    while (!server.manager.usage.calibrations) await new Promise(resolve => setTimeout(resolve, 1));
    await api(endpoint, 'DELETE');
    await creating;
    assert.strictEqual(server.manager.usage.calibrations, 0);
    assert.strictEqual(server.manager.usage.calibrationsCreated, server.manager.usage.calibrationsDisposed);
  });

  it('임의 PID 종료와 다른 웹사이트의 프로세스 제어 요청을 거절한다', async () => {
    assert.strictEqual((await api('/ws/close', 'POST', { browserPID: process.pid })).status, 400);
    const response = await fetch(`${server.origin}/sessions`, {
      method: 'POST', headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' },
      body: JSON.stringify({ port: 9229, kind: 'node' }),
    });
    assert.strictEqual(response.status, 403);
  });
});
