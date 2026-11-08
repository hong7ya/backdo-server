const { launchBrowser } = require('./BrowserProcess');
const { launchNode, terminateProcess } = require('./NodeRuntime');

// 응답을 잃은 측정용 프로세스만 정리한다. 사용자 기록의 보관 시간과는 무관하다.
const DUMMY_LIFETIME_MS = 30_000;
// 세션마다 하나, 서버 전체에서 네 개까지만 별도 측정 프로세스를 허용한다.
const MAX_CALIBRATIONS = 4;

/** 더미 프로세스의 생성·취소·만료·종료를 한곳에서 관리한다. */
class CalibrationManager {
  #calibrations = new Map();
  #closed = false;
  #created = 0;
  #disposed = 0;
  #options;

  constructor(options = {}) {
    this.#options = options;
  }

  get usage() {
    return {
      calibrations: this.#calibrations.size,
      calibrationsCreated: this.#created,
      calibrationsDisposed: this.#disposed,
    };
  }

  async create(session, owner) {
    this.#validateRequest(session, owner);
    const calibration = {
      sessionId: session.id,
      cancelled: false,
      resource: null,
      timer: null,
      creating: null,
      closing: null,
    };

    // 생성이 끝나기 전에도 취소 요청이 이 작업을 찾을 수 있어야 한다.
    this.#calibrations.set(owner, calibration);
    calibration.creating = this.#createResource(session, owner, calibration);
    return calibration.creating;
  }

  async dispose(sessionId, owner) {
    const calibration = this.#calibrations.get(owner);
    if (!calibration) {
      return;
    }
    if (calibration.sessionId !== sessionId) {
      throw new Error('다른 세션의 측정은 종료할 수 없습니다.');
    }

    calibration.cancelled = true;
    // 생성 실패는 생성 요청이 받는다. 취소 요청은 생성된 자원의 정리를 기다린다.
    await calibration.creating.catch(() => {});
    await this.#closeResource(owner, calibration);
  }

  async releaseSession(sessionId) {
    for (const [owner, calibration] of this.#calibrations) {
      if (calibration.sessionId === sessionId) {
        await this.dispose(sessionId, owner);
      }
    }
  }

  async close() {
    this.#closed = true;
    for (const calibration of this.#calibrations.values()) {
      calibration.cancelled = true;
    }
    await Promise.allSettled([...this.#calibrations.values()].map(calibration => calibration.creating));
    for (const [owner, calibration] of this.#calibrations) {
      await this.#closeResource(owner, calibration);
    }
  }

  #validateRequest(session, owner) {
    if (this.#closed) {
      throw new Error('서버가 종료 중입니다.');
    }
    if (!/^[a-zA-Z0-9-]{16,80}$/.test(owner)) {
      throw new Error('유효하지 않은 측정 식별자입니다.');
    }
    const alreadyMeasuring = [...this.#calibrations.values()].some(calibration => calibration.sessionId === session.id);
    if (this.#calibrations.has(owner) || alreadyMeasuring || this.#calibrations.size >= MAX_CALIBRATIONS) {
      throw new Error('이미 측정 중이거나 동시 측정 한도에 도달했습니다.');
    }
    if (session.kind === 'node' && !session.target.executable) {
      throw new Error('첫 정지의 실행 정보 조회가 끝나지 않았습니다.');
    }
  }

  async #createResource(session, owner, calibration) {
    try {
      calibration.resource = await this.#launchDummy(session);
      this.#created++;
      if (calibration.cancelled || this.#closed) {
        throw new Error('측정이 취소되었습니다.');
      }

      calibration.timer = setTimeout(() => {
        // 만료 시 정리 실패는 세션 해제나 서버 종료에서 다시 처리한다.
        void this.dispose(session.id, owner).catch(() => {});
      }, DUMMY_LIFETIME_MS);
      calibration.timer.unref();
      return { id: owner, ws: calibration.resource.ws };
    } catch (error) {
      await this.#closeResource(owner, calibration);
      throw error;
    }
  }

  async #launchDummy(session) {
    if (session.kind === 'console') {
      const target = await launchBrowser(0, this.#options);
      return { ws: target.ws, close: () => target.browser.close() };
    }

    const node = await launchNode(
      session.target.executable,
      ['--inspect=127.0.0.1:0', '-e', 'setInterval(() => {}, 1000)'],
      { env: {}, cwd: __dirname },
    );
    return { ws: node.ws, close: () => terminateProcess(node.process.pid, node.process) };
  }

  async #closeResource(owner, calibration) {
    clearTimeout(calibration.timer);
    // 만료·연결 해제·명시적 취소가 겹쳐도 같은 프로세스를 중복 정리하지 않는다.
    calibration.closing ??= this.#disposeResource(owner, calibration);
    try {
      await calibration.closing;
    } finally {
      calibration.closing = null;
    }
  }

  async #disposeResource(owner, calibration) {
    if (calibration.resource) {
      await calibration.resource.close();
      calibration.resource = null;
      this.#disposed++;
    }
    if (this.#calibrations.get(owner) === calibration) {
      this.#calibrations.delete(owner);
    }
  }
}

module.exports = { CalibrationManager };
