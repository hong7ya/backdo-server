// Node의 spawn 옵션에는 umask가 없다. 진입점 전에 적용하고 전달용 옵션과 환경변수를 복구한다.
const context = JSON.parse(process.env.BACKDO_RESTORE_CONTEXT);
process.umask(context.umask);

if (context.previous === undefined) {
  delete process.env.BACKDO_RESTORE_CONTEXT;
} else {
  process.env.BACKDO_RESTORE_CONTEXT = context.previous;
}

const index = process.execArgv.indexOf(__filename);

if (index > 0 && process.execArgv[index - 1] === "--require") {
  process.execArgv.splice(index - 1, 2);
}

// BackDo가 실행한 내부 소스임을 공통 기록기에 알린다. 사용자 코드에는 붙이지 않는다.
//# sourceURL=backdo-internal:///restore-launch-context.js
