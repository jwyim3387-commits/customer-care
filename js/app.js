// 마인드원 컨설턴트 앱 : 화면 구성과 라우팅
import * as S from './store.js';
import { h, $, field, toast, copyText, download, confirmDel } from './ui.js';
import {
  QUESTIONS, QUESTION_GROUPS, VISIT_HEAD, VISIT_PRE, VISIT_CLOSE,
  SITE_HEAD, MANAGER_FIELDS, LOG_FIELDS, SITE_MEMO, TIPS_VISIT, TIPS_SITE,
} from './schema.js';
import { Recorder, fmtTime, hasRecorder, hasLiveSTT, transcribeFile } from './audio.js';
import { analyze, filledCount, hasAi } from './ai.js';
import { analyzeLocal } from './localai.js';
import { putAudio, getAudio, delAudio, listAudio, usage, fmtSize } from './db.js';
import * as SCHEMA from './schema.js';
import { saveHwpx, siteBlocks, visitBlocks } from './hwpx.js';

async function hwpxSave(filename, title, blocks) {
  try {
    toast('한글 파일을 만드는 중…');
    await saveHwpx(filename, title, blocks);
    toast('내려받았습니다');
  } catch (e) {
    toast('한글 파일 생성 실패 : ' + e.message);
  }
}

const view = () => $('#view');
const go = (hash) => { location.hash = hash; };
const card = (title, ...kids) => h('section', { class: 'card' }, title && h('h2', {}, title), ...kids);

/* ════════════════════════ 1. 사이트 목록 */
function viewSites() {
  const list = S.sites();
  const wrap = h('div', {},
    h('div', { class: 'row', style: 'margin-bottom:12px' },
      h('button', {
        class: 'btn btn-p btn-full', onclick: () => {
          const org = prompt('지자체 · 사이트 이름'); if (!org) return;
          const s = S.addSite(org.trim()); go('#/site/' + s.id);
        }
      }, '＋ 사이트 추가')),
    list.length ? null : h('div', { class: 'empty' }, '등록된 사이트가 없습니다.\n방문할 지자체를 추가해 주세요.'),
    ...list.map(s => {
      const last = S.lastVisitDate(s.id);
      const issues = s.logs.filter(l => (l.issue || '').trim()).length;
      const open = s.actions.filter(a => !a.done).length;
      return h('a', { class: 'item', href: '#/site/' + s.id },
        h('div', { class: 'n' }, s.org,
          open ? h('span', { class: 'badge warn' }, `후속 ${open}`) : null,
          issues ? h('span', { class: 'badge' }, `난제 ${issues}`) : null),
        h('div', { class: 'm' },
          [s.system, s.amount, last ? `최근 ${last}` : '방문 기록 없음'].filter(Boolean).join(' · ')));
    }));
  render('사이트', wrap);
}

/* ════════════════════════ 2. 상담일지(사이트 상세) */
function viewSite(id) {
  const s = S.site(id);
  if (!s) return go('#/');
  const up = (k, v) => S.updateSite(id, { [k]: v });

  const head = card('사이트 개요',
    ...SITE_HEAD.map(f => field(f, s[f.k], up)));

  const managers = card('담당자 카드',
    h('div', { class: 'sub' }, '부서 · 직위별로 모두 기록. 인사이동은 확인 즉시 이동처를 적는다'),
    ...s.managers.map(m => h('div', { class: 'log' },
      h('div', { class: 'h' }, h('b', {}, m.name || '(이름)'), m.title || '',
        h('button', {
          class: 'btn btn-d btn-sm', style: 'margin-left:auto',
          onclick: () => { if (confirmDel('이 담당자를 삭제할까요?')) { S.removeManager(id, m.id); viewSite(id); } }
        }, '삭제')),
      ...MANAGER_FIELDS.map(f => field(f, m[f.k], (k, v) => S.updateManager(id, m.id, { [k]: v }))))),
    h('button', { class: 'btn btn-s btn-full', onclick: () => { S.addManager(id); viewSite(id); } }, '＋ 담당자 추가'));

  const logs = card('상담 누적 기록',
    h('div', { class: 'sub' }, '한 사이트에 계속 쌓는 기록. 부서가 달라도 같은 곳에 누적한다'),
    ...s.logs.map(l => h('div', { class: 'log' },
      h('div', { class: 'h' }, h('b', {}, l.date || '(일자)'), l.counterpart || '',
        h('button', {
          class: 'btn btn-d btn-sm', style: 'margin-left:auto',
          onclick: () => { if (confirmDel('이 기록을 삭제할까요?')) { S.removeLog(id, l.id); viewSite(id); } }
        }, '삭제')),
      ...LOG_FIELDS.map(f => field(f, l[f.k], (k, v) => S.updateLog(id, l.id, { [k]: v }))))),
    h('button', { class: 'btn btn-s btn-full', onclick: () => { S.addLog(id); viewSite(id); } }, '＋ 상담 기록 추가'));

  const actions = card('후속 조치',
    ...s.actions.map(a => h('div', { class: 'log' },
      h('div', { class: 'h' },
        h('label', { style: 'display:flex;align-items:center;gap:6px' },
          h('input', {
            type: 'checkbox', style: 'width:20px;min-height:20px', checked: a.done,
            onchange: (e) => { S.updateAction(id, a.id, { done: e.target.checked }); }
          }), a.done ? '완료' : '진행'),
        h('button', {
          class: 'btn btn-d btn-sm', style: 'margin-left:auto',
          onclick: () => { if (confirmDel('삭제할까요?')) { S.removeAction(id, a.id); viewSite(id); } }
        }, '삭제')),
      field({ k: 'text', t: '조치 내용', type: 'area' }, a.text, (k, v) => S.updateAction(id, a.id, { [k]: v })),
      h('div', { class: 'row' },
        field({ k: 'owner', t: '담당' }, a.owner, (k, v) => S.updateAction(id, a.id, { [k]: v })),
        field({ k: 'due', t: '기한', type: 'date' }, a.due, (k, v) => S.updateAction(id, a.id, { [k]: v }))))),
    h('button', { class: 'btn btn-s btn-full', onclick: () => { S.addAction(id); viewSite(id); } }, '＋ 후속 조치 추가'));

  const memo = card('제안 · 계약 진행 메모',
    ...SITE_MEMO.map(f => field(f, s.memo?.[f.k], (k, v) => {
      const m = { ...(s.memo || {}), [k]: v }; S.updateSite(id, { memo: m });
    })));

  const vs = S.visits(id);
  const visitsCard = card('방문 질문지',
    ...(vs.length ? vs.map(v => h('a', { class: 'item', href: '#/visit/' + v.id },
      h('div', { class: 'n' }, v.date || '(일자)', v.counterpart ? ` · ${v.counterpart}` : '',
        answered(v) ? h('span', { class: 'badge ok' }, `${answered(v)}/${QUESTIONS.length}`) : null),
      h('div', { class: 'm' }, v.purpose || v.visitor || '방문 목적 미입력')))
      : [h('div', { class: 'empty' }, '작성한 질문지가 없습니다')]),
    h('button', {
      class: 'btn btn-p btn-full', onclick: () => { const v = S.addVisit(id); go('#/visit/' + v.id); }
    }, '＋ 새 방문 질문지'));

  const tools = card(null,
    h('div', { class: 'row' },
      h('button', { class: 'btn btn-g', onclick: () => copyText(siteText(s), '상담일지를 복사했습니다') }, '텍스트 복사'),
      h('button', { class: 'btn btn-g', onclick: () => download(`상담일지_${s.org}.txt`, siteText(s)) }, '파일 저장')),
    h('div', { class: 'row', style: 'margin-top:8px' },
      h('button', {
        class: 'btn btn-s btn-full',
        onclick: () => hwpxSave(`상담일지_${s.org}.hwpx`, `${s.org} 상담일지`, siteBlocks(s, SCHEMA)),
      }, '한글 파일(hwpx) 내려받기')),
    h('div', { class: 'row', style: 'margin-top:8px' },
      h('button', { class: 'btn btn-s btn-full', onclick: () => go('#/rec?site=' + id) }, '🎙 녹음 · 분석으로 채우기')),
    h('div', { class: 'row', style: 'margin-top:8px' },
      h('button', {
        class: 'btn btn-d btn-full',
        onclick: () => { if (confirmDel(`${s.org} 사이트와 방문 기록을 모두 삭제할까요?`)) { S.removeSite(id); go('#/'); } }
      }, '사이트 삭제')));

  render(s.org, h('div', {}, head, visitsCard, managers, logs, actions, memo, tips(TIPS_SITE), tools), true);
}

const answered = (v) => Object.values(v.answers || {}).filter(x => (x || '').trim()).length;

/* ════════════════════════ 3. 방문 질문지 */
function viewVisit(id) {
  const v = S.visit(id);
  if (!v) return go('#/');
  const s = S.site(v.siteId);
  const up = (k, val) => S.updateVisit(id, { [k]: val });
  const upPre = (k, val) => { const p = { ...(v.pre || {}), [k]: val }; S.updateVisit(id, { pre: p }); };
  const upClose = (k, val) => { const c = { ...(v.close || {}), [k]: val }; S.updateVisit(id, { close: c }); };
  const upAns = (k, val) => { const a = { ...(v.answers || {}), [k]: val }; S.updateVisit(id, { answers: a }); };

  const head = card('방문 개요', ...VISIT_HEAD.map(f => field(f, v[f.k], up)));
  const pre = card('사전 확인 (출발 전 작성)', ...VISIT_PRE.map(f => field(f, v.pre?.[f.k], upPre)));

  const qs = card('질문 항목',
    h('div', { class: 'sub' }, '상대가 말하게 하는 것이 목적. 답변란을 다 채우기보다 말을 끊지 않는 것이 우선'),
    ...QUESTION_GROUPS.flatMap(g => [
      h('div', { class: 'grp' }, `${g.id}. ${g.title}`),
      ...QUESTIONS.filter(q => q.g === g.id).map(q => h('div', { class: 'q' },
        h('div', { class: 'qt' }, h('b', {}, q.id), q.q),
        h('textarea', {
          value: v.answers?.[q.id] || '', placeholder: '답변 기록',
          oninput: (e) => upAns(q.id, e.target.value),
        }))),
    ]));

  const close = card('마무리 확인', ...VISIT_CLOSE.map(f => field(f, v.close?.[f.k], upClose)));

  const tools = card(null,
    h('div', { class: 'row' },
      h('button', { class: 'btn btn-g', onclick: () => copyText(visitText(v, s), '질문지를 복사했습니다') }, '텍스트 복사'),
      h('button', { class: 'btn btn-g', onclick: () => download(`방문질문지_${s?.org || ''}_${v.date}.txt`, visitText(v, s)) }, '파일 저장')),
    h('div', { class: 'row', style: 'margin-top:8px' },
      h('button', {
        class: 'btn btn-s btn-full',
        onclick: () => hwpxSave(`방문질문지_${s?.org || ''}_${v.date}.hwpx`, `${s?.org || ''} 고객 방문 질문지`, visitBlocks(v, s, SCHEMA)),
      }, '한글 파일(hwpx) 내려받기')),
    h('div', { class: 'row', style: 'margin-top:8px' },
      h('button', { class: 'btn btn-s btn-full', onclick: () => go(`#/rec?site=${v.siteId}&visit=${id}`) }, '🎙 녹음 · 분석으로 채우기')),
    h('div', { class: 'row', style: 'margin-top:8px' },
      h('button', {
        class: 'btn btn-d btn-full',
        onclick: () => { if (confirmDel('이 질문지를 삭제할까요?')) { S.removeVisit(id); go('#/site/' + v.siteId); } }
      }, '질문지 삭제')));

  render(`${s?.org || '방문'} 질문지`, h('div', {}, head, pre, qs, close, tips(TIPS_VISIT), tools), true, '#/site/' + v.siteId);
}

/* ════════════════════════ 4. 녹음 · 분석 */
let rec = null;
function viewRec(params) {
  const siteId = params.get('site') || S.sites()[0]?.id || '';
  const visitId = params.get('visit') || '';
  const st = S.settings();
  const state = { text: '', sec: 0, file: null };

  const timer = h('div', { class: 'timer' }, '00:00');
  const level = h('i');
  const box = h('div', { class: 'rec-wrap' },
    timer, h('div', { class: 'wave' }, level),
    h('div', { class: 'sub', style: 'margin:0' },
      hasLiveSTT() ? '녹음하면서 말이 아래에 자동으로 받아써집니다' : '이 브라우저는 실시간 받아쓰기를 지원하지 않습니다. 녹음 후 파일을 올리거나 텍스트를 붙여넣어 주세요'));

  const ta = h('textarea', {
    placeholder: '전사된 내용이 여기에 표시됩니다. 직접 붙여넣어도 됩니다(클로바노트 결과 등).',
    style: 'min-height:170px', oninput: (e) => { state.text = e.target.value; },
  });

  const startBtn = h('button', { class: 'btn btn-rec btn-full' }, h('span', { class: 'rec-dot' }), '녹음 시작');
  const stopBtn = h('button', { class: 'btn btn-g btn-full', disabled: true }, '정지');

  startBtn.onclick = async () => {
    if (!hasRecorder()) return toast('이 브라우저에서는 녹음을 지원하지 않습니다');
    try {
      rec = new Recorder({
        onTick: (s) => { timer.textContent = fmtTime(s); state.sec = s; },
        onText: (t) => { ta.value = t; state.text = t; },
        onLevel: (p) => { level.style.width = p + '%'; },
      });
      await rec.start();
      box.classList.add('rec-on');
      startBtn.disabled = true; stopBtn.disabled = false;
      toast('녹음을 시작했습니다');
    } catch (e) {
      toast('마이크 권한이 필요합니다');
    }
  };
  stopBtn.onclick = async () => {
    if (!rec) return;
    const { blob, text, sec } = await rec.stop();
    box.classList.remove('rec-on');
    startBtn.disabled = false; stopBtn.disabled = true;
    if (text) { ta.value = text; state.text = text; }
    state.file = new File([blob], `상담녹음_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.webm`, { type: blob.type || 'audio/webm' });
    audioInfo.textContent = `녹음 ${fmtTime(sec)} · ${(blob.size / 1024 / 1024).toFixed(1)}MB`;
    saveAudioBtn.disabled = false; dlAudioBtn.disabled = false;
    toast('녹음을 마쳤습니다');
  };

  const audioInfo = h('div', { class: 'sub', style: 'margin:6px 0 0' }, '');
  const saveAudioBtn = h('button', {
    class: 'btn btn-g btn-sm', disabled: true,
    onclick: async () => {
      if (!state.file) return;
      try {
        await putAudio({
          id: S.uid(), siteId, visitId, name: state.file.name, type: state.file.type,
          size: state.file.size, blob: state.file, sec: state.sec, createdAt: new Date().toISOString(),
        });
        toast('앱에 보관했습니다');
        refreshAudioList();
      } catch (e) {
        toast('보관 실패 : 저장 공간을 확인해 주세요');
      }
    }
  }, '앱에 보관');

  const dlAudioBtn = h('button', {
    class: 'btn btn-g btn-sm', disabled: true,
    onclick: () => { if (state.file) download(state.file.name, state.file, state.file.type); }
  }, '기기에 저장');

  const audioList = h('div', {});
  async function refreshAudioList() {
    const rows = await listAudio(siteId);
    audioList.replaceChildren(...(rows.length
      ? rows.map(r => h('div', { class: 'log' },
        h('div', { class: 'h' }, h('b', {}, (r.createdAt || '').slice(0, 16).replace('T', ' ')),
          `${fmtSize(r.size)}${r.sec ? ' · ' + fmtTime(r.sec) : ''}`),
        h('div', { class: 'row' },
          h('button', {
            class: 'btn btn-g btn-sm', onclick: async () => {
              const full = await getAudio(r.id);
              const url = URL.createObjectURL(full.blob);
              const au = h('audio', { src: url, controls: true, style: 'width:100%;margin-top:6px' });
              audioList.prepend(au); au.play?.();
            }
          }, '재생'),
          h('button', {
            class: 'btn btn-g btn-sm', onclick: async () => {
              const full = await getAudio(r.id);
              download(full.name || 'recording.webm', full.blob, full.type);
            }
          }, '내려받기'),
          h('button', {
            class: 'btn btn-d btn-sm', onclick: async () => {
              if (!confirmDel('이 녹음을 지울까요?')) return;
              await delAudio(r.id); refreshAudioList(); toast('지웠습니다');
            }
          }, '삭제'))))
      : [h('div', { class: 'sub', style: 'margin:0' }, '보관한 녹음이 없습니다')]));
  }
  refreshAudioList();

  const fileIn = h('input', {
    type: 'file', accept: 'audio/*,video/mp4,.m4a,.mp3,.wav', style: 'display:none',
    onchange: async (e) => {
      const f = e.target.files[0]; if (!f) return;
      state.file = f;
      audioInfo.textContent = `${f.name} · ${(f.size / 1024 / 1024).toFixed(1)}MB`;
      saveAudioBtn.disabled = false; dlAudioBtn.disabled = false;
      if (!st.openaiKey) {
        status.className = 'note';
        status.textContent = '이 파일은 앱에 보관됩니다. 글로 바꾸려면 아래 방법 중 하나를 쓰세요 : ① 휴대폰 키보드의 마이크 버튼으로 전사 칸에 받아쓰기 ② 클로바노트 결과 붙여넣기 ③ 설정에 Whisper 키 입력';
        return;
      }
      try {
        status.className = 'note'; status.textContent = '전사 중…';
        const t = await transcribeFile(f, st.openaiKey, (m) => { status.textContent = m; });
        ta.value = t; state.text = t;
        status.textContent = `전사 완료 (${t.length}자). 내용을 확인한 뒤 분석을 눌러 주세요.`;
      } catch (err) {
        status.className = 'note err'; status.textContent = err.message;
      }
    },
  });

  const status = h('div', { class: 'sub' }, '');
  const result = h('div', {});

  const ctx = () => {
    const v = visitId ? S.visit(visitId) : null;
    const s2 = S.site(siteId);
    return {
      dept: v?.dept || s2?.org || '', counterpart: v?.counterpart || '',
      visitor: v?.visitor || '', date: v?.date || S.today(),
    };
  };

  const runLocal = () => {
    try {
      status.className = 'note';
      const res = analyzeLocal(state.text, ctx());
      status.textContent = `정리 완료 : ${filledCount(res)}개 항목을 찾았습니다. 키 없이 규칙으로 나눈 결과이니 내용을 꼭 확인하세요.`;
      result.replaceChildren(preview(res, siteId, visitId, state));
    } catch (e) {
      status.className = 'note err'; status.textContent = e.message;
    }
  };

  const localBtn = h('button', { class: 'btn btn-s btn-full', onclick: runLocal }, '키 없이 정리 (무료)');

  const analyzeBtn = h('button', {
    class: 'btn btn-p btn-full', onclick: async () => {
      try {
        analyzeBtn.disabled = true;
        status.className = 'note'; status.textContent = '분석 중…';
        const res = await analyze(state.text, ctx(), S.settings(), (m) => { status.textContent = m; });
        status.textContent = `AI 분석 완료 : ${filledCount(res)}개 항목을 찾았습니다. 내용을 확인하고 반영하세요.`;
        result.replaceChildren(preview(res, siteId, visitId, state));
      } catch (e) {
        status.className = 'note err'; status.textContent = e.message;
      } finally { analyzeBtn.disabled = false; }
    }
  }, '✨ AI 분석 (정확도 높음)');

  const siteSel = h('select', { onchange: (e) => go(`#/rec?site=${e.target.value}${visitId ? '&visit=' + visitId : ''}`) },
    ...S.sites().map(s => h('option', { value: s.id, selected: s.id === siteId }, s.org)));

  render('녹음 · 분석', h('div', {},
    card('대상 사이트',
      S.sites().length ? h('label', { class: 'f' }, h('span', {}, '기록을 반영할 사이트'), siteSel)
        : h('div', { class: 'empty' }, '먼저 사이트를 추가해 주세요'),
      visitId ? h('div', { class: 'sub', style: 'margin:0' }, '이 방문 질문지에 함께 반영됩니다') : null),
    card('현장 녹음', box, h('div', { class: 'row' }, startBtn, stopBtn),
      h('div', { class: 'row', style: 'margin-top:8px' },
        h('button', { class: 'btn btn-s btn-full', onclick: () => fileIn.click() }, '음성 파일 올리기')),
      h('div', { class: 'row', style: 'margin-top:8px' }, saveAudioBtn, dlAudioBtn),
      fileIn, audioInfo,
      h('div', { class: 'note', style: 'margin-top:10px' }, '녹음은 상대에게 부담이 됩니다. 반드시 동의를 얻고 녹음하세요.')),
    card('보관한 녹음', h('div', { class: 'sub' }, '이 기기에만 저장됩니다. 용량이 차면 오래된 것부터 지우세요'), audioList),
    card('전사 내용', ta,
      h('div', { class: 'sub' }, hasLiveSTT()
        ? '녹음 중 자동으로 받아써집니다. 아이폰은 키보드의 마이크 버튼을 눌러 이 칸에 받아쓰기 하세요'
        : '이 칸을 누르고 키보드의 마이크 버튼으로 받아쓰거나, 클로바노트 결과를 붙여넣으세요'),
      status, h('div', { style: 'height:8px' }),
      localBtn,
      h('div', { style: 'height:8px' }),
      hasAi(S.settings()) ? analyzeBtn
        : h('div', { class: 'sub', style: 'margin:0' }, 'AI 분석은 설정에 회사 서버 주소나 키를 넣으면 쓸 수 있습니다'),
      result),
  ), true, siteId ? '#/site/' + siteId : '#/');
}

/** 분석 결과 미리보기 + 반영 */
function preview(res, siteId, visitId, state) {
  const rows = [];
  const add = (k, v) => { if ((v || '').trim()) rows.push(h('div', { class: 'diff' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v))); };
  QUESTIONS.forEach(q => add(`${q.id} ${q.q}`, res.answers?.[q.id]));
  add('주요 내용', res.log?.summary); add('상대 요청', res.log?.request);
  add('고객 난제', res.log?.issue); add('약속 사항', res.log?.promise);
  add('다음 약속', res.close?.nextAppt); add('보내드릴 자료', res.close?.sendDoc); add('소개받은 분', res.close?.referral);
  res.managers?.forEach(m => add('담당자 ' + m.name, [m.title, m.phone, m.traits, m.history].filter(Boolean).join(' / ')));
  res.actions?.forEach(a => add('후속 조치', [a.text, a.owner, a.due].filter(Boolean).join(' / ')));
  (res.highlights || []).forEach(x => add('강조점', x));

  const apply = h('button', {
    class: 'btn btn-p btn-full', onclick: () => {
      // 상담일지 누적 기록 1건 추가
      S.addLog(siteId, {
        date: S.today(), summary: res.log?.summary || '', request: res.log?.request || '',
        issue: res.log?.issue || '', promise: res.log?.promise || '',
        counterpart: S.visit(visitId)?.counterpart || '', visitor: S.visit(visitId)?.visitor || '',
      });
      (res.managers || []).forEach(m => S.addManager(siteId, m));
      (res.actions || []).forEach(a => S.addAction(siteId, a));
      // 질문지 답변 반영(빈 칸만 채움)
      if (visitId) {
        const v = S.visit(visitId);
        if (v) {
          const a = { ...(v.answers || {}) };
          for (const [k, val] of Object.entries(res.answers || {})) if ((val || '').trim() && !(a[k] || '').trim()) a[k] = val;
          const c = { ...(v.close || {}) };
          for (const [k, val] of Object.entries(res.close || {})) if ((val || '').trim() && !(c[k] || '').trim()) c[k] = val;
          S.updateVisit(visitId, { answers: a, close: c, transcript: state.text, audioName: state.file?.name || '' });
        }
      }
      toast('양식에 반영했습니다');
      go(visitId ? '#/visit/' + visitId : '#/site/' + siteId);
    }
  }, '이 내용으로 양식 채우기');

  return h('div', { style: 'margin-top:12px' },
    rows.length ? h('div', {}, ...rows) : h('div', { class: 'empty' }, '녹취에서 확인된 항목이 없습니다'),
    rows.length ? apply : null);
}

/* ════════════════════════ 5. 설정 */
function viewSettings() {
  const st = S.settings();
  const k = (key, label, ph, hint) => h('label', { class: 'f' },
    h('span', {}, label), h('input', {
      type: 'password', value: st[key] || '', placeholder: ph,
      oninput: (e) => S.setSetting(key, e.target.value.trim()),
    }), hint ? h('div', { class: 'sub', style: 'margin:4px 0 0' }, hint) : null);

  let mode = 'merge';
  const fileIn = h('input', {
    type: 'file', accept: '.json,application/json', style: 'display:none',
    onchange: async (e) => {
      const f = e.target.files[0]; if (!f) return;
      e.target.value = '';
      try {
        const text = await f.text();
        if (mode === 'merge') {
          const r = S.mergeJson(text);
          alert(`합치기 완료\n\n새 사이트 ${r.sitesAdded}곳 · 기존 사이트 갱신 ${r.sitesMerged}곳\n상담 기록 ${r.logs}건 · 담당자 ${r.managers}명 · 후속 조치 ${r.actions}건\n질문지 ${r.visitsAdded}건 추가 · ${r.visitsMerged}건 보완`);
        } else {
          if (!confirm('내 데이터를 모두 지우고 이 파일로 바꿉니다. 계속할까요?')) return;
          S.importJson(text);
          alert('복원했습니다');
        }
        go('#/');
      } catch (err) { alert((mode === 'merge' ? '합치기' : '복원') + ' 실패 : ' + err.message); }
    },
  });
  const pick = (m) => { mode = m; fileIn.click(); };

  usage().then(u => {
    const el = $('#usage');
    if (el) el.textContent += ` · 보관 녹음 ${u.count}건 (${fmtSize(u.bytes)})`;
  }).catch(() => {});

  render('설정', h('div', {},
    card('AI 분석 (선택)',
      h('div', { class: 'note' }, '키를 넣지 않아도 「키 없이 정리」로 녹취를 양식에 나눠 담을 수 있습니다. AI 분석은 더 정확하게 정리할 때만 씁니다.'),
      h('label', { class: 'f' }, h('span', {}, '회사 서버 주소 (팀 공용, 키 불필요)'),
        h('input', {
          type: 'text', value: st.proxyUrl || '', placeholder: 'https://....workers.dev/analyze',
          oninput: (e) => S.setSetting('proxyUrl', e.target.value.trim()),
        }),
        h('div', { class: 'sub', style: 'margin:4px 0 0' }, '회사가 서버를 한 번 만들어 두면 이 주소만 넣으면 됩니다. 휴대폰마다 키를 넣을 필요가 없습니다')),
      k('teamCode', '팀 코드 (회사 서버용)', '사내에서 정한 값', '서버가 요구할 때만 입력합니다'),
      k('anthropicKey', 'Claude API 키 (개인용, 서버가 없을 때)', 'sk-ant-...', 'console.anthropic.com 에서 발급'),
      h('label', { class: 'f' }, h('span', {}, '분석 모델'),
        h('select', { onchange: (e) => S.setSetting('model', e.target.value) },
          ...['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5-20251001'].map(m =>
            h('option', { value: m, selected: (st.model || 'claude-sonnet-5') === m }, m)))),
      k('openaiKey', 'Whisper API 키 (음성 파일 전사)', 'sk-...', '업로드한 녹음 파일을 글로 바꿀 때만 사용합니다. 현장 녹음은 키 없이도 받아쓰기가 됩니다'),
      h('div', { class: 'note' }, '키는 이 휴대폰 브라우저에만 저장되며 마인드원 서버로 전송되지 않습니다. 공용 기기에서는 사용 후 지워 주세요.')),
    card('데이터',
      h('div', { class: 'sub', id: 'usage' }, `사이트 ${S.all().sites.length}곳 · 질문지 ${S.all().visits.length}건`),
      h('div', { class: 'sub', style: 'margin:8px 0 4px' }, '동료와 나누기'),
      h('div', { class: 'row' },
        h('button', {
          class: 'btn btn-s',
          onclick: () => download(`상담공유_${S.today()}.json`, S.exportJson({ share: true }), 'application/json'),
        }, '공유용 내보내기'),
        h('button', { class: 'btn btn-s', onclick: () => pick('merge') }, '받은 파일 합치기')),
      h('div', { class: 'sub', style: 'margin:4px 0 0' },
        '공유용 파일에는 API 키가 들어가지 않습니다. 합치기는 같은 사이트를 하나로 모으고 상담 기록은 양쪽을 모두 살립니다'),
      h('div', { class: 'sub', style: 'margin:12px 0 4px' }, '기기 옮기기 · 백업'),
      h('div', { class: 'row' },
        h('button', { class: 'btn btn-g', onclick: () => download(`전체백업_${S.today()}.json`, S.exportJson(), 'application/json') }, '전체 백업 (키 포함)'),
        h('button', { class: 'btn btn-g', onclick: () => pick('replace') }, '덮어쓰기 복원')),
      fileIn,
      h('div', { class: 'row', style: 'margin-top:8px' },
        h('button', {
          class: 'btn btn-d btn-full',
          onclick: () => { if (confirmDel('모든 데이터를 지웁니다. 계속할까요?')) { S.wipe(); go('#/'); } }
        }, '전체 삭제'))),
    card('앱 정보',
      h('div', { class: 'sub', style: 'margin:0' },
        '마인드원 컨설턴트 v1.0 · 서식 기준 : 고객 방문 질문지 v1.0 / 상담일지 v1.1 (2026.9)'),
      h('div', { class: 'sub', style: 'margin:6px 0 0' },
        '데이터는 기기에만 저장됩니다. 기기를 바꾸면 백업 내보내기 · 복원을 사용하세요.')),
  ), true);
}

/* ════════════════════════ 텍스트 내보내기 */
function visitText(v, s) {
  const L = [];
  L.push(`[고객 방문 질문지] ${s?.org || ''}`, '');
  VISIT_HEAD.forEach(f => L.push(`${f.t} : ${v[f.k] || ''}`));
  L.push('', '□ 사전 확인');
  VISIT_PRE.forEach(f => L.push(` ○ ${f.t} : ${v.pre?.[f.k] || ''}`));
  QUESTION_GROUPS.forEach(g => {
    L.push('', `□ ${g.id}. ${g.title}`);
    QUESTIONS.filter(q => q.g === g.id).forEach(q => L.push(` ○ ${q.id}. ${q.q}`, `    → ${v.answers?.[q.id] || ''}`));
  });
  L.push('', '□ 마무리 확인');
  VISIT_CLOSE.forEach(f => L.push(` ○ ${f.t} : ${v.close?.[f.k] || ''}`));
  return L.join('\n');
}

function siteText(s) {
  const L = [];
  L.push(`[상담일지] ${s.org}`, '');
  SITE_HEAD.forEach(f => L.push(`${f.t} : ${s[f.k] || ''}`));
  L.push('', '□ 담당자');
  s.managers.forEach(m => L.push(` ○ ${m.name} ${m.title} ${m.phone}`, `    성향 : ${m.traits || ''}`, `    이동 : ${m.history || ''}`));
  L.push('', '□ 상담 누적 기록');
  s.logs.forEach(l => {
    L.push(` ○ ${l.date} / ${l.counterpart} / 방문자 ${l.visitor}`);
    L.push(`    주요 내용 : ${l.summary || ''}`);
    L.push(`    상대 요청 : ${l.request || ''}`);
    L.push(`    고객 난제 : ${l.issue || ''}`);
    L.push(`    약속 사항 : ${l.promise || ''}`);
  });
  L.push('', '□ 후속 조치');
  s.actions.forEach(a => L.push(` ○ [${a.done ? '완료' : '진행'}] ${a.text} / ${a.owner} / ${a.due}`));
  L.push('', '□ 제안 · 계약 진행 메모');
  SITE_MEMO.forEach(f => L.push(` ○ ${f.t} : ${s.memo?.[f.k] || ''}`));
  return L.join('\n');
}

const tips = (list) => card('작성 요령', ...list.map(t => h('div', { class: 'sub', style: 'margin:0 0 6px' }, '○ ' + t)));

/* ════════════════════════ 셸 · 라우터 */
function render(title, node, back = false, backHref = '#/') {
  $('#title').textContent = title;
  const b = $('#back');
  b.style.display = back ? '' : 'none';
  b.onclick = () => { location.hash = backHref; };
  view().replaceChildren(node);
  window.scrollTo(0, 0);
  const path = location.hash.split('?')[0];
  document.querySelectorAll('.tabs a').forEach(a => {
    const rules = (a.dataset.match || '').split(',').filter(Boolean);
    const on = rules.some(m => (m === '/' ? (path === '' || path === '/') : path.startsWith(m)));
    a.classList.toggle('on', on);
  });
}

function route() {
  const [path, qs] = location.hash.replace(/^#/, '').split('?');
  const p = new URLSearchParams(qs || '');
  const [, seg, id] = path.split('/');
  if (seg === 'site' && id) return viewSite(id);
  if (seg === 'visit' && id) return viewVisit(id);
  if (seg === 'rec') return viewRec(p);
  if (seg === 'settings') return viewSettings();
  return viewSites();
}

window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', () => {
  route();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
});
if (document.readyState !== 'loading') { route(); }
