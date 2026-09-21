// 녹음 · 전사 : ① 현장 녹음 + 브라우저 실시간 전사 ② 음성 파일 업로드 → Whisper 전사 ③ 텍스트 붙여넣기
export const hasRecorder = () => !!(navigator.mediaDevices && window.MediaRecorder);
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
export const hasLiveSTT = () => !!SR;

export class Recorder {
  constructor({ onTick, onText, onLevel } = {}) {
    this.onTick = onTick; this.onText = onText; this.onLevel = onLevel;
    this.chunks = []; this.sec = 0; this.text = ''; this.recording = false;
  }

  async start() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.stream = stream;
    this.rec = new MediaRecorder(stream, pickMime());
    this.chunks = [];
    this.rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.rec.start(1000);
    this.recording = true;
    this.sec = 0;
    this.timer = setInterval(() => { this.sec++; this.onTick?.(this.sec); }, 1000);
    this.#meter(stream);
    this.#live();
    return true;
  }

  #meter(stream) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser(); an.fftSize = 512;
      src.connect(an);
      const buf = new Uint8Array(an.frequencyBinCount);
      this.ctx = ctx;
      const loop = () => {
        if (!this.recording) return;
        an.getByteTimeDomainData(buf);
        let peak = 0;
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
        this.onLevel?.(Math.min(100, Math.round(peak / 60 * 100)));
        this.raf = requestAnimationFrame(loop);
      };
      loop();
    } catch (e) { /* 레벨 표시는 부가 기능 */ }
  }

  // 브라우저 실시간 전사(크롬 · 안드로이드 지원, iOS 사파리 미지원)
  #live() {
    if (!SR) return;
    try {
      const r = new SR();
      r.lang = 'ko-KR'; r.continuous = true; r.interimResults = true;
      let fixed = '';
      r.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const t = e.results[i][0].transcript;
          if (e.results[i].isFinal) fixed += t + ' '; else interim += t;
        }
        this.text = (fixed + interim).trim();
        this.onText?.(this.text);
      };
      r.onend = () => { if (this.recording) { try { r.start(); } catch (e) {} } };
      r.onerror = () => {};
      r.start();
      this.sr = r;
    } catch (e) { /* 전사는 선택 기능 */ }
  }

  async stop() {
    this.recording = false;
    clearInterval(this.timer);
    cancelAnimationFrame(this.raf);
    try { this.sr?.stop(); } catch (e) {}
    try { this.ctx?.close(); } catch (e) {}
    const blob = await new Promise((res) => {
      if (!this.rec || this.rec.state === 'inactive') return res(new Blob(this.chunks));
      this.rec.onstop = () => res(new Blob(this.chunks, { type: this.rec.mimeType }));
      this.rec.stop();
    });
    this.stream?.getTracks().forEach(t => t.stop());
    return { blob, text: this.text, sec: this.sec };
  }
}

function pickMime() {
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']) {
    if (window.MediaRecorder?.isTypeSupported?.(m)) return { mimeType: m };
  }
  return {};
}

export const fmtTime = (s) =>
  `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

/** 음성 파일 → 텍스트 (회사 서버, 추가 키·비용 없음) */
export async function transcribeServer(file, st, onProgress) {
  const base = (st.serverUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('설정에서 회사 서버 주소를 먼저 넣어 주세요.');
  if (file.size > 24 * 1024 * 1024) {
    throw new Error(`파일이 ${(file.size / 1048576).toFixed(0)}MB 입니다. 24MB 이하로 나눠 올리거나 클로바노트를 쓰세요.`);
  }
  const mins = Math.max(1, Math.round(file.size / 1048576 * 5));
  onProgress?.(`회사 서버에서 전사 중… 길이에 따라 ${mins}분 안팎 걸립니다`);
  const r = await fetch(`${base}/transcribe`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      ...(st.teamCode ? { 'x-team-code': st.teamCode } : {}),
    },
    body: file,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `전사 실패 (${r.status})`);
  return j.text || '';
}

/** 음성 파일 → 텍스트 (OpenAI Whisper API, 설정에서 키를 넣은 경우에만 동작) */
export async function transcribeFile(file, key, onProgress) {
  if (!key) throw new Error('설정에서 Whisper(OpenAI) API 키를 입력하면 업로드한 음성을 자동 전사합니다.');
  if (file.size > 25 * 1024 * 1024) throw new Error('파일이 25MB를 넘습니다. 나눠서 올려 주세요.');
  onProgress?.('전사 중… 길이에 따라 1~3분 걸립니다');
  const fd = new FormData();
  fd.append('file', file, file.name);
  fd.append('model', 'whisper-1');
  fd.append('language', 'ko');
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: fd,
  });
  if (!r.ok) throw new Error(`전사 실패 (${r.status}) ${(await r.text()).slice(0, 160)}`);
  const j = await r.json();
  return j.text || '';
}
