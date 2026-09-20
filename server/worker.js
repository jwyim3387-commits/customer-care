/**
 * 회사 공용 분석 서버 (Cloudflare Workers 용, 무료 요금제로 충분)
 *
 * 이걸 한 번만 배포해 두면 팀원 휴대폰에는 API 키를 넣을 필요가 없다.
 * 앱 설정의 「회사 서버 주소」에 배포된 주소를 넣으면 끝이다.
 *
 * 배포 방법
 *   1) npm i -g wrangler && wrangler login
 *   2) wrangler deploy server/worker.js --name mindone-cc
 *   3) wrangler secret put ANTHROPIC_API_KEY     (회사 Claude 키 입력)
 *   4) wrangler secret put TEAM_CODE             (사내에서 정한 공용 암구호)
 *   5) 배포 주소(https://mindone-cc.<계정>.workers.dev) 를 앱 설정에 입력
 *
 * 보호 장치
 *   - TEAM_CODE 를 모르면 호출이 거부된다(x-team-code 헤더).
 *   - ALLOW_ORIGIN 을 설정하면 그 주소의 앱에서만 호출할 수 있다.
 *   - 한 번 호출에 쓰는 토큰을 제한해 과금 사고를 막는다.
 */

const MAX_TOKENS = 4000;
const MAX_BODY = 200 * 1024; // 200KB (아주 긴 녹취 차단)

export default {
  async fetch(request, env) {
    const origin = env.ALLOW_ORIGIN || '*';
    const cors = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'content-type,x-team-code',
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
      'Access-Control-Max-Age': '86400',
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'POST') return json({ error: 'POST 만 지원합니다' }, 405, cors);

    if (env.TEAM_CODE && request.headers.get('x-team-code') !== env.TEAM_CODE) {
      return json({ error: '팀 코드가 올바르지 않습니다' }, 403, cors);
    }

    const raw = await request.text();
    if (raw.length > MAX_BODY) return json({ error: '녹취가 너무 깁니다. 나눠서 분석해 주세요' }, 413, cors);

    let body;
    try { body = JSON.parse(raw); } catch (e) { return json({ error: '잘못된 요청' }, 400, cors); }

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: body.model || 'claude-sonnet-5',
        max_tokens: Math.min(body.max_tokens || MAX_TOKENS, MAX_TOKENS),
        system: body.system,
        messages: body.messages,
      }),
    });

    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { 'content-type': 'application/json', ...cors },
    });
  },
};

const json = (obj, status, cors) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...cors } });
