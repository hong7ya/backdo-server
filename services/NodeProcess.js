const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const { InspectorConnection } = require('./InspectorConnection');

// 인자와 환경변수는 전체를 복사한다. 값은 서버 메모리에만 두며 HTTP 응답이나 로그로 보내지 않는다.
const LAUNCH_INFORMATION = `({
  pid: process.pid, execPath: process.execPath, argv0: process.argv0,
  argv: [...process.argv], execArgv: [...process.execArgv], cwd: process.cwd(),
  env: {...process.env}, umask: process.umask(),
  uid: process.geteuid?.(), gid: process.getegid?.()
})`;

class NodeProcess {
  #connection;
  #information;
  #child;
  #ready;
  #resolveReady;
  #rejectReady;
  #capturing = false;

  constructor(ws, information, child) {
    this.ws = ws;
    this.port = Number(new URL(ws).port);
    this.#information = information;
    this.#child = child;
    this.#ready = new Promise((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    // 첫 정지 전 연결 실패도 처리하되, 준비 요청에는 원래 실패를 전달한다.
    void this.#ready.catch(() => {});
  }

  get pid() { return this.#information?.pid ?? this.#child?.pid; }
  get readyToRestart() { return this.#capturing && Boolean(this.#information); }
  get executable() { return this.#information?.execPath; }
  get ready() { return this.#ready; }

  async connect() {
    this.#connection = new InspectorConnection(this.ws);
    this.#connection.on('closed', () => this.#rejectReady(new Error('실행 정보 조회 전에 대상이 종료되었습니다.')));
    this.#connection.on('Debugger.paused', () => {
      if (this.#capturing) return;
      this.#capturing = true;
      void this.#capture().then(this.#resolveReady, this.#rejectReady);
    });
    try {
      await this.#connection.request('Runtime.enable');
      await this.#connection.request('Debugger.enable');
      return this;
    } catch (error) {
      await this.#connection.close();
      throw error;
    }
  }

  async #capture() {
    if (this.#information) return;
    const response = await this.#connection.request('Runtime.evaluate', {
      expression: LAUNCH_INFORMATION, returnByValue: true, silent: true,
    });
    const value = response.result?.value;
    if (response.exceptionDetails || !value || !Number.isInteger(value.pid) || value.pid <= 1 ||
        value.pid === process.pid || !path.isAbsolute(value.execPath) || !path.isAbsolute(value.cwd) ||
        !Array.isArray(value.argv) || !value.argv.every(item => typeof item === 'string') ||
        !Array.isArray(value.execArgv) || !value.execArgv.every(item => typeof item === 'string') ||
        !value.env || Object.values(value.env).some(item => typeof item !== 'string')) {
      throw new Error('Node의 실행 정보를 조회하지 못했습니다. 최초 정지에서 연결해 주세요.');
    }
    this.#information = value;
  }

  async restart() {
    await this.ready;
    // 연결을 먼저 끊으면 정지 중인 Node가 재개된다. 살아 있는 연결로 PID를 확인한 뒤 프로세스부터 종료한다.
    const identity = await this.#connection.request('Runtime.evaluate', {
      expression: 'process.pid', returnByValue: true, silent: true, throwOnSideEffect: true,
    });
    if (identity.result?.value !== this.pid) throw new Error('재시작 대상의 PID가 변경되었습니다.');
    const information = this.#information;
    await this.stop();
    const args = restartArguments(information.execArgv, this.port);
    const bootstrap = path.join(__dirname, 'RestoreLaunchContext.js');
    const child = await launchNode(information.execPath,
      ['--require', bootstrap, ...args, ...information.argv.slice(1)], {
        cwd: information.cwd,
        // 전달 키가 이미 있으면 부트스트랩에서 원래 값까지 복구한다.
        env: { ...information.env, BACKDO_RESTORE_CONTEXT: JSON.stringify({ umask: information.umask, previous: information.env.BACKDO_RESTORE_CONTEXT }) },
        argv0: information.argv0, uid: information.uid, gid: information.gid,
      });
    const next = new NodeProcess(child.ws, { ...information, pid: child.process.pid }, child.process);
    try {
      await next.connect();
      return next;
    } catch (error) {
      await next.stop();
      throw error;
    }
  }

  async stop() {
    if (!this.pid) return;
    await terminateProcess(this.pid, this.#child);
    await this.#connection?.close();
  }

  async release() {
    await this.#connection?.close();
    this.#information = undefined;
  }
}

function restartArguments(original, port) {
  const args = [];
  for (let index = 0; index < original.length; index++) {
    const argument = original[index];
    if (/^--inspect(?:-brk|-wait|-port)?(?:=|$)/.test(argument)) {
      if (argument === '--inspect-port' && original[index + 1] && !original[index + 1].startsWith('-')) index++;
      continue;
    }
    args.push(argument);
  }
  return [`--inspect-brk=127.0.0.1:${port}`, ...args];
}

async function launchNode(executable, args, options = {}) {
  const child = spawn(executable, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  // 재시작된 프로그램의 출력은 서버 터미널로 전달한다. 기존 터미널의 핸들은 복제하지 않는다.
  child.stdout.pipe(process.stdout, { end: false });
  let starting = true;
  child.stderr.on('data', chunk => { if (!starting) process.stderr.write(chunk); });
  try {
    const ws = await new Promise((resolve, reject) => {
      let text = '';
      const finish = (error, address) => {
        clearTimeout(timeout);
        child.stderr.off('data', onData);
        child.off('error', onError);
        child.off('exit', onExit);
        error ? reject(error) : resolve(address);
      };
      const onError = () => finish(new Error('Node 프로세스를 시작하지 못했습니다.'));
      const onExit = () => finish(new Error('디버거 준비 전에 Node 프로세스가 종료되었습니다.'));
      const onData = chunk => {
        text = (text + String(chunk)).slice(-8192);
        const match = text.match(/Debugger listening on (ws:\/\/[^\s]+)/);
        if (match) finish(null, match[1]);
      };
      const timeout = setTimeout(() => finish(new Error('Node 디버거 시작 대기 시간이 지났습니다.')), 10_000);
      child.stderr.on('data', onData);
      child.once('error', onError);
      child.once('exit', onExit);
    });
    starting = false;
    return { ws, process: child };
  } catch (error) {
    if (child.pid) await terminateProcess(child.pid, child);
    throw error;
  }
}

async function terminateProcess(pid, child) {
  if (child && (child.exitCode !== null || child.signalCode !== null)) return;
  try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) return;
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  if (child && child.exitCode === null && child.signalCode === null) await once(child, 'exit');
  const killedDeadline = Date.now() + 5000;
  while (Date.now() < killedDeadline) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('기존 Node 프로세스의 종료를 확인하지 못했습니다.');
}

module.exports = { NodeProcess, launchNode, terminateProcess };
