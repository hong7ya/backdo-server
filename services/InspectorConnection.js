const { EventEmitter } = require("node:events");

/** 제품과 테스트가 함께 사용하는 CDP 연결. 실행 명령은 호출자가 명시적으로 보낸다. */
class InspectorConnection extends EventEmitter {
  #socket;
  #nextID = 0;
  #pending = new Map();
  #closed = false;

  constructor(ws) {
    super();

    this.#socket = new WebSocket(ws);

    this.ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Node 디버거 연결 대기 시간이 지났습니다."));
        this.#socket.close();
      }, 10_000);

      this.#socket.addEventListener(
        "open",
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true }
      );
      this.#socket.addEventListener("close", () => clearTimeout(timeout), {
        once: true,
      });
      this.#socket.addEventListener("error", () => clearTimeout(timeout), {
        once: true,
      });
      this.#socket.addEventListener(
        "error",
        () => reject(new Error("Node 디버거에 연결하지 못했습니다.")),
        {
          once: true,
        }
      );
      this.#socket.addEventListener(
        "close",
        () => reject(new Error("Node 디버거 연결이 종료되었습니다.")),
        {
          once: true,
        }
      );
    });

    this.closed = new Promise((resolve) => {
      this.#socket.addEventListener(
        "close",
        () => {
          this.#closed = true;

          for (const pending of this.#pending.values()) {
            clearTimeout(pending.timeout);
            pending.reject(new Error("Node 디버거 연결이 종료되었습니다."));
          }

          this.#pending.clear();
          this.emit("closed");
          resolve();
        },
        { once: true }
      );
    });

    this.#socket.addEventListener("message", (event) => {
      let message;

      try {
        message = JSON.parse(String(event.data));
      } catch {
        this.#socket.close();

        return;
      }

      if (message.method) {
        this.emit(message.method, message.params);
      }

      const pending = this.#pending.get(message.id);

      if (!pending) {
        return;
      }

      clearTimeout(pending.timeout);
      this.#pending.delete(message.id);

      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
    });
  }

  async request(method, params = {}) {
    await this.ready;

    if (this.#closed) {
      throw new Error("종료된 Node 디버거입니다.");
    }

    return await new Promise((resolve, reject) => {
      const id = ++this.#nextID;
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`디버거 응답 대기 시간이 지났습니다: ${method}`));
      }, 10_000);

      this.#pending.set(id, { resolve, reject, timeout });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async close() {
    if (!this.#closed) {
      this.#socket.close();
    }

    await this.closed;
  }
}

module.exports = { InspectorConnection };
