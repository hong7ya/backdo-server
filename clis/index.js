const axios = require('axios');

async function main() {
  const command = process.argv[2];
  const origin = `http://127.0.0.1:${process.env.BACKDO_SERVER_PORT || 3000}`;

  if (command === 'ws') {
    const { data } = await axios.post(`${origin}/ws/open`);
    const url = new URL('/gen/front_end/devtools_app.html', origin);
    url.searchParams.set('ws', data.wsParam);
    url.searchParams.set('backdoServer', origin);
    console.log(`BackDo 화면: ${url.href}`);
    console.log(`화면의 Console에 debugger;와 코드를 입력해 주세요.`);
    console.log(`연결 주소: ${data.wsParam}`);
    console.log('디버깅 종료 후 서버를 종료하면 이 서버가 만든 브라우저도 정리됩니다.');
    console.log(`아직 재시작하지 않은 브라우저만 닫으려면: npm run close -- ${data.browserPID}`);
    return;
  }

  if (command === 'close') {
    const browserPID = Number(process.argv[3]);
    if (!Number.isInteger(browserPID) || browserPID <= 1) {
      throw new Error('npm run close -- <브라우저 PID> 형식으로 입력해 주세요.');
    }
    const { data } = await axios.post(`${origin}/ws/close`, { browserPID });
    console.log(data);
    return;
  }

  throw new Error('npm run ws 또는 npm run close -- <브라우저 PID>를 사용해 주세요.');
}

main().catch(error => {
  console.error(error.response?.data?.error || error.message);
  process.exitCode = 1;
});
