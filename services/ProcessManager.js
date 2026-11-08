const { randomUUID } = require('node:crypto');
const { launchBrowser } = require('./BrowserProcess');
const { CalibrationManager } = require('./CalibrationManager');
const { discoverInspector } = require('./InspectorEndpoint');
const { NodeProcess } = require('./NodeProcess');

// 열린 디버깅 탭이 무제한 늘지 않게 하는 초기 보호 정책이다.
const MAX_SESSIONS = 32;

/** 사용자 세션과 서버가 소유한 프로세스를 관리한다. 더미 측정은 별도 관리자에 맡긴다. */
class ProcessManager {
  #sessions = new Map();
  #browsers = new Map();
  #ownedNodes = new Set();
  #tasks = new Set();
  #closed = false;
  #options;
  #calibrations;

  constructor(options = {}) {
    this.#options = options;
    this.#calibrations = new CalibrationManager(options);
  }

  get usage() {
    return { sessions: this.#sessions.size, ...this.#calibrations.usage };
  }

  async openBrowser(port = 9222) {
    if (this.#closed) {
      throw new Error('서버가 종료 중입니다.');
    }
    return this.#track(this.#openBrowser(port));
  }

  async register(request) {
    return this.#track(this.#register(request));
  }

  get(id) {
    return this.#sessionDetails(this.#session(id));
  }

  async ready(id) {
    const session = this.#session(id);
    await session.target.ready;
    return this.#sessionDetails(session);
  }

  async restart(id, expectedWS) {
    const session = this.#session(id);
    if (session.kind === 'node' && !session.target.readyToRestart) {
      throw new Error('첫 정지의 실행 정보 조회가 끝나지 않았습니다.');
    }
    if (session.busy || session.failed || session.target.ws !== expectedWS) {
      throw new Error('대상 주소가 바뀌었거나 재시작이 진행 중입니다.');
    }

    session.busy = true;
    return this.#track(this.#restart(session));
  }

  async createCalibration(id, owner) {
    const session = this.#session(id);
    return this.#track(this.#calibrations.create(session, owner));
  }

  async disposeCalibration(id, owner) {
    await this.#calibrations.dispose(id, owner);
  }

  async release(id) {
    const session = this.#sessions.get(id);
    if (!session) {
      return;
    }
    if (session.busy) {
      throw new Error('재시작이 끝난 뒤 세션을 닫아 주세요.');
    }

    await this.#calibrations.releaseSession(id);
    // 세션 해제는 사용자가 실행한 프로그램의 종료 요청이 아니다.
    if (session.kind === 'node') {
      await session.target.release();
    }
    this.#sessions.delete(id);
  }

  async closeBrowser(pid) {
    const target = [...this.#browsers.values()].find(browser => browser.pid === Number(pid));
    if (!target) {
      throw new Error('이 서버에서 생성한 브라우저 PID가 아닙니다.');
    }
    await target.browser.close();
    this.#browsers.delete(target.ws);
  }

  async close() {
    this.#closed = true;
    await Promise.all([
      this.#calibrations.close(),
      Promise.allSettled(this.#tasks),
    ]);

    // 사용자가 실행한 원본 Node는 연결만 해제하고, 서버가 재시작한 Node만 종료한다.
    for (const session of this.#sessions.values()) {
      if (session.kind === 'node' && session.restarts === 0) {
        await session.target.release();
      }
    }
    for (const target of this.#ownedNodes) {
      await target.stop();
    }
    for (const target of this.#browsers.values()) {
      await target.browser.close();
    }

    this.#sessions.clear();
    this.#ownedNodes.clear();
    this.#browsers.clear();
  }

  async #openBrowser(port) {
    const browser = await launchBrowser(port, this.#options);
    this.#browsers.set(browser.ws, browser);
    return {
      wsParam: browser.ws.replace(/^ws:\/\//, ''),
      browserPID: browser.pid,
      ws: browser.ws,
      port: browser.port,
    };
  }

  async #register({ port, ws, kind }) {
    if (this.#closed || this.#sessions.size >= MAX_SESSIONS) {
      throw new Error('디버깅 세션을 더 등록할 수 없습니다. 사용하지 않는 세션을 닫아 주세요.');
    }
    if (!['node', 'console'].includes(kind)) {
      throw new Error('지원하지 않는 디버깅 대상입니다.');
    }

    const address = await discoverInspector(port, kind === 'console' ? 'page' : 'node', ws);
    if (this.#closed) {
      throw new Error('서버가 종료 중입니다.');
    }
    const alreadyRegistered = [...this.#sessions.values()].some(session => session.target.ws === address);
    if (alreadyRegistered) {
      throw new Error('이미 BackDo에 등록된 대상입니다. 기존 디버깅 탭을 닫아 주세요.');
    }

    const target = kind === 'node' ? await new NodeProcess(address).connect() : this.#browsers.get(address);
    if (!target) {
      throw new Error('Console 실행 대상은 이 서버의 npm run ws로 생성해 주세요.');
    }
    const session = { id: randomUUID(), kind, target, busy: false, failed: false, restarts: 0 };
    this.#sessions.set(session.id, session);
    return this.#sessionDetails(session);
  }

  async #restart(session) {
    const previous = session.target;
    try {
      if (session.kind === 'node') {
        session.target = await previous.restart();
        this.#ownedNodes.delete(previous);
        this.#ownedNodes.add(session.target);
      } else {
        session.target = await this.#restartBrowser(previous);
      }
      session.restarts++;
      return this.#sessionDetails(session);
    } catch (error) {
      session.failed = true;
      throw error;
    } finally {
      session.busy = false;
    }
  }

  async #restartBrowser(previous) {
    // CDP 연결을 먼저 끊지 않는다. 프로세스 종료로 기존 연결이 닫히게 한다.
    await previous.browser.close();
    this.#browsers.delete(previous.ws);
    const next = await launchBrowser(previous.port, this.#options);
    this.#browsers.set(next.ws, next);
    return next;
  }

  #session(id) {
    const session = this.#sessions.get(id);
    if (this.#closed || !session) {
      throw new Error('디버깅 세션을 찾을 수 없습니다.');
    }
    return session;
  }

  #sessionDetails(session) {
    return {
      id: session.id,
      kind: session.kind,
      ws: session.target.ws,
      pid: session.target.pid,
      port: session.target.port,
      restarts: session.restarts,
    };
  }

  async #track(task) {
    this.#tasks.add(task);
    try {
      return await task;
    } finally {
      this.#tasks.delete(task);
    }
  }
}

module.exports = { ProcessManager };
