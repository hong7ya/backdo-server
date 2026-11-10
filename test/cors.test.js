const { assert } = require("chai");
const { startServer } = require("../app");

describe("배포 화면의 로컬 API 접근", () => {
  let server;

  before(async () => {
    server = await startServer({ port: 0 });
  });
  after(async () => {
    await server?.close();
  });

  // 제품 허용 목록을 그대로 읽으면 배포 출처 누락을 놓치므로 독립적으로 지정한다.
  for (const origin of ["https://backdo.site", "https://landing.backdo.site"]) {
    it(`${origin} 화면의 JSON 요청에 필요한 CORS 응답을 제공한다`, async () => {
      const preflight = await fetch(`${server.origin}/sessions`, {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
        signal: AbortSignal.timeout(10_000),
      });
      assert.strictEqual(preflight.status, 204);
      assert.strictEqual(
        preflight.headers.get("access-control-allow-origin"),
        origin
      );
      assert.include(
        preflight.headers.get("access-control-allow-methods"),
        "POST"
      );
      assert.include(
        preflight.headers.get("access-control-allow-headers")?.toLowerCase(),
        "content-type"
      );

      const response = await fetch(server.origin, {
        headers: { Origin: origin },
        signal: AbortSignal.timeout(10_000),
      });
      await response.arrayBuffer();
      assert.strictEqual(response.status, 200);
      assert.strictEqual(
        response.headers.get("access-control-allow-origin"),
        origin
      );
      assert.include(response.headers.get("vary"), "Origin");
    });
  }
});
