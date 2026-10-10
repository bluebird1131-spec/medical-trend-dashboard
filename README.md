# 의료계 동향 대시보드

구글 시트에 쌓인 의료계 동향을 팀원이 함께 보는 페이지.

```
구글 시트 ─(GitHub Actions, 30분마다)→ data.json ─→ GitHub Pages ─→ 팀원 브라우저
```

- 팀원 브라우저는 GitHub Pages에만 접속하므로 구글이 막힌 망에서도 열람 가능
- 시트 내용이 바뀐 경우에만 `data.json`이 커밋되어 날짜별 이력이 남음 (커밋 기록 = 동향 아카이브)

## 파일
| 경로 | 역할 |
|---|---|
| `index.html` | 화면 (Pretendard Variable, shadcn/ui 스타일, Lucide 아이콘) |
| `assets/` | 폰트·아이콘 파일 (외부 CDN 차단 대비) |
| `data.json` | 시트에서 가져온 데이터 (자동 생성, 직접 수정하지 않음) |
| `scripts/fetch-sheet.mjs` | 시트 CSV → `data.json` 변환 |
| `.github/workflows/update.yml` | 30분마다 동기화 + 배포 |

## 설정
- **Settings → Secrets and variables → Actions → Variables**
  - `SHEET_URL`: 구글 시트 주소 (브라우저 주소창 그대로. 공유는 "링크가 있는 모든 사용자")
  - `SITE_TITLE`: 페이지 제목 (선택, 기본값 "의료계 동향")
- 즉시 갱신: **Actions → 시트 동기화 및 배포 → Run workflow**

## 시트 형식
1행은 머리글, 2행부터 데이터. 머리글 이름으로 열 역할을 자동 인식함 (`index.html`의 `RULES`).
날짜 · 제목 · 분류(쉼표로 여러 개) · 출처 · 링크 · 요약. 그 외 열(담당자 등)은 카드 하단에 표시.
