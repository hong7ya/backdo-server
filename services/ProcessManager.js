const { randomUUID } = require('node:crypto');
const { default: puppeteer } = require('puppeteer');
const { NodeProcess, launchNode, terminateProcess } = require('./NodeProcess');

// 응답을 잃은 측정용 프로세스만 정리한다. 사용자 기록의 보관 시간과는 무관하다.
const DUMMY_LIFETIME_MS = 30_000;
// 열린 디버깅 탭과 별도 측정 프로세스가 무제한 늘지 않게 하는 초기 보호 정책이다.
const MAX_SESSIONS = 32;
const MAX_CALIBRATIONS = 4;

class ProcessManager {
  #sessions = new Map();
  #browsers = new Map();
  #calibrations = new Map();
  #closed = false;
  #tasks = new Set();
  #options;
  #ownedNodes = new Set();
  #created = 0;
  #disposed = 0;

  constructor(options = {}) { this.#options = options; }

  get usage() {
    return { sessions: this.#sessions.size, calibrations: this.#calibrations.size,
      calibrationsCreated: this.#created, calibrationsDisposed: this.#disposed };
  }

  async openBrowser(port = 9222) {
    if (this.#closed) throw new Error('서버가 종료 중입니다.');
    return await this.#track(this.#openBrowser(port));
  }

  async #openBrowser(port) {
    const browser = await this.#launchBrowser(port);
    this.#browsers.set(browser.ws, browser);
    return { wsParam: browser.ws.replace(/^ws:\/\//, ''), browserPID: browser.pid, ws: browser.ws, port: browser.port };
  }

  async register(request) {
    return await this.#track(this.#register(request));
  }

  async #register({ port, ws, kind }) {
    if (this.#closed || this.#sessions.size >= MAX_SESSIONS) throw new Error('디버깅 세션을 더 등록할 수 없습니다. 사용하지 않는 세션을 닫아 주세요.');
    if (!['node', 'page'].includes(kind)) throw new Error('지원하지 않는 디버깅 대상입니다.');
    const address = await discover(port, kind, ws);
    if (this.#closed) throw new Error('서버가 종료 중입니다.');
    if ([...this.#sessions.values()].some(session => session.target.ws === address)) {
      throw new Error('이미 BackDo에 등록된 대상입니다. 기존 디버깅 탭을 닫아 주세요.');
    }
    const target = kind === 'node' ? await new NodeProcess(address).connect() : this.#browsers.get(address);
    if (!target) throw new Error('브라우저 대상은 이 서버의 npm run ws로 생성해 주세요.');
    const id = randomUUID();
    const session = { id, kind, target, busy: false, failed: false, restarts: 0 };
    this.#sessions.set(id, session);
    return this.#public(session);
  }

  get(id) { return this.#public(this.#session(id)); }

  async ready(id) {
    const session = this.#session(id);
    await session.target.ready;
    return this.#public(session);
  }

  async restart(id, expectedWS) {
    const session = this.#session(id);
    if (session.kind === 'node' && !session.target.readyToRestart) throw new Error('첫 정지의 실행 정보 조회가 끝나지 않았습니다.');
    if (session.busy || session.failed || session.target.ws !== expectedWS) throw new Error('대상 주소가 바뀌었거나 재시작이 진행 중입니다.');
    session.busy = true;
    const task = (async () => {
      try {
        const previous = session.target;
        if (session.kind === 'node') {
          session.target = await previous.restart();
          this.#ownedNodes.delete(previous);
          this.#ownedNodes.add(session.target);
        } else {
          // CDP 연결을 먼저 끊지 않는다. 브라우저 프로세스를 종료하면 기존 연결이 닫힌다.
          await previous.browser.close();
          this.#browsers.delete(previous.ws);
          session.target = await this.#launchBrowser(previous.port);
          this.#browsers.set(session.target.ws, session.target);
        }
        session.restarts++;
        return this.#public(session);
      } catch (error) {
        session.failed = true;
        throw error;
      } finally { session.busy = false; }
    })();
    return await this.#track(task);
  }

  async createCalibration(id, owner) {
    const session = this.#session(id);
    if (!/^[a-zA-Z0-9-]{16,80}$/.test(owner)) throw new Error('유효하지 않은 측정 식별자입니다.');
    // 세션마다 하나만 측정한다. 동시 측정 네 개는 추가 프로세스 수를 제한하는 초기 보호 정책이다.
    if (this.#calibrations.has(owner) || this.#calibrations.size >= MAX_CALIBRATIONS || [...this.#calibrations.values()].some(lease => lease.session === id)) {
      throw new Error('이미 측정 중이거나 동시 측정 한도에 도달했습니다.');
    }
    if (session.kind === 'node' && !session.target.executable) throw new Error('첫 정지의 실행 정보 조회가 끝나지 않았습니다.');
    const lease = { session: id, cancelled: false, resource: null, timer: null, task: null };
    this.#calibrations.set(owner, lease);
    const task = (async () => {
      try {
        if (session.kind === 'node') {
          const node = await launchNode(session.target.executable,
            ['--inspect=127.0.0.1:0', '-e', 'setInterval(() => {}, 1000)'], { env: {}, cwd: __dirname });
          lease.resource = { ws: node.ws, close: () => terminateProcess(node.process.pid, node.process) };
        } else {
          const browser = await this.#launchBrowser(0);
          lease.resource = { ws: browser.ws, close: () => browser.browser.close() };
        }
        this.#created++;
        if (lease.cancelled || this.#closed) throw new Error('측정이 취소되었습니다.');
        lease.timer = setTimeout(() => { void this.disposeCalibration(id, owner).catch(() => {}); }, DUMMY_LIFETIME_MS);
        lease.timer.unref();
        return { id: owner, ws: lease.resource.ws };
      } catch (error) {
        await this.#closeCalibration(owner, lease);
        throw error;
      }
    })();
    lease.task = task;
    return await this.#track(task);
  }

  async disposeCalibration(id, owner) {
    const lease = this.#calibrations.get(owner);
    if (!lease) return;
    if (lease.session !== id) throw new Error('다른 세션의 측정은 종료할 수 없습니다.');
    lease.cancelled = true;
    await lease.task?.catch(() => {});
    await this.#closeCalibration(owner, lease);
  }

  async release(id) {
    const session = this.#sessions.get(id);
    if (!session) return;
    if (session.busy) throw new Error('재시작이 끝난 뒤 세션을 닫아 주세요.');
    for (const [owner, lease] of this.#calibrations) {
      if (lease.session === id) await this.disposeCalibration(id, owner);
    }
    // 세션 해제는 사용자가 실행한 프로그램의 종료 요청이 아니다.
    if (session.kind === 'node') await session.target.release();
    this.#sessions.delete(id);
  }

  async closeBrowser(pid) {
    const entry = [...this.#browsers.entries()].find(([, target]) => target.pid === Number(pid));
    if (!entry) throw new Error('이 서버에서 생성한 브라우저 PID가 아닙니다.');
    await entry[1].browser.close();
    this.#browsers.delete(entry[0]);
  }

  async close() {
    this.#closed = true;
    for (const lease of this.#calibrations.values()) lease.cancelled = true;
    await Promise.allSettled(this.#tasks);
    for (const [owner, lease] of this.#calibrations) await this.#closeCalibration(owner, lease);
    for (const session of this.#sessions.values()) {
      if (session.kind === 'node') {
        if (session.restarts) await session.target.stop();
        else await session.target.release();
      }
    }
    for (const target of this.#ownedNodes) await target.stop();
    this.#ownedNodes.clear();
    for (const target of this.#browsers.values()) await target.browser.close();
    this.#sessions.clear();
    this.#browsers.clear();
  }

  #session(id) {
    const session = this.#sessions.get(id);
    if (this.#closed || !session) throw new Error('디버깅 세션을 찾을 수 없습니다.');
    return session;
  }

  #public(session) {
    return { id: session.id, kind: session.kind, ws: session.target.ws, pid: session.target.pid,
      port: session.target.port, restarts: session.restarts };
  }

  async #launchBrowser(port) {
    const browser = await puppeteer.launch({
      executablePath: this.#options.chromePath || process.env.CHROME_BIN || undefined,
      headless: true,
      args: [`--remote-debugging-port=${port}`, '--remote-allow-origins=*'],
    });
    try {
      const selectedPort = Number(new URL(browser.wsEndpoint()).port);
      const ws = await discover(selectedPort, 'page');
      return { browser, ws, port: selectedPort, pid: browser.process().pid, ready: Promise.resolve() };
    } catch (error) { await browser.close(); throw error; }
  }

  async #closeCalibration(owner, lease) {
    clearTimeout(lease.timer);
    if (!lease.closing) {
      lease.closing = (async () => {
        if (lease.resource) {
          await lease.resource.close();
          lease.resource = null;
          this.#disposed++;
        }
        if (this.#calibrations.get(owner) === lease) this.#calibrations.delete(owner);
      })();
    }
    try { await lease.closing; } finally { lease.closing = null; }
  }

  async #track(task) {
    this.#tasks.add(task);
    try { return await task; } finally { this.#tasks.delete(task); }
  }
}

async function discover(port, kind, expectedWS) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('대상 포트는 1부터 65535 사이여야 합니다.');
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('대상 포트의 디버거 정보를 조회하지 못했습니다.');
  const targets = await response.json();
  const candidates = targets.filter(target => target.type === kind && (!expectedWS || sameEndpoint(target.webSocketDebuggerUrl, expectedWS)));
  if (candidates.length !== 1) throw new Error('디버깅 대상을 하나로 식별하지 못했습니다. 대상 ws 주소를 확인해 주세요.');
  const ws = new URL(candidates[0].webSocketDebuggerUrl);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(ws.hostname) || Number(ws.port) !== port) throw new Error('로컬 디버거 주소가 아닙니다.');
  ws.hostname = '127.0.0.1';
  return ws.href;
}

function sameEndpoint(left, right) {
  const normalize = value => {
    const url = new URL(value);
    if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) url.hostname = '127.0.0.1';
    return url.href;
  };
  return normalize(left) === normalize(right);
}

module.exports = { ProcessManager };
