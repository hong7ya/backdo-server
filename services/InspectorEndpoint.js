const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const DISCOVERY_TIMEOUT_MS = 5000;

async function discoverInspector(port, kind, expectedWS) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('대상 포트는 1부터 65535 사이여야 합니다.');
  }

  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error('대상 포트의 디버거 정보를 조회하지 못했습니다.');
  }

  const targets = await response.json();
  const candidates = targets.filter(target => {
    if (target.type !== kind) {
      return false;
    }
    return !expectedWS || sameEndpoint(target.webSocketDebuggerUrl, expectedWS);
  });
  if (candidates.length !== 1) {
    throw new Error('디버깅 대상을 하나로 식별하지 못했습니다. 대상 ws 주소를 확인해 주세요.');
  }

  const address = new URL(candidates[0].webSocketDebuggerUrl);
  if (!LOCAL_HOSTNAMES.has(address.hostname) || Number(address.port) !== port) {
    throw new Error('로컬 디버거 주소가 아닙니다.');
  }
  address.hostname = '127.0.0.1';
  return address.href;
}

function sameEndpoint(left, right) {
  return normalizeEndpoint(left) === normalizeEndpoint(right);
}

function normalizeEndpoint(value) {
  const address = new URL(value);
  if (LOCAL_HOSTNAMES.has(address.hostname)) {
    address.hostname = '127.0.0.1';
  }
  return address.href;
}

module.exports = { discoverInspector };
