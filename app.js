const express = require("express");
const { allowLocalRequests, sendError } = require("./middleware/http");
const { createSessionRouter } = require("./routes/sessions");
const { createWSRouter } = require("./routes/ws");
const { ProcessManager } = require("./services/ProcessManager");

/** 진입점과 통합 테스트가 같은 앱을 실행한다. 요청별 처리는 라우터에서 확인한다. */
async function startServer(options = {}) {
  const manager = new ProcessManager(options);
  const app = createApp(manager);
  const port = options.port ?? Number(process.env.BACKDO_SERVER_PORT || 3000);
  const server = await listen(app, port);

  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    manager,
    async close() {
      await manager.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function createApp(manager) {
  const app = express();

  app.use(allowLocalRequests());
  app.use(express.json({ limit: "16kb" }));

  app.get("/", (req, res) => res.json({ service: "BackDo", version: 1 }));
  app.use("/ws", createWSRouter(manager));
  app.use("/sessions", createSessionRouter(manager));

  app.use(sendError);

  return app;
}

function listen(app, port) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, "127.0.0.1", () => resolve(server));

    server.once("error", reject);
  });
}

module.exports = { startServer };
