const path = require('node:path');
const { InspectorConnection } = require('./InspectorConnection');
const { launchNode, terminateProcess } = require('./NodeRuntime');

// 인자와 환경변수는 전체를 복사한다. 값은 서버 메모리에만 두며 HTTP 응답이나 로그로 보내지 않는다.
const LAUNCH_INFORMATION = `({
  pid: process.pid,
  execPath: process.execPath,
  argv0: process.argv0,
  argv: [...process.argv],
  execArgv: [...process.execArgv],
  cwd: process.cwd(),
  env: {...process.env},
  umask: process.umask(),
  uid: process.geteuid?.(),
  gid: process.getegid?.()
})
//# sourceURL=backdo-internal:///read-launch-information.js`;

/** 첫 정지에서 실행 정보를 읽고, 같은 실행 조건으로 Node를 교체한다. */
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

  get pid() {
    return this.#information?.pid ?? this.#child?.pid;
  }

  get readyToRestart() {
    return this.#capturing && Boolean(this.#information);
  }

  get executable() {
    return this.#information?.execPath;
  }

  get ready() {
    return this.#ready;
  }

  async connect() {
    this.#connection = new InspectorConnection(this.ws);
    this.#connection.on('closed', () => {
      this.#rejectReady(new Error('실행 정보 조회 전에 대상이 종료되었습니다.'));
    });
    this.#connection.on('Debugger.paused', () => this.#captureAtFirstPause());

    try {
      await this.#connection.request('Runtime.enable');
      await this.#connection.request('Debugger.enable');
      return this;
    } catch (error) {
      await this.#connection.close();
      throw error;
    }
  }

  async restart() {
    await this.ready;
    await this.#verifyProcessIdentity();
    const information = this.#information;

    // 연결을 먼저 끊으면 정지 중인 Node가 재개된다. 반드시 프로세스부터 종료한다.
    await this.stop();
    const next = await this.#launchReplacement(information);
    try {
      await next.connect();
      return next;
    } catch (error) {
      await next.stop();
      throw error;
    }
  }

  async stop() {
    if (!this.pid) {
      return;
    }
    await terminateProcess(this.pid, this.#child);
    await this.#connection?.close();
  }

  async release() {
    await this.#connection?.close();
    this.#information = undefined;
  }

  #captureAtFirstPause() {
    if (this.#capturing) {
      return;
    }
    this.#capturing = true;
    void this.#captureLaunchInformation().then(this.#resolveReady, this.#rejectReady);
  }

  async #captureLaunchInformation() {
    if (this.#information) {
      return;
    }
    const response = await this.#connection.request('Runtime.evaluate', {
      expression: LAUNCH_INFORMATION,
      returnByValue: true,
      silent: true,
    });
    const information = response.result?.value;
    if (response.exceptionDetails || !isValidLaunchInformation(information)) {
      throw new Error('Node의 실행 정보를 조회하지 못했습니다. 최초 정지에서 연결해 주세요.');
    }
    this.#information = information;
  }

  async #verifyProcessIdentity() {
    const response = await this.#connection.request('Runtime.evaluate', {
      expression: 'process.pid\n//# sourceURL=backdo-internal:///verify-process.js',
      returnByValue: true,
      silent: true,
      throwOnSideEffect: true,
    });
    if (response.result?.value !== this.pid) {
      throw new Error('재시작 대상의 PID가 변경되었습니다.');
    }
  }

  async #launchReplacement(information) {
    const bootstrap = path.join(__dirname, 'RestoreLaunchContext.js');
    const args = restartArguments(information.execArgv, this.port);
    const context = {
      umask: information.umask,
      previous: information.env.BACKDO_RESTORE_CONTEXT,
    };
    const child = await launchNode(
      information.execPath,
      ['--require', bootstrap, ...args, ...information.argv.slice(1)],
      {
        cwd: information.cwd,
        // 전달 키가 이미 있으면 부트스트랩에서 원래 값까지 복구한다.
        env: { ...information.env, BACKDO_RESTORE_CONTEXT: JSON.stringify(context) },
        argv0: information.argv0,
        uid: information.uid,
        gid: information.gid,
      },
    );
    return new NodeProcess(child.ws, { ...information, pid: child.process.pid }, child.process);
  }
}

function isValidLaunchInformation(value) {
  return value &&
    Number.isInteger(value.pid) && value.pid > 1 && value.pid !== process.pid &&
    path.isAbsolute(value.execPath) && path.isAbsolute(value.cwd) &&
    isStringArray(value.argv) && isStringArray(value.execArgv) &&
    value.env && Object.values(value.env).every(item => typeof item === 'string');
}

function isStringArray(value) {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function restartArguments(original, port) {
  const args = [];
  for (let index = 0; index < original.length; index++) {
    const argument = original[index];
    const isInspectorOption = /^--inspect(?:-brk|-wait|-port)?(?:=|$)/.test(argument);
    if (isInspectorOption) {
      const separatePortValue = argument === '--inspect-port' &&
        original[index + 1] && !original[index + 1].startsWith('-');
      if (separatePortValue) {
        index++;
      }
      continue;
    }
    args.push(argument);
  }
  return [`--inspect-brk=127.0.0.1:${port}`, ...args];
}

module.exports = { NodeProcess };
