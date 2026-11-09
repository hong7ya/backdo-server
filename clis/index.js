const axios = require("axios");

async function main() {
  const command = process.argv[2];
  const origin = `http://127.0.0.1:${process.env.BACKDO_SERVER_PORT || 3000}`;

  if (command === "close") {
    const browserPID = Number(process.argv[3]);

    if (!Number.isInteger(browserPID) || browserPID <= 1) {
      throw new Error(
        "npm run close -- <브라우저 PID> 형식으로 입력해 주세요."
      );
    }

    const { data } = await axios.post(`${origin}/ws/close`, { browserPID });
    console.log(data);

    return;
  }

  throw new Error("npm run close -- <브라우저 PID>를 사용해 주세요.");
}

main().catch((error) => {
  console.error(error.response?.data?.error || error.message);
  process.exitCode = 1;
});
