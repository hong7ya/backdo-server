const axios = require('axios');

async function main() {
  const command = process.argv[2];

  if (command === "ws") {
    const response = await axios.post('http://localhost:3000/ws/open');

    if (response.status !== 200) {
      new Error("서버를 시작했는 지 확인해주세요")
    }
    const {wsParam, browserPID} = response.data;

    const webSocketID = wsParam.replace("localhost:9222/devtools/page/", "");

    const guideList = [
      "https://landing.backdo.site 에서 webSocketID를 입력해주세요.",
      "👇",
      `${webSocketID}`,
      "",
      "모든 디버깅 작업 종료 후, 다음 명령어를 입력해 안전하게 프로세스를 종료해주세요.",
      "👇",
      `npm run close ${browserPID}`
    ];

    guideList.forEach(item => console.log(item));
  }

  if (command === "close") {
    const browserPID = process.argv[3];

    if (!browserPID) {
      console.log("숫자로 이뤄진 browserPID를 인수로 제공해주세요. npm run ws 했을 당시 얻었어요. 😀");
    }

    const response = await axios.post('http://localhost:3000/ws/close', {
      browserPID
    });

    if (response.status !== 200) {
      new Error("서버가 이미 꺼져있을 수 있습니다.")
    }
    const result = response.data;

    console.log(result);
  }
}

main();
