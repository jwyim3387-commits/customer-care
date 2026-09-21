// 상담 녹취 → 질문지 답변 · 상담일지 항목 자동 정리 (Claude API 직접 호출)
import { QUESTIONS } from './schema.js';
import { authHeaders } from './auth.js';

const API = 'https://api.anthropic.com/v1/messages';

const SYSTEM = `당신은 상하수도 IT 기업 마인드원의 영업 지원 도구입니다.
지자체 담당자와의 상담 녹취를 읽고, 회사의 「고객 방문 질문지」와 「상담일지」 항목에 맞게 사실만 정리합니다.

규칙
- 녹취에 근거가 있는 내용만 채웁니다. 추측하거나 지어내지 않습니다. 근거가 없으면 빈 문자열("")로 둡니다.
- 개조식으로 짧게 씁니다. 문장 끝은 "…임 / …함 / …필요함". 존댓말과 수식어를 쓰지 않습니다.
- 「상대 요청」은 담당자가 해 달라고 말한 것, 「고객 난제」는 담당자가 풀지 못해 곤란해하는 문제입니다. 둘을 구분합니다.
- 금액·일정·부서·이름은 녹취에 나온 표현 그대로 옮깁니다.
- 반드시 JSON 객체 하나만 출력합니다. 설명 문장이나 코드펜스를 덧붙이지 않습니다.`;

function userPrompt(transcript, ctx) {
  const qList = QUESTIONS.map(q => `${q.id}. ${q.q}`).join('\n');
  return `[상담 정보]
지자체·부서 : ${ctx.dept || '(미상)'}
면담자 : ${ctx.counterpart || '(미상)'}
방문자 : ${ctx.visitor || '(미상)'}
일자 : ${ctx.date || '(미상)'}

[질문지 항목]
${qList}

[녹취]
${transcript}

[출력 형식]
{
 "answers": { "A1": "", "A2": "", ... "E3": "" },
 "log": { "summary": "", "request": "", "issue": "", "promise": "" },
 "close": { "nextAppt": "", "sendDoc": "", "referral": "" },
 "managers": [ { "name": "", "title": "", "phone": "", "traits": "", "history": "" } ],
 "actions": [ { "text": "", "owner": "", "due": "" } ],
 "highlights": [ "담당자가 강조한 내용 최대 3가지" ]
}
answers 는 위 19개 항목 모두를 키로 포함하고, 녹취에 근거가 없으면 "" 로 둡니다.`;
}

/** 회사 공용 서버가 설정돼 있으면 키 없이 그쪽으로 보낸다 */
const serverAnalyze = (st) => (st.serverUrl ? st.serverUrl.replace(/\/+$/, '') + '/analyze' : st.proxyUrl || '');
export const hasAi = (settings) => !!(serverAnalyze(settings) || settings.anthropicKey);

export async function analyze(transcript, ctx, settings, onStatus) {
  if (!hasAi(settings)) throw new Error('AI 분석을 쓰려면 설정에서 회사 서버 주소나 Claude API 키를 넣어 주세요.');
  if (!transcript || transcript.trim().length < 20) throw new Error('전사 텍스트가 너무 짧습니다.');
  onStatus?.('분석 중… 녹취 길이에 따라 20초~1분 걸립니다');

  const body = JSON.stringify({
    model: settings.model || 'claude-sonnet-5',
    max_tokens: 4000,
    system: SYSTEM,
    messages: [{ role: 'user', content: userPrompt(transcript, ctx) }],
  });

  const endpoint = serverAnalyze(settings);
  const useProxy = !!endpoint;
  const headers = useProxy
    ? { 'content-type': 'application/json', ...authHeaders(), ...(settings.teamCode ? { 'x-team-code': settings.teamCode } : {}) }
    : {
      'content-type': 'application/json',
      'x-api-key': settings.anthropicKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    };

  const r = await fetch(useProxy ? endpoint : API, { method: 'POST', headers, body });

  if (!r.ok) {
    const t = await r.text();
    if (r.status === 401 || r.status === 403) throw new Error('인증에 실패했습니다. 설정의 키 또는 팀 코드를 확인해 주세요.');
    throw new Error(`분석 실패 (${r.status}) ${t.slice(0, 200)}`);
  }
  const j = await r.json();
  const text = (j.content || []).map(c => c.text || '').join('').trim();
  return parseJson(text);
}

function parseJson(text) {
  let s = text.trim();
  if (s.startsWith('```')) s = s.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  try {
    const o = JSON.parse(s);
    return {
      answers: o.answers || {},
      log: o.log || {},
      close: o.close || {},
      managers: Array.isArray(o.managers) ? o.managers.filter(m => m && m.name) : [],
      actions: Array.isArray(o.actions) ? o.actions.filter(a => a && a.text) : [],
      highlights: Array.isArray(o.highlights) ? o.highlights : [],
    };
  } catch (e) {
    throw new Error('분석 결과를 읽지 못했습니다. 다시 시도해 주세요.');
  }
}

/** 채워진 항목 수 */
export const filledCount = (res) =>
  Object.values(res.answers || {}).filter(v => (v || '').trim()).length
  + Object.values(res.log || {}).filter(v => (v || '').trim()).length
  + Object.values(res.close || {}).filter(v => (v || '').trim()).length
  + (res.managers?.length || 0) + (res.actions?.length || 0);
