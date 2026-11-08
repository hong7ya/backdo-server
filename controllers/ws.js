function createWSControllers(manager) {
  async function open(req, res) {
    const browser = await manager.openBrowser(req.body.port ?? 9222);
    res.json(browser);
  }

  async function close(req, res) {
    await manager.closeBrowser(req.body.browserPID);
    res.json({ message: '프로세스가 닫혔습니다.' });
  }

  return { open, close };
}

module.exports = { createWSControllers };
