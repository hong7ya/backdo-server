const { parseArgs } = require('node:util');
const { startServer } = require('./app');
const { landingUrl } = require('./config.json');

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  const usage = 'npm run start:console 또는 npm run start:node를 사용해 주세요.';
  if (!mode) {
    console.log(usage);
    return;
  }
  if (!['console', 'node'].includes(mode)) {
    throw new Error(usage);
  }
  const { values } = parseArgs({ args, options: { port: { type: 'string' } } });
  const port = Number(values.port ?? (mode === 'console' ? 9222 : 9229));
  if ((values.port !== undefined && !/^\d+$/.test(values.port)) ||
      !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('--port에는 1부터 65535까지의 정수를 입력해 주세요.');
  }

  const server = await startServer();

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await server.close();
  };
  process.once('SIGINT', () => { void close(); });
  process.once('SIGTERM', () => { void close(); });

  try {
    if (mode === 'console') {
      const target = await server.manager.openBrowser(port);
      if (closing) {
        return;
      }
      console.log('Console 준비 완료');
      console.log(`1. ${landingUrl} 를 여세요.`);
      console.log(`2. Console을 선택하고 디버깅 포트 ${target.port}를 입력한 뒤 연결하세요.`);
      console.log('3. 열린 화면의 Console에 JavaScript를 입력하세요.');
    } else {
      console.log('Node 연결 준비');
      console.log('1. 사용자 프로젝트의 터미널에서 실행하세요.');
      console.log(`   node --inspect-brk=127.0.0.1:${port} ./your-file.js`);
      console.log('   your-file.js는 디버깅할 파일로 바꾸세요.');
      console.log(`2. ${landingUrl} 를 여세요.`);
      console.log(`3. Node.js를 선택하고 디버깅 포트 ${port}를 입력한 뒤 연결하세요.`);
    }
    console.log('종료: 이 터미널에서 Ctrl+C');
  } catch (error) {
    await close();
    throw error;
  }
}

if (require.main === module) void main().catch(error => { console.error(error.message); process.exitCode = 1; });
