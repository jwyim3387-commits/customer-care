// API 키 없이 동작하는 규칙 기반 정리기.
// 녹취 문장을 질문지 항목과 상담일지 칸에 배정한다. 통신·비용 없이 기기 안에서만 처리한다.
// 정확도는 AI 분석보다 낮으므로 결과는 반드시 사람이 확인한 뒤 반영한다.

const RULES = {
  A1: ['담당 업무', '맡고', '담당하고', '중점', '주 업무', '업무가'],
  A2: ['전임', '전 담당', '이전 담당', '前', '그만두', '다른 부서로 갔', '넘어갔'],
  A3: ['팀장', '과장', '소장', '계장', '인사드'],
  A4: ['인사이동', '발령', '승진', '자리를 옮', '이동 예정', '옮길'],
  B1: ['자주 쓰', '많이 쓰', '주로 사용', '조회', '보고 있', '활용하고'],
  B2: ['안 쓰', '사용하지 않', '안 쓴다', '활용이 안', '쓸 일이 없', '사용 안'],
  B3: ['느리', '장애', '멈춤', '프리징', '오류', '에러', '서버', '노후', '불편', '끊기'],
  B4: ['반영해', '수정해', '개선해', '해 달라', '해달라', '요청드', '봐 달라'],
  C1: ['현안', '민원', '올해', '급한', '문제가 되는', '신경 쓰'],
  C2: ['내년', '차년도', '계획 중', '검토 중', '하려고', '추진할', '사업을 하'],
  C3: ['예산 편성', '예산 요구', '본예산', '추경', '의회', '마감', '편성 일정', '8월 말', '9월 말'],
  C4: ['국고', '공모', '내시', '보조금', '환경부', '지특', '자율계정'],
  D1: ['억', '천만', '백만', '예산 규모', '금액', '얼마나 잡'],
  D2: ['수의', '협상에 의한', '협상 계약', '적격심사', '입찰', '계약 방식', '지명'],
  D3: ['계약심사', '일상감사', '사전 절차', '심사', '감사'],
  D4: ['사전협의', '보안성', '정보화', '정보화사업'],
  E1: ['다른 부서', '하수과', '수도과', '계약부서', '재정과', '협의해야'],
  E2: ['도와', '필요하시', '자료 주', '보내 주', '지원해'],
  E3: ['인근', '옆 시', '다른 지자체', '소개', '아는 분', '연결해'],
};

const LOG_RULES = {
  request: ['요청', '해 달라', '해달라', '부탁', '원하', '필요하다고', '달라고'],
  issue: ['어렵', '안 된다', '안 돼', '문제', '곤란', '불편', '모르겠', '힘들', '막막', '방법이 없'],
  promise: ['드리겠', '보내겠', '기로 했', '기로 함', '약속', '전달하겠', '준비하겠', '가져다'],
};

const CLOSE_RULES = {
  nextAppt: ['다시 방문', '다음에 뵙', '다음 주에', '또 오', '재방문', '만나기로'],
  sendDoc: ['보내 드리', '자료를 보내', '메일로', '전달하기로', '가져다 드리'],
  referral: ['소개', '연결해', '알려 드릴', '전화번호'],
};

const MONEY = /\d+(?:[.,]\d+)?\s*(?:억|천만|백만|만)\s*원?/g;
const DATE = /\d{4}[-.]\d{1,2}[-.]\d{1,2}|(?:\d{4}년\s*)?\d{1,2}\s*월\s*(?:\d{1,2}\s*일)?|다음\s*주|내주|이번\s*주|추석\s*(?:전|후)|내년\s*초/g;

/** 문장 단위로 자른다 (구어체 종결 + 문장부호 + 줄바꿈) */
export function splitSentences(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?…])\s+|(?<=[다요임함음죠네까])\s+(?=[가-힣A-Z])|\n+/)
    .map(s => s.trim())
    .filter(s => s.length >= 6);
}

const hit = (s, words) => words.some(w => s.includes(w));
const join = (arr, max = 3) => [...new Set(arr)].slice(0, max).join(' / ').slice(0, 400);

/**
 * 규칙 기반 분석. ai.js 의 analyze() 와 같은 모양으로 돌려준다.
 * @returns {{answers:object, log:object, close:object, managers:Array, actions:Array, highlights:Array, source:string}}
 */
export function analyzeLocal(transcript, ctx = {}) {
  const sents = splitSentences(transcript);
  if (!sents.length) throw new Error('정리할 내용이 없습니다. 전사 텍스트를 확인해 주세요.');

  const answers = {};
  for (const [key, words] of Object.entries(RULES)) {
    const found = sents.filter(s => hit(s, words));
    if (found.length) answers[key] = join(found, 2);
  }

  const log = {};
  for (const [key, words] of Object.entries(LOG_RULES)) {
    const found = sents.filter(s => hit(s, words));
    if (found.length) log[key] = join(found, 3);
  }
  // 주요 내용 : 앞부분 문장 + 금액·일정이 든 문장
  const keySents = sents.filter(s => MONEY.test(s) || DATE.test(s));
  MONEY.lastIndex = 0; DATE.lastIndex = 0;
  log.summary = join([...sents.slice(0, 2), ...keySents.slice(0, 2)], 4);

  const close = {};
  for (const [key, words] of Object.entries(CLOSE_RULES)) {
    const found = sents.filter(s => hit(s, words));
    if (found.length) close[key] = join(found, 2);
  }

  // 사람 이름 + 직위 (예: 임병오 주무관)
  const managers = [];
  const seen = new Set();
  const re = /([가-힣]{2,4})\s*(주무관|팀장|과장|소장|계장|사무관|주사|차석)/g;
  let m;
  const flat = sents.join(' ');
  while ((m = re.exec(flat))) {
    const name = m[1];
    if (seen.has(name) || name === ctx.visitorName) continue;
    seen.add(name);
    managers.push({ name, title: m[2], phone: '', traits: '', history: '' });
    if (managers.length >= 4) break;
  }

  // 약속 문장을 후속 조치 후보로
  const actions = (log.promise ? log.promise.split(' / ') : [])
    .slice(0, 3)
    .map(t => ({ text: t, owner: ctx.visitor || '', due: '' }));

  const money = [...new Set(String(transcript).match(MONEY) || [])].slice(0, 3);
  const dates = [...new Set(String(transcript).match(DATE) || [])].slice(0, 3);
  const highlights = [];
  if (money.length) highlights.push('금액 언급 : ' + money.join(', '));
  if (dates.length) highlights.push('일정 언급 : ' + dates.join(', '));
  highlights.push(`문장 ${sents.length}개에서 ${Object.keys(answers).length}개 항목을 찾았습니다`);

  return { answers, log, close, managers, actions, highlights, source: 'rules' };
}
