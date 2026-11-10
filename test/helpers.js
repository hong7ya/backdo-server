const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { writeFile } = require("node:fs/promises");
const path = require("node:path");
const { terminateProcess } = require("../services/NodeRuntime");

async function requestJSON(origin, route, { method = "GET", body } = {}) {
  const response = await fetch(`${origin}${route}`, {
    method,
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  return {
    status: response.status,
    body: response.status === 204 ? null : await response.json(),
  };
}

function requestRestart(origin, { sessionId, ws }) {
  return requestJSON(origin, `/sessions/${sessionId}/restart`, {
    method: "POST",
    body: { ws },
  });
}

async function launchNode({
  directory,
  filename = "entry.cjs",
  source,
  args = [],
  execArgv = [],
  env = {},
  argv0,
}) {
  const entry = path.join(directory, filename);
  await writeFile(entry, source);
  const child = spawn(
    process.execPath,
    ["--inspect-brk=127.0.0.1:0", ...execArgv, entry, ...args],
    { cwd: directory, env, argv0, stdio: ["ignore", "pipe", "pipe"] }
  );
  child.stdout.resume();
  try {
    const ws = await inspectorAddress(child);
    return { child, entry, ws, port: Number(new URL(ws).port) };
  } catch (error) {
    if (child.pid) {
      await terminateProcess(child.pid, child);
    }
    throw error;
  }
}

function inspectorAddress(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => finish(new Error(`Node 시작 시간 초과: ${output}`)),
      10_000
    );
    const onError = (error) => finish(error);
    const onExit = (code) =>
      finish(new Error(`Node 준비 전 종료 (${code}): ${output}`));
    const onData = (chunk) => {
      output = (output + String(chunk)).slice(-8192);
      const match = output.match(/Debugger listening on (ws:\/\/[^\s]+)/);
      if (match) {
        finish(null, match[1]);
      }
    };
    function finish(error, ws) {
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
      child.stderr.off("data", onData);
      error ? reject(error) : resolve(ws);
    }
    child.once("error", onError);
    child.once("exit", onExit);
    child.stderr.on("data", onData);
  });
}

async function waitForPause(client, action) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    // 명령 직후 오는 정지를 놓치지 않도록 먼저 구독한다.
    const [events] = await Promise.all([
      once(client, "Debugger.paused", { signal: controller.signal }),
      action(),
    ]);
    return events[0];
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function pauseAtStart(client) {
  return waitForPause(client, async () => {
    await client.request("Runtime.enable");
    await client.request("Debugger.enable");
    await client.request("Runtime.runIfWaitingForDebugger");
  });
}

function resumeToNextPause(client) {
  return waitForPause(client, () => client.request("Debugger.resume"));
}

async function waitForExit(child) {
  if (child.exitCode === null && child.signalCode === null) {
    await once(child, "exit", { signal: AbortSignal.timeout(10_000) });
  }
}

async function readLaunchContext(client) {
  const response = await client.request("Runtime.evaluate", {
    expression:
      "({pid:process.pid, argv:[...process.argv], execArgv:[...process.execArgv], cwd:process.cwd(), env:{...process.env}, argv0:process.argv0, execPath:process.execPath, umask:process.umask(), uid:process.geteuid?.(), gid:process.getegid?.()})",
    returnByValue: true,
    silent: true,
  });
  if (response.exceptionDetails) {
    throw new Error(
      `실행 조건 조회 실패: ${JSON.stringify(response.exceptionDetails)}`
    );
  }
  return response.result.value;
}

async function findBreakableLocations(client, source) {
  await client.request("Runtime.enable");
  await client.request("Debugger.enable");
  const { scriptId } = await client.request("Runtime.compileScript", {
    expression: source,
    sourceURL: "backdo-calibration:///test.js",
    persistScript: true,
  });
  const { locations } = await client.request(
    "Debugger.getPossibleBreakpoints",
    {
      start: { scriptId, lineNumber: 0 },
    }
  );
  return locations;
}

async function evaluateInCallFrame(client, callFrameId, expression) {
  const response = await client.request("Debugger.evaluateOnCallFrame", {
    callFrameId,
    expression,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    throw new Error(
      `정지 프레임 조회 실패: ${JSON.stringify(response.exceptionDetails)}`
    );
  }
  return response.result.value;
}

module.exports = {
  requestJSON,
  requestRestart,
  launchNode,
  pauseAtStart,
  resumeToNextPause,
  waitForExit,
  readLaunchContext,
  findBreakableLocations,
  evaluateInCallFrame,
};
