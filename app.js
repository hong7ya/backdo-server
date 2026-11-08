const express = require('express');
const path = require('node:path');
const { ProcessManager } = require('./services/ProcessManager');
const { createWSRouter } = require('./routes/ws');

/** 실제 앱 진입점과 통합 테스트가 같은 HTTP 경로를 사용한다. */
async function startServer(options = {}) {
  const manager = new ProcessManager(options);
  const app = express();
  const allowedOrigins = new Set([
    'https://backdo.site', 'https://landing.backdo.site',
    ...(process.env.BACKDO_ALLOWED_ORIGINS || '').split(',').filter(Boolean),
  ]);
  app.use((req, res, next) => {
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(req.hostname)) return res.status(403).json({ error: '로컬 서버 주소로 연결해 주세요.' });
    const origin = req.headers.origin;
    if (origin) {
      let local = false;
      try {
        const url = new URL(origin);
        local = ['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
      } catch {}
      if (!local && !allowedOrigins.has(origin)) return res.status(403).json({ error: '허용되지 않은 화면의 요청입니다.' });
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '16kb' }));
  const route = handler => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
  app.get('/', (req, res) => res.json({ service: 'BackDo', version: 1 }));
  app.use('/ws', createWSRouter(manager, route));
  app.post('/sessions', route(async (req, res) => res.json(await manager.register(req.body))));
  app.get('/sessions/:id', route(async (req, res) => res.json(
    req.query.ready === 'true' ? await manager.ready(req.params.id) : manager.get(req.params.id))));
  app.post('/sessions/:id/restart', route(async (req, res) => res.json(await manager.restart(req.params.id, req.body.ws))));
  app.delete('/sessions/:id', route(async (req, res) => { await manager.release(req.params.id); res.sendStatus(204); }));
  app.post('/sessions/:id/calibrations/:owner', route(async (req, res) => {
    let disconnected = false;
    const cancel = () => {
      if (res.writableEnded) return;
      disconnected = true;
      void manager.disposeCalibration(req.params.id, req.params.owner).catch(() => {});
    };
    res.on('close', cancel);
    try {
      const result = await manager.createCalibration(req.params.id, req.params.owner);
      if (disconnected) await manager.disposeCalibration(req.params.id, req.params.owner);
      else res.json(result);
    } finally { res.off('close', cancel); }
  }));
  app.delete('/sessions/:id/calibrations/:owner', route(async (req, res) => {
    await manager.disposeCalibration(req.params.id, req.params.owner);
    res.sendStatus(204);
  }));
  const frontend = options.frontendDir || process.env.BACKDO_FRONTEND_DIR ||
    path.resolve(__dirname, '../devtools-frontend/out/Default/gen/front_end');
  app.use('/gen/front_end', express.static(frontend));
  app.use((error, req, res, next) => {
    if (!res.headersSent) res.status(400).json({ error: error.message || '요청을 처리하지 못했습니다.' });
  });
  const server = await new Promise((resolve, reject) => {
    const listening = app.listen(options.port ?? Number(process.env.BACKDO_SERVER_PORT || 3000), '127.0.0.1', () => resolve(listening));
    listening.once('error', reject);
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`, manager,
    close: async () => {
      await manager.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

module.exports = { startServer };
