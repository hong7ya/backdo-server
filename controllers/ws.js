function createWSControllers(manager) {
  return {
    open: async (req, res) => res.json(await manager.openBrowser(req.body.port ?? 9222)),
    close: async (req, res) => {
      await manager.closeBrowser(req.body.browserPID);
      res.json({ message: '프로세스가 닫혔습니다.' });
    },
  };
}

module.exports = { createWSControllers };
