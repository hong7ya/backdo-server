const { allowedOrigins: productionOrigins } = require("../config.json");

const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

function allowLocalRequests() {
  const allowedOrigins = new Set([
    ...productionOrigins,
    ...(process.env.BACKDO_ALLOWED_ORIGINS || "").split(",").filter(Boolean),
  ]);

  return function checkOrigin(req, res, next) {
    if (!LOCAL_HOSTNAMES.has(req.hostname)) {
      res.status(403).json({ error: "로컬 서버 주소로 연결해 주세요." });

      return;
    }

    const origin = req.headers.origin;

    if (origin && !isLocalOrigin(origin) && !allowedOrigins.has(origin)) {
      res.status(403).json({ error: "허용되지 않은 화면의 요청입니다." });

      return;
    }

    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, DELETE, OPTIONS"
      );
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }

    if (req.method === "OPTIONS") {
      res.sendStatus(204);

      return;
    }

    next();
  };
}

function isLocalOrigin(origin) {
  try {
    const url = new URL(origin);

    return (
      ["http:", "https:"].includes(url.protocol) &&
      LOCAL_HOSTNAMES.has(url.hostname)
    );
  } catch {
    return false;
  }
}

// Express 4는 비동기 핸들러의 실패를 자동 전달하지 않는다.
function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
}

function sendError(error, req, res, next) {
  if (!res.headersSent) {
    res
      .status(400)
      .json({ error: error.message || "요청을 처리하지 못했습니다." });
  }
}

module.exports = { allowLocalRequests, asyncRoute, sendError };
