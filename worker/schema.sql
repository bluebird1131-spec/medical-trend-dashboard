-- 팀원 의견 게시판
CREATE TABLE IF NOT EXISTS posts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,              -- UTC
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT '의견',
  body       TEXT NOT NULL,
  link       TEXT NOT NULL DEFAULT '',   -- 관련 기사 주소 (선택)
  title      TEXT NOT NULL DEFAULT '',   -- 관련 기사 제목
  state      TEXT NOT NULL DEFAULT '접수', -- 접수 / 확인 / 반영 / 보류
  reply      TEXT NOT NULL DEFAULT '',
  replied_at TEXT,
  hidden     INTEGER NOT NULL DEFAULT 0,
  ip_hash    TEXT NOT NULL DEFAULT ''    -- 연속 글쓰기 제한용 (원래 IP는 저장하지 않음)
);
CREATE INDEX IF NOT EXISTS posts_ip_time ON posts (ip_hash, created_at);
