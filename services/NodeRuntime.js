const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

const INSPECTOR_START_TIMEOUT_MS = 10_000;
const STARTUP_OUTPUT_LIMIT = 8192;
const TERMINATE_TIMEOUT_MS = 2000;
const KILL_TIMEOUT_MS = 5000;
const EXIT_POLL_INTERVAL_MS = 10;

async function launchNode(executable, args, options = {}) {
  const child = spawn(executable, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  // 재시작된 프로그램의 출력은 서버 터미널로 전달한다. 기존 터미널의 핸들은 복제하지 않는다.
  child.stdout.pipe(process.stdout, { end: false });
  let starting = true;
  child.stderr.on('data', chunk => {
    if (!starting) {
      process.stderr.write(chunk);
    }
  });

  try {
    const ws = await waitForInspectorAddress(child);
    starting = false;
    return { ws, process: child };
  } catch (error) {
    if (child.pid) {
      await terminateProcess(child.pid, child);
    }
    throw error;
  }
}

function waitForInspectorAddress(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => {
      finish(new Error('Node 디버거 시작 대기 시간이 지났습니다.'));
    }, INSPECTOR_START_TIMEOUT_MS);

    function finish(error, address) {
      clearTimeout(timeout);
      child.stderr.off('data', onData);
      child.off('error', onError);
      child.off('exit', onExit);
      if (error) {
        reject(error);
      } else {
        resolve(address);
      }
    }

    function onData(chunk) {
      output = (output + String(chunk)).slice(-STARTUP_OUTPUT_LIMIT);
      const match = output.match(/Debugger listening on (ws:\/\/[^\s]+)/);
      if (match) {
        finish(null, match[1]);
      }
    }

    function onError() {
      finish(new Error('Node 프로세스를 시작하지 못했습니다.'));
    }

    function onExit() {
      finish(new Error('디버거 준비 전에 Node 프로세스가 종료되었습니다.'));
    }

    child.stderr.on('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

async function terminateProcess(pid, child) {
  if (hasChildExited(child) || !signalProcess(pid, 'SIGTERM')) {
    return;
  }
  if (await waitForExit(pid, child, TERMINATE_TIMEOUT_MS)) {
    return;
  }

  signalProcess(pid, 'SIGKILL');
  // 강제 종료 뒤에도 같은 대기 상한을 적용한다. 자식이 있으면 해당 실행의 종료 상태를 우선한다.
  if (!await waitForExit(pid, child, KILL_TIMEOUT_MS)) {
    throw new Error('기존 Node 프로세스의 종료를 확인하지 못했습니다.');
  }
}

async function waitForExit(pid, child, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (hasChildExited(child) || !signalProcess(pid, 0)) {
      return true;
    }
    await delay(EXIT_POLL_INTERVAL_MS);
  }
  return false;
}

function hasChildExited(child) {
  return Boolean(child && (child.exitCode !== null || child.signalCode !== null));
}

function signalProcess(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

module.exports = { launchNode, terminateProcess };
