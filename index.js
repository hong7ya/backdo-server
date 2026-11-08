const { startServer } = require('./app');

async function main() {
  const server = await startServer();
  console.log(`BackDo 로컬 서버: ${server.origin}`);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await server.close();
  };
  process.once('SIGINT', () => { void close(); });
  process.once('SIGTERM', () => { void close(); });
}

if (require.main === module) void main().catch(error => { console.error(error.message); process.exitCode = 1; });
