-- 마인드원 컨설턴트 공용 저장소 (Cloudflare D1)
-- 사이트와 질문지를 문서 단위로 보관한다. 같은 문서는 나중에 고친 쪽이 이긴다.

CREATE TABLE IF NOT EXISTS docs (
  kind       TEXT NOT NULL,            -- 'site' | 'visit'
  id         TEXT NOT NULL,
  data       TEXT NOT NULL,            -- JSON 본문
  updated_at TEXT NOT NULL,            -- ISO 시각
  deleted    INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT,                     -- 누가 마지막으로 고쳤는지
  PRIMARY KEY (kind, id)
);

CREATE INDEX IF NOT EXISTS idx_docs_updated ON docs (updated_at);
