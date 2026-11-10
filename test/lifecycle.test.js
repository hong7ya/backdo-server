const { assert } = require("chai");
const { once } = require("node:events");
const { existsSync } = require("node:fs");
const { mkdtemp, realpath, readFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { startServer } = require("../app");
const { InspectorConnection } = require("../services/InspectorConnection");
const { terminateProcess } = require("../services/NodeRuntime");
const {
  requestJSON,
  requestRestart,
  launchNode,
  pauseAtStart,
  resumeToNextPause,
  waitForExit,
  readLaunchContext,
  findBreakableLocations,
  evaluateInCallFrame,
} = require("./helpers");

describe("실제 Node 대상의 재시작과 측정", () => {
  let server;
  let directory;
  let original;
  let connections;

  beforeEach(async () => {
    server = undefined;
    directory = undefined;
    original = undefined;
    connections = [];
    directory = await mkdtemp(path.join(tmpdir(), "backdo-server-"));
    directory = await realpath(directory);
    server = await startServer({ port: 0 });
  });

  for (const extension of ["cjs", "mjs"]) {
    it(`${extension}: 정지한 원본을 종료하고 같은 실행 조건과 포트로 새 Node에 연결한다`, async () => {
      const executionLog = path.join(directory, "실행 기록.txt");
      const args = [executionLog, "공백 있는 값", "", "--name"];
      const env = {
        FIRST: "첫 값",
        SECOND: "다른 값",
        BACKDO_RESTORE_CONTEXT: "원래 사용자 값",
      };
      original = await launchNode({
        directory,
        filename: `공백 있는 진입점.${extension}`,
        source: `const fs = process.getBuiltinModule('fs');
const executionLog = process.argv[2];
fs.appendFileSync(executionLog, '진입\\n');
debugger;
fs.appendFileSync(executionLog, '종료 뒤 실행\\n');
setInterval(() => {}, 1000);`,
        args,
        env,
        execArgv: ["--stack-trace-limit=42"],
        argv0: "backdo-test-node",
      });
      const { session, client: originalDebugger } =
        await registerNodePausedAtStart(original.port);
      const originalContext = await readLaunchContext(originalDebugger);
      assert.deepEqual(originalContext.argv, [
        process.execPath,
        original.entry,
        ...args,
      ]);
      // 운영체제가 시작 시 추가하는 키도 아래 재시작 전후 전체 비교에는 포함한다.
      assert.include(originalContext.env, env);
      assert.strictEqual(originalContext.cwd, directory);

      // --inspect-brk의 시작 정지에서 소스의 debugger 문까지 실행한다.
      await resumeToNextPause(originalDebugger);

      assert.strictEqual(await readFile(executionLog, "utf8"), "진입\n");

      const restart = await requestRestart(server.origin, {
        sessionId: session.id,
        ws: session.ws,
      });

      assert.strictEqual(restart.status, 200, JSON.stringify(restart.body));
      const restartedTarget = restart.body;
      // teardown이 종료한 결과를 제품의 재시작 성공으로 오인하지 않는다.
      await waitForExit(original.child);
      assert.throws(() => process.kill(original.child.pid, 0), /ESRCH/);
      assert.notStrictEqual(restartedTarget.pid, original.child.pid);
      assert.notStrictEqual(restartedTarget.ws, session.ws);
      assert.strictEqual(restartedTarget.port, original.port);
      assert.strictEqual(
        await readFile(executionLog, "utf8"),
        "진입\n",
        "종료 과정에서 정지 이후 코드가 실행되면 안 된다"
      );

      const restartedDebugger = connect(restartedTarget.ws);
      await pauseAtStart(restartedDebugger);
      const restartedContext = await readLaunchContext(restartedDebugger);

      assert.deepEqual(restartedContext, {
        ...originalContext,
        pid: restartedTarget.pid,
        execArgv: [
          `--inspect-brk=127.0.0.1:${original.port}`,
          "--stack-trace-limit=42",
        ],
      });
      assert.strictEqual(restartedContext.argv0, "backdo-test-node");
      assert.strictEqual(await readFile(executionLog, "utf8"), "진입\n");

      const stale = await requestRestart(server.origin, {
        sessionId: session.id,
        ws: session.ws,
      });

      assert.strictEqual(stale.status, 400);
      assert.include(stale.body.error, "대상 주소가 바뀌었거나");
      const current = await requestJSON(
        server.origin,
        `/sessions/${session.id}`
      );
      assert.strictEqual(current.status, 200);
      assert.include(current.body, {
        ws: restartedTarget.ws,
        pid: restartedTarget.pid,
        restarts: 1,
      });
      assert.strictEqual(
        (await readLaunchContext(restartedDebugger)).pid,
        restartedTarget.pid
      );
    });
  }

  it("별도 프로세스에서 CDP를 측정하고 종료해도 사용자 코드와 정지는 유지된다", async () => {
    const executionLog = path.join(directory, "user-code.txt");
    original = await launchNode({
      directory,
      source: `process.getBuiltinModule('fs').writeFileSync(process.argv[2], '실행됨');
setInterval(() => {}, 1000);`,
      args: [executionLog],
    });
    const {
      session,
      client: originalDebugger,
      startupPause,
    } = await registerNodePausedAtStart(original.port);
    const endpoint = `/sessions/${session.id}/calibrations/11111111-2222-3333-4444-555555555555`;

    const created = await requestJSON(server.origin, endpoint, {
      method: "POST",
      body: {},
    });
    assert.strictEqual(created.status, 200, JSON.stringify(created.body));
    assert.notStrictEqual(Number(new URL(created.body.ws).port), original.port);
    const measurementDebugger = connect(created.body.ws);

    const locations = await findBreakableLocations(
      measurementDebugger,
      "const value = 1;"
    );

    assert.isNotEmpty(locations);

    const [, disposed] = await Promise.all([
      once(measurementDebugger, "closed", {
        signal: AbortSignal.timeout(10_000),
      }),
      requestJSON(server.origin, endpoint, { method: "DELETE" }),
    ]);
    assert.strictEqual(disposed.status, 204);
    // 같은 call frame에서 평가할 수 있어야 원래 정지도 유지된 것이다.
    const pausedPid = await evaluateInCallFrame(
      originalDebugger,
      startupPause.callFrames[0].callFrameId,
      "process.pid"
    );

    assert.strictEqual(pausedPid, original.child.pid);
    assert.isFalse(
      existsSync(executionLog),
      "측정 중 사용자 코드가 실행되면 안 된다"
    );
  });

  afterEach(async () => {
    // 원본은 테스트가, 교체·측정 대상은 서버가 소유한다.
    // 연결 해제로 사용자 코드가 재개되지 않도록 프로세스를 먼저 종료한다.
    const errors = [];
    const steps = [
      () => original && terminateProcess(original.child.pid, original.child),
      () => server?.close(),
      ...connections.map((client) => () => client.close()),
      () => directory && rm(directory, { recursive: true, force: true }),
    ];
    for (const close of steps) {
      try {
        await close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) {
      throw new AggregateError(errors, "서버 테스트 자원 정리 실패");
    }
  });

  function connect(ws) {
    const client = new InspectorConnection(ws);
    connections.push(client);
    return client;
  }

  async function registerNodePausedAtStart(port) {
    const registered = await requestJSON(server.origin, "/sessions", {
      method: "POST",
      body: { port, kind: "node" },
    });
    assert.strictEqual(registered.status, 200, JSON.stringify(registered.body));
    const session = registered.body;
    const client = connect(session.ws);
    const startupPause = await pauseAtStart(client);
    const ready = await requestJSON(
      server.origin,
      `/sessions/${session.id}?ready=true`
    );
    assert.strictEqual(ready.status, 200, JSON.stringify(ready.body));
    return { session, client, startupPause };
  }
});
