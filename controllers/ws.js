const { default: puppeteer } = require("puppeteer");

module.exports.open = async (req, res) => {
  const browser = await puppeteer.launch({
    args: [
      "--disable-infobars",
      "--remote-debugging-port=9222",
      "--remote-allow-origins=http://localhost:8000",
      "about:blank"
    ],
    headless: false
  });

  const browserPID = browser.process().pid;

  const response = await fetch("http://localhost:9222/json");
  if (!response.ok) {
    throw new Error(`Response status: ${response.status}`);
  }

  const websocketTargets = await response.json();

  const websocketTarget = websocketTargets.filter((websocketTarget) => websocketTarget.url === "about:blank" ? true : false)[0];
  const wsParam = websocketTarget.webSocketDebuggerUrl.replace("ws://", "");

  return res.status(200).json({
    wsParam,
    browserPID,
  });
}

module.exports.close = async (req, res) => {
  const browserPID = req.body.browserPID;
  process.kill(browserPID);

  return res.status(200).send("프로세스가 닫혔습니다.");
}
