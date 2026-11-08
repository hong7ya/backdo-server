function createSessionControllers(manager) {
  async function register(req, res) {
    const session = await manager.register(req.body);
    res.json(session);
  }

  async function get(req, res) {
    const { id } = req.params;
    const session = req.query.ready === 'true' ? await manager.ready(id) : manager.get(id);
    res.json(session);
  }

  async function restart(req, res) {
    const session = await manager.restart(req.params.id, req.body.ws);
    res.json(session);
  }

  async function release(req, res) {
    await manager.release(req.params.id);
    res.sendStatus(204);
  }

  async function createCalibration(req, res) {
    const { id, owner } = req.params;
    let disconnected = false;

    function cancelOnDisconnect() {
      if (res.writableEnded) {
        return;
      }
      disconnected = true;
      // 생성 요청이 끊겨도 별도 프로세스가 남지 않게 취소한다.
      void manager.disposeCalibration(id, owner).catch(() => {});
    }

    res.on('close', cancelOnDisconnect);
    try {
      const calibration = await manager.createCalibration(id, owner);
      if (disconnected) {
        await manager.disposeCalibration(id, owner);
        return;
      }
      res.json(calibration);
    } finally {
      res.off('close', cancelOnDisconnect);
    }
  }

  async function disposeCalibration(req, res) {
    await manager.disposeCalibration(req.params.id, req.params.owner);
    res.sendStatus(204);
  }

  return { register, get, restart, release, createCalibration, disposeCalibration };
}

module.exports = { createSessionControllers };
