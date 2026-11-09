const { default: puppeteer } = require("puppeteer");
const { discoverInspector } = require("./InspectorEndpoint");

async function launchBrowser(port, options = {}) {
  const browser = await puppeteer.launch({
    executablePath: options.chromePath || process.env.CHROME_BIN || undefined,
    headless: true,
    args: [`--remote-debugging-port=${port}`, "--remote-allow-origins=*"],
  });

  try {
    const selectedPort = Number(new URL(browser.wsEndpoint()).port);
    const ws = await discoverInspector(selectedPort, "page");

    return {
      browser,
      ws,
      port: selectedPort,
      pid: browser.process().pid,
      ready: Promise.resolve(),
    };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

module.exports = { launchBrowser };
