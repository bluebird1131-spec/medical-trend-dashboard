/** 구글 시트 CSV 읽기 공통 (fetch-sheet.mjs · classify.mjs) */
// 일반 시트 주소(/edit), 웹에 게시 주소(/pubhtml), CSV 주소 모두 받아 CSV 주소로 변환
// 주소에 gid 가 없으면 첫 번째 탭을 읽음
export function toCsvUrl(url) {
  url = url.trim();
  if (!url) return '';
  const gid = (url.match(/[#&?]gid=(\d+)/) || [])[1];
  const pub = url.match(/\/spreadsheets\/d\/e\/([\w-]+)/);
  if (pub) {
    return `https://docs.google.com/spreadsheets/d/e/${pub[1]}/pub?output=csv` + (gid ? `&gid=${gid}` : '');
  }
  const id = url.match(/\/spreadsheets\/d\/([\w-]+)/);
  if (id) {
    return `https://docs.google.com/spreadsheets/d/${id[1]}/export?format=csv` + (gid ? `&gid=${gid}` : '');
  }
  return url;
}

// RFC 4180 CSV 파서 (따옴표 안의 쉼표·줄바꿈 처리)
export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
