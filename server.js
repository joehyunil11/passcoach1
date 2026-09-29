/* 정적 파일 서버 + AI 선생님 중계.
   API 키는 .env에만 두고 브라우저로는 보내지 않습니다. */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const Store = require('./server-store');

const ROOT = __dirname;
const PORT = process.env.PORT || 5501;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const SYSTEM = `당신은 대한민국 9급 공무원 시험(국어, 영어, 한국사, 행정법, 행정학)을 가르치는 선생님입니다.
- 질문에 정확한 정답과 이유를 한국어로 분명히 답하세요.
- 선택형 문제면 정답 번호와 지문을 먼저 쓰고, 왜 맞는지와 오답이 왜 틀리는지 짧게 설명하세요.
- 사실이 불확실하면 추측하지 말고 모른다고 말한 뒤, 확인해야 할 법령·연도·개념을 알려 주세요.
- 핵심만 간결하게, 수험생이 바로 외울 수 있게 쓰세요.`;

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const eq = trimmed.indexOf('=');
      if (eq < 1) return;
      const name = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
      if (name && value && !process.env[name]) process.env[name] = value;
    });
}

function loadEnv() {
  loadEnvFile(path.join(ROOT, '.env'));
  loadEnvFile(path.join(ROOT, 'SUPABASE.env'));
}

loadEnv();

/* .env가 없어도 이 프로젝트의 Supabase에 바로 연결한다. */
const DEFAULT_SUPABASE_URL = 'https://oekdmpneohvcjcwrcudf.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9la2RtcG5lb2h2Y2pjd3JjdWRmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgwOTQ1NjEsImV4cCI6MjEwMzY3MDU2MX0.6mtPIbKIXX-8YvUyYw_5aZGfdJxW6e1YnvREqlhLiIk';

function json(res, status, payload) {
  res.statusCode = status;
  setSecurityHeaders(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.end(JSON.stringify(payload));
}

function sanitizePlainText(value, maxLen) {
  let s = String(value == null ? '' : value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/javascript\s*:/gi, '')
    .replace(/vbscript\s*:/gi, '')
    .replace(/on[a-z]+\s*=/gi, '');
  if (Number.isInteger(maxLen) && maxLen > 0) s = s.slice(0, maxLen);
  return s.trim();
}

const CSP_VALUE = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "font-src 'self' https://cdn.jsdelivr.net data:",
  "img-src 'self' data: blob: https://*.supabase.co",
  "connect-src 'self' https://*.supabase.co https://api.openai.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function setSecurityHeaders(res) {
  if (res.getHeader && res.getHeader('Content-Security-Policy')) return;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', CSP_VALUE);
}

function supabaseConfig() {
  let url = (process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL || '').trim().replace(/\/$/, '');
  const key = (process.env.SUPABASE_ANON_KEY || DEFAULT_SUPABASE_ANON_KEY || '').trim();
  if (!url || !key) return null;
  /* 실수로 /rest/v1 이나 /api 가 붙어 있으면 제거 */
  url = url.replace(/\/rest\/v1$/i, '').replace(/\/api$/i, '').replace(/\/$/, '');
  return { url, key };
}

function supabaseHeaders(cfg) {
  return {
    apikey: cfg.key,
    Authorization: `Bearer ${cfg.key}`,
    Accept: 'application/json',
    /* 기본 스키마가 api 로 잡히는 환경에서도 public.questions 를 보도록 고정 */
    'Accept-Profile': 'public',
    'Content-Profile': 'public',
  };
}

async function fetchSubjectsFromSupabase() {
  const cfg = supabaseConfig();
  if (!cfg) {
    throw Object.assign(new Error('NO_SUPABASE'), { code: 'NO_SUPABASE' });
  }
  const endpoint = `${cfg.url}/rest/v1/subjects?select=id,name,code,created_at&order=id.asc`;
  const res = await fetch(endpoint, { headers: supabaseHeaders(cfg) });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      (data && data.message) ||
      (data && data.error_description) ||
      (data && data.hint) ||
      `Supabase 응답 오류 (${res.status})`;
    throw new Error(message);
  }
  if (!Array.isArray(data)) throw new Error('과목 목록 형식이 올바르지 않습니다.');
  return data;
}

const SUBJECT_ALIASES = {
  korean: ['korean', '국어', '9급 국어', '9급국어'],
  english: ['english', '영어', '9급 영어', '9급영어'],
  history: ['history', '한국사'],
  adminlaw: ['adminlaw', '행정법'],
  adminsci: ['adminsci', '행정학'],
  peducation: ['peducation', '교육학개론', '교육학'],
  localtax: ['localtax', '지방세법', '지방세'],
  accounting: ['accounting', '회계학'],
  socialwelfare: ['socialwelfare', '사회복지학개론', '사회복지학', '사회복지'],
};

function normalizeSubject(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '');
}

function resolveSubjectCode(value) {
  const key = normalizeSubject(value);
  if (!key) return '';
  const ids = Object.keys(SUBJECT_ALIASES);
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i];
    if (normalizeSubject(id) === key) return id;
    if (SUBJECT_ALIASES[id].some((alias) => normalizeSubject(alias) === key)) return id;
  }
  return '';
}

function subjectAliases(code, extraNames) {
  const key = resolveSubjectCode(code) || String(code || '').trim();
  const list = (SUBJECT_ALIASES[key] || (key ? [key] : [])).concat(extraNames || []);
  const out = [];
  const seen = new Set();
  list.forEach((item) => {
    const trimmed = String(item || '').trim();
    const compact = trimmed.replace(/\s+/g, '');
    [trimmed, compact].forEach((variant) => {
      if (!variant || seen.has(variant)) return;
      seen.add(variant);
      out.push(variant);
    });
  });
  return out;
}

function rowSubject(row) {
  const raw =
    row &&
    (row.subjects ||
      row.subject ||
      row.subject_id ||
      row.subjectId ||
      row.subject_code ||
      '');
  if (Array.isArray(raw)) return String(raw[0] || '').trim();
  return String(raw || '').trim();
}

function subjectMatches(row, aliases) {
  const raw = normalizeSubject(rowSubject(row));
  return Boolean(raw) && aliases.some((alias) => normalizeSubject(alias) === raw);
}

function makeSupabase(cfg) {
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || cfg.key || '').trim();
  return createClient(cfg.url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'public' },
  });
}

async function fetchSupabasePages(makeQuery, pageSize = 1000) {
  const out = [];
  let from = 0;
  const hardCap = 50000;
  while (from < hardCap) {
    const to = from + pageSize - 1;
    const { data, error } = await makeQuery().range(from, to);
    if (error) throw error;
    const rows = Array.isArray(data) ? data : [];
    out.push(...rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return out;
}

function makeAnonClient() {
  const cfg = supabaseConfig();
  if (!cfg) return null;
  return createClient(cfg.url, cfg.key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function makeUserSupabase(accessToken) {
  const cfg = supabaseConfig();
  if (!cfg || !accessToken) return null;
  return createClient(cfg.url, cfg.key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    db: { schema: 'public' },
  });
}

function makeServiceSupabase() {
  const cfg = supabaseConfig();
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!cfg || !key) return null;
  return createClient(cfg.url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function mapQuestionRow(row) {
  const answerRaw = row.answer;
  let answerNo = Number(answerRaw);
  if (!Number.isFinite(answerNo) && typeof answerRaw === 'string') {
    const found = answerRaw.match(/[1-5]/);
    if (found) answerNo = Number(found[0]);
  }

  const options = [];
  const fromArray = Array.isArray(row.options) ? row.options : [];
  for (let i = 1; i <= 5; i += 1) {
    const keyed = row[`option${i}`];
    const listed = fromArray[i - 1];
    const value = keyed != null && String(keyed).trim() !== '' ? keyed : listed;
    if (value == null || String(value).trim() === '') continue;
    options.push(String(value));
  }

  return {
    id: row.id,
    topic: String(row.type || row.topic || '').trim(),
    type: String(row.type || row.topic || '').trim(),
    kind: row.kind || '',
    q: row.question || row.q || '',
    options,
    answer: answerNo >= 1 && answerNo <= options.length ? answerNo - 1 : 0,
    explain: row.explanation || row.explain || '',
    imageUrl: '',
  };
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

function publicStorageUrl(cfg, bucket, objectPath) {
  const parts = String(objectPath || '')
    .replace(/^\/+/, '')
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent);
  if (!cfg || !bucket || !parts.length) return '';
  return `${cfg.url}/storage/v1/object/public/${encodeURIComponent(bucket)}/${parts.join('/')}`;
}

function extractImgSrc(html) {
  const match = String(html || '').match(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i);
  return match ? String(match[1] || '').trim() : '';
}

function normalizeImageRef(raw) {
  const value = String(raw || '').trim();
  if (!value) return { url: '', bucket: 'question-images', objectPath: '' };
  if (/^https?:\/\//i.test(value)) return { url: value, bucket: '', objectPath: '' };
  let objectPath = value.replace(/^\/+/, '');
  let bucket = 'question-images';
  if (objectPath.startsWith('question-images/')) {
    objectPath = objectPath.slice('question-images/'.length);
  }
  return { url: '', bucket, objectPath };
}

function imageContentType(objectPath, blobType) {
  if (blobType && String(blobType).startsWith('image/')) return blobType;
  const ext = String(objectPath || '').split('.').pop().toLowerCase();
  return (
    {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      gif: 'image/gif',
      bmp: 'image/bmp',
      svg: 'image/svg+xml',
    }[ext] || 'application/octet-stream'
  );
}

function fileQuestionNumber(name) {
  const base = String(name || '');
  const stimulus = base.match(/stimulus_q0*(\d+)/i);
  if (stimulus) return Number(stimulus[1]);
  const marked = base.match(/(?:^|[^a-z0-9])q0*(\d+)/i);
  if (marked) return Number(marked[1]);
  const leading = base.match(/^(\d+)/);
  if (leading) return Number(leading[1]);
  return 0;
}

async function listStorageFiles(supabase, bucket, folder) {
  try {
    const { data, error } = await supabase.storage.from(bucket).list(folder, {
      limit: 1000,
      sortBy: { column: 'name', order: 'asc' },
    });
    if (error || !Array.isArray(data)) return [];
    return data
      .filter((item) => item && IMAGE_EXT.test(item.name || ''))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'ko', { numeric: true }));
  } catch (_) {
    return [];
  }
}

async function historyRoundImageList(supabase) {
  const files = await listStorageFiles(supabase, 'question-images', 'history/70');
  const byNum = new Map();
  const sequential = files.map((file) => toProxyImageUrl('question-images', `history/70/${file.name}`));
  files.forEach((file, i) => {
    const num = fileQuestionNumber(file.name) || i + 1;
    if (!byNum.has(num)) byNum.set(num, sequential[i]);
  });
  return { sequential, byNum };
}

function historyRoundFolder(index) {
  const period = Math.floor(Math.max(0, index) / 50) + 1;
  if (period >= 11) return 49 + period;
  return 69 + period;
}

function rewriteQuestionImagePath(objectPath) {
  return String(objectPath || '').replace(/^(history\/60\/q42)(\.[a-z0-9]+)$/i, '$1v2$2');
}

function historyImageObjectPath(index) {
  const folder = historyRoundFolder(index);
  const num = (Math.max(0, index) % 50) + 1;
  const padded = String(num).padStart(2, '0');
  if (folder === 70) return `history/${folder}/stimulus_q${padded}.png`;
  return rewriteQuestionImagePath(`history/${folder}/q${padded}.png`);
}

async function storageImageFromPath(supabase, cfg, bucket, objectPath) {
  const clean = rewriteQuestionImagePath(String(objectPath || '').replace(/^\/+|\/+$/g, ''));
  if (!clean) return '';
  if (IMAGE_EXT.test(clean)) return toProxyImageUrl(bucket, clean);
  try {
    const files = await listStorageFiles(supabase, bucket, clean);
    if (files[0] && files[0].name) return toProxyImageUrl(bucket, `${clean}/${files[0].name}`);
  } catch (_) {
    /* 폴더 목록을 못 읽으면 경로 그대로 시도한다 */
  }
  return toProxyImageUrl(bucket, clean);
}

function historyPeriodFolders(folderNo) {
  const n = Number(folderNo);
  const folders = [];
  const add = (value) => {
    if (value && !folders.includes(value)) folders.push(value);
  };
  add(`history/${n}`);
  if (n >= 70 && n <= 79) {
    add(`history/${n - 69}`);
    add(`history/${n}회`);
    add(`history/제${n}회`);
  }
  if (n >= 60 && n <= 69) {
    add(`history/${n - 49}`);
    add(`history/${n}회`);
    add(`history/제${n}회`);
  }
  if (n >= 80 && n <= 85) {
    add(`history/${n - 20}`);
  }
  if (n >= 1 && n <= 20) {
    add(`history/${69 + n}`);
    add(`history/${49 + n}`);
    add(`history/${n}교시`);
    add(`history/${69 + n}회`);
    add(`history/제${69 + n}회`);
  }
  return folders;
}

function historyAliasPaths(objectPath) {
  const clean = rewriteQuestionImagePath(String(objectPath || '').replace(/^\/+|\/+$/g, ''));
  if (!clean) return [];
  const match = clean.match(/^history\/(?:제)?(\d+)(?:회|교시)?\/(?:q|stimulus_q)?0*(\d+)(?:v\d+)?(?:\.[a-z0-9]+)?$/i);
  const out = [];
  const add = (value) => {
    if (value && !out.includes(value)) out.push(value);
  };
  add(clean);
  if (!match) return out;
  const folderNo = Number(match[1]);
  const num = Number(match[2]);
  const padded = String(num).padStart(2, '0');
  const folders = historyPeriodFolders(folderNo);
  const names = [
    `q${padded}v2.png`,
    `q${num}v2.png`,
    `stimulus_q${padded}.png`,
    `q${padded}.png`,
    `${padded}.png`,
    `${num}.png`,
    `stimulus_q${num}.png`,
    `q${num}.png`,
  ];
  folders.forEach((folder, folderIdx) => {
    const exts = folderIdx === 0 ? ['.png', '.jpg'] : ['.png'];
    names.forEach((name) => {
      const stem = name.replace(/\.png$/i, '');
      exts.forEach((ext) => add(`${folder}/${stem}${ext}`));
    });
  });
  return out;
}

async function downloadStorageImage(supabase, bucket, objectPath) {
  const clean = rewriteQuestionImagePath(String(objectPath || '').replace(/^\/+|\/+$/g, ''));
  if (!clean) return null;
  const tried = new Set();
  const attempts = historyAliasPaths(clean);
  if (IMAGE_EXT.test(clean)) {
    const base = clean.replace(IMAGE_EXT, '');
    ['.png', '.jpg', '.jpeg', '.webp', '.gif'].forEach((ext) => attempts.push(base + ext));
  }
  for (let i = 0; i < attempts.length; i += 1) {
    const path = attempts[i];
    if (tried.has(path)) continue;
    tried.add(path);
    const { data, error } = await supabase.storage.from(bucket).download(path);
    if (!error && data) return { data, path };
  }
  const slash = clean.lastIndexOf('/');
  if (slash < 0) return null;
  const parent = clean.slice(0, slash);
  const files = await listStorageFiles(supabase, bucket, parent);
  const wanted = fileQuestionNumber(clean);
  const baseName = clean.slice(slash + 1).replace(IMAGE_EXT, '');
  const matches = files.filter((item) => {
    const name = String(item.name || '');
    const stem = name.replace(IMAGE_EXT, '');
    return stem === baseName || stem.startsWith(baseName) || (wanted && fileQuestionNumber(name) === wanted);
  });
  matches.sort((a, b) => {
    const av = /v\d+/i.test(a.name) ? 1 : 0;
    const bv = /v\d+/i.test(b.name) ? 1 : 0;
    if (av !== bv) return bv - av;
    return String(b.name).length - String(a.name).length;
  });
  const match = matches[0];
  if (!match) return null;
  const path = `${parent}/${match.name}`;
  if (tried.has(path)) return null;
  const { data, error } = await supabase.storage.from(bucket).download(path);
  if (!error && data) return { data, path };
  return null;
}

function toProxyImageUrl(bucket, objectPath) {
  const clean = rewriteQuestionImagePath(String(objectPath || '').replace(/^\/+|\/+$/g, ''));
  if (!clean) return '';
  const params = new URLSearchParams({
    bucket: bucket || 'question-images',
    path: clean,
  });
  return `/api/question-image?${params.toString()}`;
}

function parseStorageUrl(cfg, raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  const base = cfg && cfg.url ? cfg.url.replace(/\/$/, '') : '';
  const markers = ['/storage/v1/object/public/', '/storage/v1/object/sign/'];
  for (const marker of markers) {
    const prefix = base ? `${base}${marker}` : marker;
    const at = value.indexOf(marker);
    if (at === -1 && !value.startsWith(prefix)) continue;
    const rest = at >= 0 ? value.slice(at + marker.length) : value.slice(prefix.length);
    const noQuery = rest.split('?')[0];
    const parts = noQuery.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
    if (parts.length < 2) continue;
    return { bucket: parts[0], objectPath: parts.slice(1).join('/') };
  }
  return null;
}

async function subjectImageIndex(supabase, cfg, subjectCode) {
  const folder = subjectCode === 'history' ? 'history' : String(subjectCode || '');
  const index = new Map();
  if (!folder) return index;
  const { data: entries } = await supabase.storage.from('question-images').list(folder, { limit: 1000 });
  if (!Array.isArray(entries)) return index;
  await Promise.all(
    entries.map(async (entry) => {
      const name = String(entry && entry.name ? entry.name : '');
      const idMatch = name.match(/^(\d+)/);
      if (!idMatch) return;
      const id = idMatch[1];
      const full = `${folder}/${name}`;
      if (IMAGE_EXT.test(name)) {
        index.set(id, toProxyImageUrl('question-images', full));
        return;
      }
      const url = await storageImageFromPath(supabase, cfg, 'question-images', full);
      if (url) index.set(id, url);
    })
  );
  return index;
}

async function fetchQuestionsFromSupabase(subjects) {
  const cfg = supabaseConfig();
  if (!cfg) {
    throw Object.assign(new Error('NO_SUPABASE'), { code: 'NO_SUPABASE' });
  }
  const wanted = resolveSubjectCode(subjects) || String(subjects || '').trim();
  if (!wanted) throw new Error('과목 코드가 필요합니다.');

  const supabase = makeSupabase(cfg);
  let subjectRows = [];
  try {
    const { data, error } = await supabase.from('subjects').select('id,name,code').order('id', { ascending: true });
    if (error) throw error;
    subjectRows = Array.isArray(data) ? data : [];
  } catch (_) {
    try {
      subjectRows = await fetchSubjectsFromSupabase();
    } catch (__) {
      subjectRows = [];
    }
  }

  const extraNames = subjectRows.flatMap((row) => {
    const resolved = resolveSubjectCode(row.name) || resolveSubjectCode(row.code);
    const id = String(row.id == null ? '' : row.id);
    if (
      resolved === wanted ||
      id === wanted ||
      String(row.name || '').trim() === wanted ||
      String(row.code || '').trim() === wanted
    ) {
      return [row.name, row.code, id].filter(Boolean);
    }
    return [];
  });
  const aliases = subjectAliases(wanted, extraNames);

  let all = [];
  try {
    all = await fetchSupabasePages(() =>
      supabase.from('questions').select('*').order('id', { ascending: true })
    );
  } catch (err) {
    throw new Error(err.message || 'Supabase 문제 조회에 실패했습니다.');
  }

  let rows = all.filter((row) => subjectMatches(row, aliases));
  if (!rows.length) {
    rows = all.filter((row) => {
      const raw = rowSubject(row);
      const hit = subjectRows.find((item) => String(item.id) === raw);
      if (!hit) return false;
      return (resolveSubjectCode(hit.name) || resolveSubjectCode(hit.code)) === wanted;
    });
  }
  if (!rows.length && wanted === 'korean') {
    rows = all.filter((row) => /국어|korean/i.test(rowSubject(row)));
  }

  let imageIndex = new Map();
  try {
    imageIndex = await subjectImageIndex(supabase, cfg, wanted);
  } catch (_) {
    imageIndex = new Map();
  }

  let roundImages = { sequential: [], byNum: new Map() };
  if (wanted === 'history') {
    try {
      roundImages = await historyRoundImageList(supabase);
    } catch (_) {
      roundImages = { sequential: [], byNum: new Map() };
    }
  }

  return Promise.all(
    rows.map(async (row, i) => {
      const mapped = mapQuestionRow(row);
      const rawImage = row.image_url || row.imageUrl || row.image || extractImgSrc(row.question || row.q);
      const parsed = parseStorageUrl(cfg, rawImage);
      const ref = parsed
        ? { url: '', bucket: parsed.bucket, objectPath: parsed.objectPath }
        : normalizeImageRef(rawImage);
      let imageUrl = '';
      if (parsed && parsed.objectPath) {
        const preferred = historyAliasPaths(parsed.objectPath)[0] || parsed.objectPath;
        const stimulus = historyAliasPaths(parsed.objectPath).find((item) => /stimulus_q\d+\.png$/i.test(item));
        imageUrl = toProxyImageUrl(parsed.bucket, stimulus || preferred);
      } else if (ref.objectPath) {
        imageUrl = await storageImageFromPath(supabase, cfg, ref.bucket || 'question-images', ref.objectPath);
      } else if (ref.url) {
        imageUrl = ref.url;
      }
      const listed = roundImages.byNum.get(i + 1) || roundImages.sequential[i] || '';
      if (!imageUrl && wanted === 'history' && i < 50) imageUrl = listed;
      if (!imageUrl && row.id != null) {
        imageUrl = imageIndex.get(String(row.id)) || '';
      }
      if (!imageUrl && wanted === 'history') {
        const objectPath = historyImageObjectPath(i);
        imageUrl = toProxyImageUrl('question-images', objectPath);
        mapped.image_url = objectPath;
      }
      mapped.imageUrl = imageUrl;
      if (rawImage) mapped.image_url = String(rawImage);
      return mapped;
    })
  );
}

let questionIndexCache = { at: 0, maps: null, counts: {} };
const QUESTION_INDEX_TTL_MS = 15 * 60 * 1000;

function cachedQuestionCounts() {
  return questionIndexCache.counts && typeof questionIndexCache.counts === 'object'
    ? questionIndexCache.counts
    : {};
}

async function fetchQuestionCounts() {
  const cached = cachedQuestionCounts();
  if (Object.keys(cached).length) return { ...cached };
  await questionIndexMaps();
  return { ...cachedQuestionCounts() };
}

function provider() {
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) return 'gemini';
  if (process.env.GROQ_API_KEY) return 'groq';
  if (supabaseConfig()) return 'supabase';
  return null;
}

function clientOpenAIKey(value) {
  const key = typeof value === 'string' ? value.trim().slice(0, 400) : '';
  return key.startsWith('sk-') ? key : '';
}

async function askGemini(messages) {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  const models = ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-1.5-flash'];
  const contents = messages.map((item) => ({
    role: item.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: item.content }],
  }));
  const body = JSON.stringify({
    system_instruction: { parts: [{ text: SYSTEM }] },
    contents,
    generationConfig: { temperature: 0.2, maxOutputTokens: 1200 },
  });

  let lastError = 'Gemini 응답에 실패했습니다.';
  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const data = await res.json();
    if (!res.ok) {
      lastError = data.error && data.error.message ? data.error.message : lastError;
      continue;
    }
    const text = ((data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [])
      .map((part) => part.text || '')
      .join('')
      .trim();
    if (text) return text;
    lastError = '모델이 빈 답을 보냈습니다.';
  }
  throw new Error(lastError);
}

async function askChatGPT(key, messages) {
  const models = ['gpt-4o', 'gpt-4o-mini'];
  let lastError = 'ChatGPT 응답에 실패했습니다.';
  for (const model of models) {
    try {
      return await askOpenAI('https://api.openai.com/v1/chat/completions', key, model, messages);
    } catch (err) {
      lastError = err.message || lastError;
    }
  }
  throw new Error(lastError);
}

async function askOpenAI(url, key, model, messages) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 1200,
      messages: [{ role: 'system', content: SYSTEM }, ...messages],
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error((data.error && data.error.message) || 'AI 응답에 실패했습니다.');
  }
  const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!text) throw new Error('모델이 빈 답을 보냈습니다.');
  return String(text).trim();
}

async function askSupabaseEdge(messages) {
  const cfg = supabaseConfig();
  if (!cfg) {
    const err = new Error('NO_KEY');
    err.code = 'NO_KEY';
    throw err;
  }
  const res = await fetch(`${cfg.url}/functions/v1/ask-ai`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: cfg.key,
      Authorization: `Bearer ${cfg.key}`,
    },
    body: JSON.stringify({ messages }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 404) {
    const err = new Error('NO_KEY');
    err.code = 'NO_KEY';
    err.hint = 'Supabase Edge Functions에 ask-ai를 배포해 주세요.';
    throw err;
  }
  if (!res.ok) {
    const err = new Error(data.error || data.hint || 'AI 응답에 실패했습니다.');
    if (data.error === 'NO_KEY' || res.status === 503) err.code = 'NO_KEY';
    throw err;
  }
  if (!data.answer) throw new Error('모델이 빈 답을 보냈습니다.');
  return data.answer;
}

async function askModel(messages, requestKey) {
  const openaiKey = process.env.OPENAI_API_KEY || requestKey;
  if (openaiKey) return askChatGPT(openaiKey, messages);
  const kind = provider();
  if (kind === 'gemini') return askGemini(messages);
  if (kind === 'groq') {
    return askOpenAI('https://api.groq.com/openai/v1/chat/completions', process.env.GROQ_API_KEY, 'llama-3.3-70b-versatile', messages);
  }
  if (kind === 'supabase') return askSupabaseEdge(messages);
  throw Object.assign(new Error('NO_KEY'), { code: 'NO_KEY' });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('질문이 너무 깁니다.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function redirect(res, location) {
  setSecurityHeaders(res);
  res.statusCode = 302;
  res.setHeader('Location', location);
  res.end();
}

function requestOrigin(req) {
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = forwarded || (process.env.VERCEL ? 'https' : 'http');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${PORT}`)
    .split(',')[0]
    .trim();
  return `${proto}://${host}`;
}

function incomingUrl(req) {
  let raw = String(req.url || '/');
  if (!process.env.VERCEL) return raw;
  const forwarded = String(
    req.headers['x-forwarded-uri'] ||
      req.headers['x-invoke-path'] ||
      req.headers['x-vercel-original-url'] ||
      ''
  ).trim();
  if (forwarded && forwarded.startsWith('/')) {
    const forwardedPath = forwarded.split('?')[0];
    const pathOnly = raw.split('?')[0];
    const destOnly =
      pathOnly === '/api' ||
      pathOnly === '/api/' ||
      pathOnly === '/api/index' ||
      pathOnly === '/api/index.js';
    if (destOnly || (forwardedPath.startsWith('/api/') && forwardedPath !== pathOnly)) {
      return forwarded.includes('?') || !raw.includes('?') ? forwarded : `${forwardedPath}${raw.slice(pathOnly.length)}`;
    }
  }
  return raw;
}

function envValue(...names) {
  for (let i = 0; i < names.length; i += 1) {
    const value = String(process.env[names[i]] || '').trim();
    if (value) return value;
  }
  return '';
}

function oauthSigningKey() {
  return (
    envValue('OAUTH_STATE_SECRET', 'KAKAO_REST_API_KEY', 'KAKAO_CLIENT_ID', 'SUPABASE_ANON_KEY') ||
    DEFAULT_SUPABASE_ANON_KEY ||
    'passcoach-oauth'
  );
}

function makeOAuthState(provider) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const payload = `${provider}.${Date.now()}.${nonce}`;
  const sig = crypto.createHmac('sha256', oauthSigningKey()).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function takeOAuthState(state, provider) {
  const raw = String(state || '');
  const lastDot = raw.lastIndexOf('.');
  if (lastDot < 1) return false;
  const payload = raw.slice(0, lastDot);
  const sig = raw.slice(lastDot + 1);
  const parts = payload.split('.');
  if (parts.length !== 3) return false;
  const [p, at, nonce] = parts;
  if (p !== provider || !/^\d+$/.test(at) || !/^[a-f0-9]{32}$/.test(nonce)) return false;
  const expected = crypto.createHmac('sha256', oauthSigningKey()).update(payload).digest('hex');
  try {
    const a = Buffer.from(sig, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length || a.length === 0 || !crypto.timingSafeEqual(a, b)) return false;
  } catch {
    return false;
  }
  if (Date.now() - Number(at) > 10 * 60 * 1000) return false;
  return true;
}

function snsErrorRedirect(res, provider, code) {
  redirect(res, `/login.html?sns=${encodeURIComponent(provider)}&sns_error=${encodeURIComponent(code)}`);
}

function noSupabaseError() {
  const err = new Error('NO_SUPABASE');
  err.code = 'NO_SUPABASE';
  err.status = 503;
  err.hint = '.env에 SUPABASE_URL과 SUPABASE_ANON_KEY를 넣어 주세요.';
  return err;
}

function authErrorStatus(error) {
  const msg = String((error && error.message) || '');
  const code = String((error && error.code) || '');
  if (msg.includes('이미 가입')) return 409;
  if (msg.includes('비밀번호가 올바르지') || msg.includes('올바르지 않습니다')) return 401;
  if (
    code === 'PGRST202' ||
    msg.includes('does not exist') ||
    msg.includes('schema cache') ||
    msg.includes('Could not find the function')
  ) {
    return 503;
  }
  return 400;
}

function translateAuthError(error, fallback) {
  const msg = String((error && error.message) || '');
  const code = String((error && error.code) || '');
  const status = Number((error && (error.status || error.statusCode)) || 0);
  let err;
  if (/already registered|already been registered|user already registered|user_already_exists/i.test(`${msg} ${code}`)) {
    err = new Error('이미 가입된 이메일입니다.');
    err.status = 409;
    return err;
  }
  if (/invalid login credentials|invalid_credentials/i.test(`${msg} ${code}`)) {
    err = new Error('이메일 또는 비밀번호가 올바르지 않습니다.');
    err.status = 401;
    return err;
  }
  if (/email not confirmed|email_not_confirmed/i.test(`${msg} ${code}`)) {
    err = new Error('이메일 확인이 필요합니다. Supabase Authentication → Providers → Email에서 Confirm email을 꺼 주세요.');
    err.status = 403;
    return err;
  }
  if (/database error saving new user/i.test(msg)) {
    err = new Error('가입 중 데이터베이스 오류가 났습니다. SQL Editor에서 supabase-auth-users.sql을 다시 실행해 주세요.');
    err.status = 500;
    return err;
  }
  err = new Error(msg || fallback || '요청에 실패했습니다.');
  err.status = status || authErrorStatus(error);
  return err;
}

async function authRpc(name, args) {
  const cfg = supabaseConfig();
  if (!cfg) throw noSupabaseError();
  const supabase = makeSupabase(cfg);
  const { data, error } = await supabase.rpc(name, args);
  if (error) {
    const err = new Error(error.message || '요청에 실패했습니다.');
    err.status = authErrorStatus(error);
    err.code = error.code;
    if (err.status === 503) {
      err.message = '회원 테이블이 아직 없습니다.';
      if (String(name || '').includes('find_account') || String(name || '').includes('confirm_account')) {
        err.message = '아이디 찾기 기능이 아직 없습니다.';
        err.hint = 'Supabase SQL 편집기에서 supabase-find-account.sql 파일을 실행해 주세요.';
      } else {
        err.hint = 'Supabase SQL 편집기에서 supabase-auth-users.sql 파일을 실행해 주세요.';
      }
    }
    throw err;
  }
  return data;
}

function publicUser(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    id: row.id || null,
    name: row.name,
    email: row.email,
    provider: row.provider || 'email',
    created_at: row.created_at || null,
    last_login_at: row.last_login_at || null,
  };
}

function publicUserFromAuth(user) {
  if (!user) return null;
  const meta = user.user_metadata || {};
  const app = user.app_metadata || {};
  const name = meta.name || meta.nickname || meta.full_name || (user.email ? String(user.email).split('@')[0] : '회원');
  return {
    id: user.id,
    name,
    email: user.email,
    provider: meta.provider || app.provider || 'email',
    created_at: user.created_at || null,
    last_login_at: user.last_sign_in_at || null,
  };
}

function ensureLocalAccount(email, name) {
  const store = Store.load();
  const key = String(email || '').toLowerCase();
  if (!key) return;
  if (!store.accounts[key]) {
    store.accounts[key] = {
      ...Store.DEFAULT_ACCOUNT,
      name: name || Store.DEFAULT_ACCOUNT.name,
      email: key,
      joined: Store.todayLabel(),
    };
    Store.save(store);
  }
}

async function startAppSession(res, user) {
  const sid = Store.token();
  await authRpc('create_app_session', { p_token: sid, p_user_id: user.id });
  Store.setSessionCookie(res, sid, 60 * 60 * 24 * 30);
  ensureLocalAccount(user.email, user.name);
  try {
    await authRpc('get_profile', { p_token: sid });
  } catch {
    /* profiles 테이블이 없으면 로컬 계정만 유지 */
  }
  return sid;
}

async function startAuthSession(res, session, user) {
  if (!session || !session.access_token) {
    const err = new Error('세션을 만들 수 없습니다.');
    err.status = 401;
    throw err;
  }
  Store.clearSessionCookie(res);
  Store.setAuthCookies(res, {
    accessToken: session.access_token,
    refreshToken: session.refresh_token || '',
    accessMaxAge: session.expires_in || 60 * 60,
    refreshMaxAge: 60 * 60 * 24 * 7,
  });
  const publicInfo = publicUserFromAuth(user);
  ensureLocalAccount(publicInfo.email, publicInfo.name);
  try {
    const row = await ensureAuthProfile(session.access_token, user);
    if (isWithdrawnProfile(row)) {
      await signOutAuth(session.access_token);
      Store.clearAuthCookies(res);
      const err = new Error('탈퇴한 계정입니다.');
      err.status = 403;
      throw err;
    }
  } catch (err) {
    if (err && err.status === 403) throw err;
    /* profiles RLS/FK 가 아직이면 로컬 계정만 유지 */
  }
  return publicInfo;
}

async function resolveAuthSession(req, res) {
  const cookies = Store.parseCookies(req);
  const access = cookies.passcoach_access || '';
  const refresh = cookies.passcoach_refresh || '';
  if (!access && !refresh) return null;
  const supabase = makeAnonClient();
  if (!supabase) return null;
  if (access) {
    const { data, error } = await supabase.auth.getUser(access);
    if (!error && data && data.user) {
      return { user: data.user, accessToken: access, refreshToken: refresh };
    }
  }
  if (refresh) {
    const { data, error } = await supabase.auth.refreshSession({ refresh_token: refresh });
    if (!error && data && data.session) {
      if (res) {
        Store.setAuthCookies(res, {
          accessToken: data.session.access_token,
          refreshToken: data.session.refresh_token || refresh,
          accessMaxAge: data.session.expires_in || 60 * 60,
          refreshMaxAge: 60 * 60 * 24 * 7,
        });
      }
      return {
        user: data.user || data.session.user,
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token || refresh,
      };
    }
  }
  return null;
}

async function sessionContext(req, res) {
  try {
    const auth = await resolveAuthSession(req, res);
    if (auth && auth.user) {
      return {
        user: publicUserFromAuth(auth.user),
        authUser: auth.user,
        accessToken: auth.accessToken,
        legacyToken: '',
      };
    }
  } catch {
    /* ignore */
  }
  const legacyToken = Store.parseCookies(req).passcoach_session || '';
  if (legacyToken) {
    try {
      const row = await authRpc('get_app_session', { p_token: legacyToken });
      const user = publicUser(row);
      if (user) return { user, authUser: null, accessToken: '', legacyToken };
    } catch {
      /* ignore */
    }
  }
  const local = Store.currentUser(req);
  return { user: local, authUser: null, accessToken: '', legacyToken: local ? legacyToken : '' };
}

function sessionToken(req) {
  const cookies = Store.parseCookies(req);
  return cookies.passcoach_access || cookies.passcoach_session || '';
}

async function currentSessionUser(req, res) {
  const ctx = await sessionContext(req, res);
  return ctx.user;
}

function isPublicApi(url) {
  return (
    url === '/api/health' ||
    url === '/api/session' ||
    url === '/api/subjects' ||
    url === '/api/questions' ||
    url === '/api/question-image' ||
    url === '/api/entitlements' ||
    url === '/api/legal' ||
    url.startsWith('/api/legal/') ||
    url.startsWith('/api/auth/')
  );
}

function isPublicHtml(file) {
  return (
    file === '/index.html' ||
    file === '/login.html' ||
    file === '/signup.html' ||
    file === '/find-account.html' ||
    file === '/reset-password.html' ||
    file === '/quiz.html'
  );
}

async function ensureAuthProfile(accessToken, user) {
  const supabase = makeUserSupabase(accessToken);
  if (!supabase || !user) return null;
  const name =
    (user.user_metadata && (user.user_metadata.name || user.user_metadata.nickname)) ||
    user.name ||
    '';
  let { data: existing, error: readError } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .maybeSingle();
  if (readError) {
    console.warn('profiles select', readError.message);
    throw profileTableError(readError);
  }
  if (existing) {
    const patch = {};
    if (name && !existing.nickname) patch.nickname = name;
    if (existing.plan !== 'premium') patch.plan = 'premium';
    if (!existing.joined_on && user.created_at) {
      const d = new Date(user.created_at);
      if (!Number.isNaN(d.getTime())) {
        patch.joined_on = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Asia/Seoul',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(d);
      }
    }
    if (Object.keys(patch).length) {
      await supabase.from('profiles').update(patch).eq('id', user.id);
      return { ...existing, ...patch };
    }
    return existing;
  }
  const inserted = await writeAuthProfile(supabase, {
    id: user.id,
    email: user.email || null,
    nickname: name || null,
    plan: 'premium',
    created_at: user.created_at || new Date().toISOString(),
    joined_on: user.created_at
      ? new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Asia/Seoul',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(new Date(user.created_at))
      : undefined,
  });
  return inserted;
}

function isWithdrawnProfile(row) {
  return String((row && row.status) || '').replace(/\s+/g, '') === '회원탈퇴';
}

function profileTableError(error) {
  const err = new Error(error && error.message ? error.message : '프로필을 불러오지 못했습니다.');
  err.status = 503;
  err.hint = 'Supabase SQL 편집기에서 supabase-profiles.sql 파일을 실행해 주세요.';
  return err;
}

function profileNotify(value) {
  const src = value && typeof value === 'object' ? value : {};
  return {
    study: src.study !== false,
    review: src.review !== false,
    event: !!src.event,
  };
}

function profileSubjects(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
  return [];
}

function profilePayload(row, user) {
  if (!row) return null;
  return {
    id: row.id,
    nickname: row.nickname,
    email: (user && user.email) || row.email || null,
    joined_on: row.joined_on || null,
    target_exam: row.target_exam,
    target_date: row.target_date,
    plan: 'premium',
    subjects: profileSubjects(row.subjects),
    daily_target: Number(row.daily_target) > 0 ? Number(row.daily_target) : 30,
    notify: profileNotify(row.notify),
    created_at: row.created_at,
    name: row.nickname || (user && user.name) || null,
  };
}

async function writeAuthProfile(supabase, row) {
  const full = {
    ...row,
    updated_at: new Date().toISOString(),
  };
  let { data, error } = await supabase.from('profiles').upsert(full, { onConflict: 'id' }).select('*').maybeSingle();
  if (error && /column|schema cache/i.test(error.message || '')) {
    const core = {
      id: row.id,
      nickname: row.nickname,
      email: row.email,
      target_exam: row.target_exam,
      target_date: row.target_date,
      plan: row.plan || 'premium',
    };
    ({ data, error } = await supabase.from('profiles').upsert(core, { onConflict: 'id' }).select('*').maybeSingle());
  }
  if (error) {
    console.warn('profiles upsert', error.message);
    throw profileTableError(error);
  }
  return data;
}

async function fetchAuthProfile(accessToken, user, authUser) {
  const supabase = makeUserSupabase(accessToken);
  if (!supabase || !user) return null;
  const row = await ensureAuthProfile(accessToken, authUser || user);
  if (row) return profilePayload(row, user);
  const { data, error } = await supabase.from('profiles').select('*').eq('id', user.id).maybeSingle();
  if (error) throw profileTableError(error);
  return profilePayload(data, user);
}

async function upsertAuthProfile(accessToken, user, fields) {
  const supabase = makeUserSupabase(accessToken);
  if (!supabase || !user) return null;
  let existing = null;
  try {
    const { data } = await supabase.from('profiles').select('*').eq('id', user.id).maybeSingle();
    existing = data;
  } catch {
    existing = null;
  }
  const prev = existing || {};
  const row = {
    id: user.id,
    email: fields.email != null ? fields.email : user.email || prev.email || null,
    nickname: fields.nickname !== undefined ? fields.nickname : prev.nickname || user.name || null,
    target_exam: fields.target_exam !== undefined ? fields.target_exam : prev.target_exam || null,
    target_date: fields.target_date !== undefined ? fields.target_date : prev.target_date || null,
    plan: 'premium',
    subjects: Array.isArray(fields.subjects) ? fields.subjects : profileSubjects(prev.subjects),
    daily_target: fields.daily_target != null ? fields.daily_target : prev.daily_target || 30,
    notify: fields.notify ? profileNotify(fields.notify) : profileNotify(prev.notify),
  };
  const data = await writeAuthProfile(supabase, row);
  return profilePayload(data, user);
}

function flattenAnswerRow(row) {
  const q = row.questions && typeof row.questions === 'object' ? row.questions : {};
  return {
    id: row.id,
    user_id: row.user_id,
    question_id: row.question_id,
    selected_answer: row.selected_answer,
    is_correct: row.is_correct,
    response_time: row.response_time,
    answered_at: row.answered_at,
    subjects: q.subjects != null ? q.subjects : row.subjects,
    type: q.type != null ? q.type : row.type,
  };
}

async function listAuthAnswers(accessToken, userId) {
  const supabase = makeUserSupabase(accessToken);
  if (!supabase || !userId) return [];
  const { data, error } = await supabase
    .from('user_answers')
    .select('id, user_id, question_id, selected_answer, is_correct, response_time, answered_at, questions(subjects, type)')
    .eq('user_id', userId)
    .order('answered_at', { ascending: true });
  if (error) {
    const retry = await supabase
      .from('user_answers')
      .select('id, user_id, question_id, selected_answer, is_correct, response_time, answered_at')
      .eq('user_id', userId)
      .order('answered_at', { ascending: true });
    if (retry.error) return [];
    return retry.data || [];
  }
  return (data || []).map(flattenAnswerRow);
}

async function saveAuthAnswer(accessToken, userId, fields) {
  const supabase = makeUserSupabase(accessToken);
  if (!supabase || !userId) return null;
  const { data, error } = await supabase
    .from('user_answers')
    .insert({
      user_id: userId,
      question_id: fields.questionId,
      selected_answer: fields.selectedAnswer,
      is_correct: fields.isCorrect,
      response_time: fields.responseTime,
    })
    .select('*')
    .maybeSingle();
  if (error) {
    console.warn('user_answers insert', error.message || error);
    return null;
  }
  return data;
}

async function loadUserAnswers(ctx) {
  if (ctx.accessToken && ctx.user && ctx.user.id) {
    try {
      return await listAuthAnswers(ctx.accessToken, ctx.user.id);
    } catch {
      return [];
    }
  }
  if (ctx.legacyToken) {
    try {
      const rows = await authRpc('list_user_answers', { p_token: ctx.legacyToken });
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }
  return [];
}

function dayKeySeoul(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function shiftDayKey(key, days) {
  const [year, month, day] = String(key || '').split('-').map(Number);
  if (!year || !month || !day) return key;
  const dt = new Date(Date.UTC(year, month - 1, day));
  dt.setUTCDate(dt.getUTCDate() + days);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function statsFromAttempts(attempts) {
  const list = Array.isArray(attempts) ? attempts : [];
  const attempted = list.length;
  const correct = list.filter((item) => item && item.correct).length;
  const rate = attempted ? Math.round((correct / attempted) * 100) : 0;
  const days = [
    ...new Set(list.map((item) => dayKeySeoul(item && item.date)).filter(Boolean)),
  ].sort();
  let streak = 0;
  if (days.length) {
    const today = dayKeySeoul(new Date());
    const last = days[days.length - 1];
    if (last === today || last === shiftDayKey(today, -1)) {
      let expected = last;
      for (let i = days.length - 1; i >= 0; i -= 1) {
        if (days[i] !== expected) break;
        streak += 1;
        expected = shiftDayKey(expected, -1);
      }
    }
  }
  return {
    attempted,
    correct,
    rate,
    studyDays: days.length,
    streak,
    studyDates: days,
  };
}

function collectStudyAttempts(studyLog, answers) {
  const map = new Map();
  Object.entries(studyLog || {}).forEach(([subject, byIndex]) => {
    Object.entries(byIndex || {}).forEach(([index, item]) => {
      if (!item) return;
      const qid = Number(item.questionId);
      const key = Number.isFinite(qid) && qid > 0 ? `q:${qid}` : `${subject}:${index}`;
      map.set(key, {
        correct: !!item.correct,
        date: item.date || new Date().toISOString(),
      });
    });
  });
  if (map.size) return [...map.values()];
  (Array.isArray(answers) ? answers : []).forEach((row) => {
    const id = Number(row.question_id);
    const key = Number.isFinite(id) && id > 0 ? `q:${id}` : `row:${map.size}`;
    map.set(key, {
      correct: !!row.is_correct,
      date: row.answered_at || row.date || new Date().toISOString(),
    });
  });
  return [...map.values()];
}

function mergeLogWithAnswers(log, answers) {
  const next = { ...(log || {}) };
  (Array.isArray(answers) ? answers : []).forEach((row) => {
    const subject =
      resolveSubjectCode(row.subjects) ||
      resolveSubjectCode(rowSubject(row)) ||
      '';
    if (!subject) return;
    if (!next[subject]) next[subject] = {};
    const key = Number(row.question_id) > 0 ? `id:${row.question_id}` : String(Object.keys(next[subject]).length);
    next[subject][key] = {
      topic: row.type || '',
      correct: !!row.is_correct,
      date: row.answered_at || new Date().toISOString(),
      questionId: row.question_id || null,
    };
  });
  return next;
}

function mapStudyStatsRow(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    attempted: Number(row.attempted) || 0,
    correct: Number(row.correct) || 0,
    rate: Number(row.rate) || 0,
    studyDays: Number(row.study_days != null ? row.study_days : row.studyDays) || 0,
    streak: Number(row.streak) || 0,
    studyDates: Array.isArray(row.study_dates)
      ? row.study_dates
      : Array.isArray(row.studyDates)
        ? row.studyDates
        : [],
  };
}

function studyStatsClient(accessToken) {
  return accessToken ? makeUserSupabase(accessToken) : makeAnonClient();
}

const PLAN_IDS = new Set(['free', 'basic', 'premium']);
/* 제한을 다시 켤 때까지 무료·베이직·프리미엄을 모두 프리미엄으로 취급. 끄려면 '' 로 두세요. */
const PLAN_UNLOCK = 'premium';
const FREE_PERIOD = false;
const FREE_AI_LIMIT = 100;
const FREE_PERIOD_START = '2026-01-01';

function normalizePlanId(plan) {
  const id = String(plan || 'free').toLowerCase();
  return PLAN_IDS.has(id) ? id : 'free';
}

function effectivePlanId(plan) {
  if (PLAN_UNLOCK && PLAN_IDS.has(PLAN_UNLOCK)) return PLAN_UNLOCK;
  return normalizePlanId(plan);
}

function planEntitlements(plan) {
  const id = effectivePlanId(plan);
  if (id === 'premium') {
    return {
      plan: 'premium',
      questions: { limit: null, kind: 'day', label: '오늘' },
      ai: { limit: 100, kind: 'month', label: '이번 달' },
      features: { review: true, record: true, grades: true, weakness: true, similar: true, teacher: true },
    };
  }
  if (id === 'basic') {
    return {
      plan: 'basic',
      questions: { limit: 80, kind: 'day', label: '오늘' },
      ai: { limit: 100, kind: 'month', label: '이번 달' },
      features: { review: true, record: true, grades: true, weakness: false, similar: false, teacher: true },
    };
  }
  return {
    plan: 'free',
    questions: { limit: 5, kind: 'day', label: '오늘' },
    ai: { limit: 3, kind: 'day', label: '오늘' },
    features: { review: false, record: false, grades: false, weakness: false, similar: false, teacher: true },
  };
}

function aiQuota(plan) {
  if (FREE_PERIOD) return { limit: FREE_AI_LIMIT, kind: 'total', label: '무료 이용기간' };
  return planEntitlements(plan).ai;
}

function questionQuota(plan) {
  return planEntitlements(plan).questions;
}

function aiPeriodStart(kind) {
  if (kind === 'total') return FREE_PERIOD_START;
  const today = dayKeySeoul(new Date());
  if (kind === 'month') return `${today.slice(0, 7)}-01`;
  return today;
}

function currentPlanId() {
  return effectivePlanId(Store.load().plan);
}

async function resolvePlanId(ctx) {
  if (PLAN_UNLOCK && PLAN_IDS.has(PLAN_UNLOCK)) return PLAN_UNLOCK;
  if (ctx && ctx.accessToken && ctx.user) {
    try {
      const profile = await fetchAuthProfile(ctx.accessToken, ctx.user, ctx.authUser);
      if (profile && profile.plan) return normalizePlanId(profile.plan);
    } catch {
      /* profiles 없으면 로컬 이용권 */
    }
  } else if (ctx && ctx.legacyToken) {
    try {
      const profile = await authRpc('get_profile', { p_token: ctx.legacyToken });
      if (profile && profile.plan) return normalizePlanId(profile.plan);
    } catch {
      /* 레거시 프로필이 없으면 로컬 이용권 */
    }
  }
  return currentPlanId();
}

function remainingOf(limit, usedPeriod) {
  if (limit == null) return null;
  return Math.max(0, Number(limit) - (Number(usedPeriod) || 0));
}

function mapAiUsageRow(row, plan) {
  const quota = aiQuota(plan);
  const start = aiPeriodStart(quota.kind);
  const periodKey = String((row && (row.period_start || row.periodStart)) || '').slice(0, 10);
  const rolled = !row || periodKey !== start;
  const used = Number(row && row.used) || 0;
  const usedPeriod = rolled ? 0 : Number(row && (row.used_period != null ? row.used_period : row.usedPeriod)) || 0;
  return {
    used,
    usedPeriod,
    limit: quota.limit,
    remaining: remainingOf(quota.limit, usedPeriod),
    unlimited: quota.limit == null,
    periodKind: quota.kind,
    periodStart: start,
    periodLabel: quota.label,
    plan: normalizePlanId(plan),
  };
}

function mapQuestionUsageRow(row, plan) {
  const quota = questionQuota(plan);
  const start = aiPeriodStart(quota.kind);
  const periodKey = String((row && (row.period_start || row.periodStart)) || '').slice(0, 10);
  const rolled = !row || periodKey !== start;
  const used = Number(row && row.used) || 0;
  const usedPeriod = rolled ? 0 : Number(row && (row.used_period != null ? row.used_period : row.usedPeriod)) || 0;
  return {
    used,
    usedPeriod,
    limit: quota.limit,
    remaining: remainingOf(quota.limit, usedPeriod),
    unlimited: quota.limit == null,
    periodKind: quota.kind,
    periodStart: start,
    periodLabel: quota.label,
    plan: normalizePlanId(plan),
  };
}

function questionQuotaMessage(usage) {
  const plan = normalizePlanId(usage && usage.plan);
  const limit = usage && usage.limit;
  if (plan === 'basic') return `베이직 이용권은 하루 ${limit}문제까지 풀 수 있습니다. 이용권을 확인해 주세요.`;
  if (plan === 'premium') return '오늘의 문제 이용 횟수를 모두 사용했습니다.';
  return `무료 이용권은 하루 ${limit || 5}문제까지 풀 수 있습니다. 이용권을 확인해 주세요.`;
}

function alreadyCountedToday(prev) {
  if (!prev || !prev.date) return false;
  return dayKeySeoul(prev.date) === dayKeySeoul(new Date());
}

async function getAiUsageRemote(client) {
  if (!client) return null;
  const rpc = await client.rpc('get_ai_usage');
  if (rpc.error) throw rpc.error;
  const row = Array.isArray(rpc.data) ? rpc.data[0] : rpc.data;
  return row || null;
}

async function saveAiUsageRemote(client, usage) {
  if (!client || !usage) return null;
  const rpc = await client.rpc('save_ai_usage', {
    p_used: Number(usage.used) || 0,
    p_used_period: Number(usage.usedPeriod) || 0,
    p_period_start: usage.periodStart || null,
    p_period_kind: usage.periodKind || 'day',
  });
  if (rpc.error) throw rpc.error;
  return rpc.data || null;
}

function localAiOwner(ctx) {
  if (ctx && ctx.user && (ctx.user.id || ctx.user.email)) return `user:${String(ctx.user.id || ctx.user.email).toLowerCase()}`;
  return ctx && ctx.guestKey ? `guest:${ctx.guestKey}` : '';
}

function readLocalAiUsage(ctx, plan) {
  const owner = localAiOwner(ctx);
  const store = Store.load();
  const row = owner && store.aiUsage ? store.aiUsage[owner] : null;
  return mapAiUsageRow(row, plan);
}

function writeLocalAiUsage(ctx, usage) {
  const owner = localAiOwner(ctx);
  if (!owner) return;
  const store = Store.load();
  store.aiUsage = store.aiUsage || {};
  store.aiUsage[owner] = {
    used: Number(usage.used) || 0,
    used_period: Number(usage.usedPeriod) || 0,
    period_start: usage.periodStart || null,
    period_kind: usage.periodKind || 'day',
  };
  Store.save(store);
}

async function loadAiUsage(ctx) {
  const hint = 'Supabase SQL 편집기에서 supabase-ai-usage.sql 파일을 실행해 주세요.';
  const plan = await resolvePlanId(ctx);
  if (!(ctx && ctx.accessToken)) {
    /* 비회원(또는 레거시 세션)은 공용 행을 쓰지 않고 쿠키별로 따로 센다 */
    return { usage: readLocalAiUsage(ctx, plan), source: 'local', plan };
  }
  const client = studyStatsClient(ctx.accessToken);
  if (!client) return { usage: readLocalAiUsage(ctx, plan), source: 'local', hint, plan };
  try {
    const row = await getAiUsageRemote(client);
    const usage = mapAiUsageRow(row, plan);
    if (!row || String(row.period_start || '').slice(0, 10) !== usage.periodStart) {
      await saveAiUsageRemote(client, usage);
    }
    return { usage, source: 'supabase', plan };
  } catch (err) {
    if (!isMissingWrongNotesFn(err)) console.warn('ai_usage load', err.message || err);
    return {
      usage: readLocalAiUsage(ctx, plan),
      source: 'local',
      plan,
      hint: isMissingWrongNotesFn(err) ? hint : err.message || hint,
    };
  }
}

async function bumpAiUsage(ctx) {
  const loaded = await loadAiUsage(ctx);
  const usage = loaded.usage;
  usage.used += 1;
  usage.usedPeriod += 1;
  usage.remaining = remainingOf(usage.limit, usage.usedPeriod);
  const client = studyStatsClient(ctx && ctx.accessToken);
  if (client && loaded.source === 'supabase') {
    try {
      await saveAiUsageRemote(client, usage);
    } catch (err) {
      if (!isMissingWrongNotesFn(err)) console.warn('ai_usage bump', err.message || err);
      writeLocalAiUsage(ctx, usage);
    }
  } else {
    writeLocalAiUsage(ctx, usage);
  }
  return { ...loaded, usage };
}

async function getQuestionUsageRemote(client) {
  if (!client) return null;
  const rpc = await client.rpc('get_question_usage');
  if (rpc.error) throw rpc.error;
  const row = Array.isArray(rpc.data) ? rpc.data[0] : rpc.data;
  return row || null;
}

async function saveQuestionUsageRemote(client, usage) {
  if (!client || !usage) return null;
  const rpc = await client.rpc('save_question_usage', {
    p_used: Number(usage.used) || 0,
    p_used_period: Number(usage.usedPeriod) || 0,
    p_period_start: usage.periodStart || null,
    p_period_kind: usage.periodKind || 'day',
  });
  if (rpc.error) throw rpc.error;
  return rpc.data || null;
}

function userStudyId(ctx) {
  return (ctx && ctx.user && ctx.user.id) || '';
}

function readStudyLogFor(ctx) {
  const store = Store.load();
  const uid = userStudyId(ctx);
  if (uid && store.studyLogsByUser && store.studyLogsByUser[uid] && typeof store.studyLogsByUser[uid] === 'object') {
    return store.studyLogsByUser[uid];
  }
  return store.studyLog || {};
}

function writeStudyLogEntry(ctx, subject, index, item) {
  const store = Store.load();
  if (!store.studyLog || typeof store.studyLog !== 'object') store.studyLog = {};
  if (!store.studyLog[subject]) store.studyLog[subject] = {};
  store.studyLog[subject][index] = item;
  const uid = userStudyId(ctx);
  if (uid) {
    if (!store.studyLogsByUser || typeof store.studyLogsByUser !== 'object') store.studyLogsByUser = {};
    if (!store.studyLogsByUser[uid]) store.studyLogsByUser[uid] = {};
    if (!store.studyLogsByUser[uid][subject]) store.studyLogsByUser[uid][subject] = {};
    store.studyLogsByUser[uid][subject][index] = item;
  }
  Store.save(store);
  return store;
}

function persistStudySnapshot(ctx, studyLog, answers) {
  Promise.all([
    syncStudyStats(ctx, studyLog, answers, { force: true }),
    syncSubjectGrades(ctx, studyLog, answers, { force: true }),
    syncWeakness(ctx, studyLog, answers, { force: true }),
  ]).catch((err) => console.warn('study snapshot', err && err.message));
}

function readLocalQuestionUsage(plan) {
  const store = Store.load();
  return mapQuestionUsageRow(store.questionUsage, plan);
}

function writeLocalQuestionUsage(usage) {
  const store = Store.load();
  store.questionUsage = {
    used: Number(usage.used) || 0,
    usedPeriod: Number(usage.usedPeriod) || 0,
    period_start: usage.periodStart || null,
    periodStart: usage.periodStart || null,
    period_kind: usage.periodKind || 'day',
    periodKind: usage.periodKind || 'day',
  };
  Store.save(store);
}

async function loadQuestionUsage(ctx) {
  const hint = 'Supabase SQL 편집기에서 supabase-question-usage.sql 파일을 실행해 주세요.';
  const plan = await resolvePlanId(ctx);
  const local = readLocalQuestionUsage(plan);
  const client = studyStatsClient(ctx && ctx.accessToken);
  if (!client) return { usage: local, source: 'local', hint, plan };
  try {
    const row = await getQuestionUsageRemote(client);
    const usage = mapQuestionUsageRow(row, plan);
    if (!row || String(row.period_start || '').slice(0, 10) !== usage.periodStart) {
      await saveQuestionUsageRemote(client, usage);
    }
    return { usage, source: 'supabase', plan };
  } catch (err) {
    if (!isMissingWrongNotesFn(err)) console.warn('question_usage load', err.message || err);
    return {
      usage: local,
      source: 'local',
      plan,
      hint: isMissingWrongNotesFn(err) ? hint : err.message || hint,
    };
  }
}

async function bumpQuestionUsage(ctx, loaded) {
  const current = loaded || (await loadQuestionUsage(ctx));
  const usage = current.usage;
  usage.used += 1;
  usage.usedPeriod += 1;
  usage.remaining = remainingOf(usage.limit, usage.usedPeriod);
  const client = studyStatsClient(ctx && ctx.accessToken);
  if (client && current.source === 'supabase') {
    try {
      await saveQuestionUsageRemote(client, usage);
    } catch (err) {
      if (!isMissingWrongNotesFn(err)) console.warn('question_usage bump', err.message || err);
      writeLocalQuestionUsage(usage);
    }
  } else {
    writeLocalQuestionUsage(usage);
  }
  return { ...current, usage };
}

async function consumeQuestion(ctx, prev) {
  const loaded = await loadQuestionUsage(ctx);
  if (alreadyCountedToday(prev)) return { ...loaded, consumed: false };
  const usage = loaded.usage;
  if (usage.limit != null && Number(usage.remaining) <= 0) {
    const err = new Error(questionQuotaMessage(usage));
    err.status = 429;
    err.usage = usage;
    err.hint = loaded.hint;
    throw err;
  }
  const bumped = await bumpQuestionUsage(ctx, loaded);
  return { ...bumped, consumed: true };
}

async function entitlementsPayload(ctx) {
  const plan = await resolvePlanId(ctx);
  const pack = planEntitlements(plan);
  const questions = await loadQuestionUsage(ctx);
  const ai = await loadAiUsage(ctx);
  return {
    plan,
    features: pack.features,
    questions: questions.usage,
    ai: ai.usage,
    source: questions.source === 'supabase' || ai.source === 'supabase' ? 'supabase' : 'local',
    hint: questions.hint || ai.hint,
  };
}

async function getStudyStatsRemote(client) {
  if (!client) return null;
  const rpc = await client.rpc('get_study_stats');
  if (rpc.error) throw rpc.error;
  const row = Array.isArray(rpc.data) ? rpc.data[0] : rpc.data;
  return mapStudyStatsRow(row);
}

async function saveStudyStatsRemote(client, stats) {
  if (!client || !stats) return null;
  const dates = Array.isArray(stats.studyDates) ? stats.studyDates : [];
  const rpc = await client.rpc('save_study_stats', {
    p_attempted: Number(stats.attempted) || 0,
    p_correct: Number(stats.correct) || 0,
    p_study_days: Number(stats.studyDays) || 0,
    p_streak: Number(stats.streak) || 0,
    p_study_dates: dates,
  });
  if (rpc.error) throw rpc.error;
  return mapStudyStatsRow(rpc.data);
}

async function computeStudyStats(studyLog, answers) {
  const attempts = collectStudyAttempts(studyLog, answers);
  return statsFromAttempts(attempts);
}

async function syncStudyStats(ctx, studyLog, answers, options = {}) {
  const hint = 'Supabase SQL 편집기에서 supabase-study-stats.sql 파일을 실행해 주세요.';
  const local = await computeStudyStats(studyLog, answers);
  const client = studyStatsClient(ctx.accessToken);
  if (!client) return { stats: local, source: 'local', hint };
  try {
    if (ctx.accessToken) {
      /* 로그인 회원의 기록을 매번 비회원 공용 행과 합치지 않습니다. */
    }
    let remote = await getStudyStatsRemote(client);
    const localAhead =
      local.attempted > ((remote && remote.attempted) || 0) ||
      local.studyDays > ((remote && remote.studyDays) || 0) ||
      (local.attempted === ((remote && remote.attempted) || 0) &&
        local.correct !== ((remote && remote.correct) || 0));
    if (!remote || options.force || (local.attempted > 0 && localAhead)) {
      remote = await saveStudyStatsRemote(client, local);
    }
    return { stats: remote || local, source: 'supabase' };
  } catch (err) {
    if (!isMissingWrongNotesFn(err)) console.warn('study_stats sync', err.message || err);
    return {
      stats: local,
      source: 'local',
      hint: isMissingWrongNotesFn(err) ? hint : err.message || hint,
    };
  }
}

const GRADE_SUBJECTS = [
  { id: 'korean', title: '9급 국어', short: '국어' },
  { id: 'english', title: '9급 영어', short: '영어' },
  { id: 'history', title: '한국사', short: '한국사' },
  { id: 'adminlaw', title: '행정법', short: '행정법' },
  { id: 'adminsci', title: '행정학', short: '행정학' },
  { id: 'peducation', title: '교육학개론', short: '교육학' },
  { id: 'localtax', title: '지방세법', short: '지방세법' },
  { id: 'accounting', title: '회계학', short: '회계학' },
  { id: 'socialwelfare', title: '사회복지학개론', short: '사회복지' },
];

function gradeDifficulty(rate, total) {
  if (!total) return 'empty';
  if (rate >= 70) return 'high';
  if (rate >= 60) return 'mid';
  return 'low';
}

function mapSubjectGradeRow(row) {
  if (!row || typeof row !== 'object') return null;
  const id = resolveSubjectCode(row.subjects || row.id) || String(row.subjects || row.id || '').trim();
  if (!id) return null;
  const meta = GRADE_SUBJECTS.find((item) => item.id === id);
  const total = Number(row.total) || 0;
  const correct = Number(row.correct) || 0;
  const attempted = Number(row.attempted) || 0;
  const rate = Number(row.rate != null ? row.rate : row.totalRate) || 0;
  return {
    id,
    subjects: id,
    title: row.title || (meta && meta.title) || id,
    short: (meta && meta.short) || id,
    total,
    attempted,
    correct,
    rate,
    totalRate: rate,
    difficulty: row.difficulty || gradeDifficulty(rate, total),
  };
}

function gradesScore(rows) {
  return (Array.isArray(rows) ? rows : []).reduce(
    (sum, row) => sum + (Number(row.correct) || 0) * 1000 + (Number(row.attempted) || 0),
    0
  );
}

function collectSubjectProgress(studyLog, answers) {
  const bySubject = new Map();
  const bump = (id, correct) => {
    if (!id) return;
    const cur = bySubject.get(id) || { attempted: 0, correct: 0 };
    cur.attempted += 1;
    if (correct) cur.correct += 1;
    bySubject.set(id, cur);
  };
  Object.entries(studyLog || {}).forEach(([subject, byIndex]) => {
    const id = resolveSubjectCode(subject) || subject;
    Object.values(byIndex || {}).forEach((item) => {
      if (item) bump(id, !!item.correct);
    });
  });
  if (bySubject.size) return bySubject;
  (Array.isArray(answers) ? answers : []).forEach((row) => {
    const id = resolveSubjectCode(row.subjects) || resolveSubjectCode(rowSubject(row));
    bump(id, !!row.is_correct);
  });
  return bySubject;
}

async function computeSubjectGrades(studyLog, answers) {
  const progress = collectSubjectProgress(studyLog, answers);
  const counts = cachedQuestionCounts();
  return GRADE_SUBJECTS.map((meta) => {
    const total = Number(counts[meta.id]) || 0;
    const row = progress.get(meta.id) || { attempted: 0, correct: 0 };
    const denom = total || row.attempted;
    const rate = denom ? Math.round((row.correct / denom) * 100) : 0;
    return {
      id: meta.id,
      subjects: meta.id,
      title: meta.title,
      short: meta.short,
      total,
      attempted: row.attempted,
      correct: row.correct,
      rate,
      totalRate: rate,
      difficulty: gradeDifficulty(rate, total || row.attempted),
    };
  });
}

async function listSubjectGradesRemote(client) {
  if (!client) return [];
  const rpc = await client.rpc('list_subject_grades');
  if (rpc.error) throw rpc.error;
  return (rpc.data || []).map(mapSubjectGradeRow).filter(Boolean);
}

async function saveSubjectGradesRemote(client, rows) {
  if (!client) return [];
  const payload = (Array.isArray(rows) ? rows : []).map((row) => ({
    subjects: row.id || row.subjects,
    title: row.title,
    total: Number(row.total) || 0,
    attempted: Number(row.attempted) || 0,
    correct: Number(row.correct) || 0,
    rate: Number(row.rate != null ? row.rate : row.totalRate) || 0,
    difficulty: row.difficulty || gradeDifficulty(row.rate, row.total),
  }));
  const rpc = await client.rpc('save_subject_grades', { p_rows: payload });
  if (rpc.error) throw rpc.error;
  return (rpc.data || []).map(mapSubjectGradeRow).filter(Boolean);
}

async function syncSubjectGrades(ctx, studyLog, answers, options = {}) {
  const hint = 'Supabase SQL 편집기에서 supabase-subject-grades.sql 파일을 실행해 주세요.';
  const local = await computeSubjectGrades(studyLog, answers);
  const client = studyStatsClient(ctx.accessToken);
  if (!client) return { grades: local, source: 'local', hint };
  try {
    let remote = await listSubjectGradesRemote(client);
    if (!remote.length || options.force || gradesScore(local) > gradesScore(remote)) {
      remote = await saveSubjectGradesRemote(client, local);
    }
    return { grades: remote.length ? remote : local, source: 'supabase' };
  } catch (err) {
    if (!isMissingWrongNotesFn(err)) console.warn('subject_grades sync', err.message || err);
    return {
      grades: local,
      source: 'local',
      hint: isMissingWrongNotesFn(err) ? hint : err.message || hint,
    };
  }
}

const KOREAN_WEAK_AREAS = ['작문', '독해', '논리', '화법', '문학', '문법'];

function topicFamilyName(topic) {
  return String(topic || '').split('·')[0].trim();
}

function topicShortName(topic) {
  const parts = String(topic || '')
    .split('·')
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] : parts[0] || String(topic || '');
}

function hasKoreanJong(text) {
  const ch = String(text || '')[String(text || '').length - 1];
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  if (code < 0xac00 || code > 0xd7a3) return false;
  return (code - 0xac00) % 28 !== 0;
}

function koreanWeakArea(type) {
  const text = String(type || '').trim();
  if (!text) return '';
  const prefix = text.match(/^(작문|독해|논리|화법|문학|문법)(?=\s*[:·\-\/]|$)/);
  if (prefix) return prefix[1];
  const found = KOREAN_WEAK_AREAS.find((area) => text.includes(area));
  if (found) return found;
  return text.split(/[:·\/]/)[0].trim();
}

function uniqueAreaNames(topics) {
  const names = [];
  topics.forEach((topic) => {
    const name = topicShortName(topic);
    if (name && !names.includes(name)) names.push(name);
  });
  return names.slice(0, 2);
}

function joinAreaNames(names) {
  if (!names.length) return '';
  if (names.length === 1) return names[0];
  return `${names[0]}${hasKoreanJong(names[0]) ? '과' : '와'} ${names[1]}`;
}

function weakAnalysisText(topics) {
  const names = uniqueAreaNames(topics);
  if (!names.length) return '아직 특정 영역의 오답 패턴이 충분하지 않습니다.';
  return `${joinAreaNames(names)} 영역에서 오답률이 높습니다.`;
}

function idFromSubjectIndex(maps, subject, index) {
  const indexById = maps.get(subject);
  if (!indexById) return null;
  const wanted = Number(index);
  for (const [id, qi] of indexById.entries()) {
    if (qi === wanted) return id;
  }
  return null;
}

function collectWeakAttempts(studyLog, answers) {
  const map = new Map();
  Object.entries(studyLog || {}).forEach(([subject, byIndex]) => {
    const id = resolveSubjectCode(subject) || subject;
    Object.entries(byIndex || {}).forEach(([index, item]) => {
      if (!item) return;
      const qid = Number(item.questionId);
      const key = Number.isFinite(qid) && qid > 0 ? `q:${qid}` : `${id}:${index}`;
      map.set(key, {
        subject: id,
        index: Number(index),
        correct: !!item.correct,
        questionId: Number.isFinite(qid) && qid > 0 ? qid : null,
        topic: String(item.topic || '').trim(),
      });
    });
  });
  if (map.size) return [...map.values()];
  (Array.isArray(answers) ? answers : []).forEach((row) => {
    const qid = Number(row.question_id);
    const subject =
      resolveSubjectCode(row.subjects) ||
      resolveSubjectCode(rowSubject(row)) ||
      'unknown';
    const key = Number.isFinite(qid) && qid > 0 ? `q:${qid}` : `${subject}:${map.size}`;
    map.set(key, {
      subject,
      index: -1,
      correct: !!row.is_correct,
      questionId: Number.isFinite(qid) && qid > 0 ? qid : null,
      topic: String(row.type || row.topic || '').trim(),
    });
  });
  return [...map.values()];
}

function buildWeaknessReports(attempts) {
  const bySubject = new Map();
  attempts.forEach((item) => {
    if (!bySubject.has(item.subject)) bySubject.set(item.subject, []);
    bySubject.get(item.subject).push(item);
  });

  return GRADE_SUBJECTS.map((meta) => {
    const list = bySubject.get(meta.id) || [];
    if (!list.length) return null;

    if (meta.id === 'korean') {
      const byArea = {};
      list.forEach((item) => {
        const area = koreanWeakArea(item.topic);
        if (!area) return;
        if (!byArea[area]) {
          byArea[area] = { area, attempted: 0, correct: 0, wrong: 0, sample_topic: item.topic || area };
        }
        byArea[area].attempted += 1;
        if (item.correct) byArea[area].correct += 1;
        else {
          byArea[area].wrong += 1;
          byArea[area].sample_topic = item.topic || area;
        }
      });
      const ranked = Object.values(byArea)
        .map((row) => ({
          ...row,
          wrong_rate: row.attempted ? Math.round((row.wrong / row.attempted) * 100) : 0,
        }))
        .filter((row) => row.wrong > 0)
        .sort((a, b) => b.wrong_rate - a.wrong_rate || b.wrong - a.wrong);
      if (!ranked.length) return null;
      const weakNames = ranked.slice(0, 2).map((row) => row.area);
      return {
        subjects: 'korean',
        subjectId: 'korean',
        headline: meta.short,
        analysis: weakAnalysisText(weakNames),
        drillTopic: weakNames.join(','),
        drillLabel: `${joinAreaNames(weakNames)} 문제 5개 풀기`,
        areas: ranked,
      };
    }

    const byTopic = {};
    list.forEach((item) => {
      const topic = item.topic || '기타';
      if (!byTopic[topic]) {
        byTopic[topic] = { topic, attempted: 0, correct: 0, wrong: 0 };
      }
      byTopic[topic].attempted += 1;
      if (item.correct) byTopic[topic].correct += 1;
      else byTopic[topic].wrong += 1;
    });
    const topics = Object.values(byTopic)
      .map((row) => ({
        ...row,
        rate: row.attempted ? Math.round((row.correct / row.attempted) * 100) : 0,
        family: topicFamilyName(row.topic),
      }))
      .filter((row) => row.wrong > 0);
    if (!topics.length) return null;

    const familyWrong = {};
    topics.forEach((row) => {
      familyWrong[row.family] = (familyWrong[row.family] || 0) + row.wrong;
    });
    const weakTopics = [...topics].sort((a, b) => a.rate - b.rate || b.wrong - a.wrong);
    const weakNames = uniqueAreaNames(weakTopics.slice(0, 2).map((row) => row.topic));
    const areas = weakTopics.map((row) => ({
      area: topicShortName(row.topic) || row.family || row.topic,
      attempted: row.attempted,
      correct: row.correct,
      wrong: row.wrong,
      wrong_rate: row.attempted ? Math.round((row.wrong / row.attempted) * 100) : 0,
      sample_topic: row.topic,
    }));
    return {
      subjects: meta.id,
      subjectId: meta.id,
      headline: meta.short,
      analysis: weakAnalysisText(weakTopics.slice(0, 2).map((row) => row.topic)),
      drillTopic: weakNames.join(','),
      drillLabel: `${joinAreaNames(weakNames)} 문제 5개 풀기`,
      areas,
    };
  }).filter(Boolean);
}

function mapWeaknessReport(row) {
  if (!row || typeof row !== 'object') return null;
  const id = resolveSubjectCode(row.subjects || row.subjectId) || String(row.subjects || row.subjectId || '').trim();
  if (!id) return null;
  const meta = GRADE_SUBJECTS.find((item) => item.id === id);
  const areas = Array.isArray(row.areas)
    ? row.areas.map((area) => ({
        area: area.area || area.name || '',
        attempted: Number(area.attempted) || 0,
        correct: Number(area.correct) || 0,
        wrong: Number(area.wrong) || 0,
        wrong_rate: Number(area.wrong_rate != null ? area.wrong_rate : area.wrongRate) || 0,
        sample_topic: area.sample_topic || area.sampleTopic || '',
      })).filter((area) => area.area)
    : [];
  return {
    subjectId: id,
    subjects: id,
    headline: row.headline || (meta && meta.short) || id,
    analysis: row.analysis || '',
    drillTopic: row.drill_topic || row.drillTopic || '',
    drillLabel: row.drill_label || row.drillLabel || '',
    areas,
  };
}

function weaknessScore(rows) {
  return (Array.isArray(rows) ? rows : []).reduce(
    (sum, row) =>
      sum +
      (Array.isArray(row.areas) ? row.areas : []).reduce((n, area) => n + (Number(area.wrong) || 0), 0),
    0
  );
}

async function computeWeakness(studyLog, answers) {
  const attempts = collectWeakAttempts(studyLog, answers);
  return buildWeaknessReports(attempts);
}

async function listWeaknessRemote(client) {
  if (!client) return [];
  const rpc = await client.rpc('list_weakness');
  if (rpc.error) throw rpc.error;
  const rows = Array.isArray(rpc.data) ? rpc.data : rpc.data ? [rpc.data] : [];
  return rows.map(mapWeaknessReport).filter(Boolean);
}

async function saveWeaknessRemote(client, rows) {
  if (!client) return [];
  const payload = (Array.isArray(rows) ? rows : []).map((row) => ({
    subjects: row.subjectId || row.subjects,
    headline: row.headline,
    analysis: row.analysis,
    drill_topic: row.drillTopic || row.drill_topic,
    drill_label: row.drillLabel || row.drill_label,
    areas: (row.areas || []).map((area) => ({
      area: area.area || area.name,
      attempted: Number(area.attempted) || 0,
      correct: Number(area.correct) || 0,
      wrong: Number(area.wrong) || 0,
      wrong_rate: Number(area.wrong_rate != null ? area.wrong_rate : area.wrongRate) || 0,
      sample_topic: area.sample_topic || area.sampleTopic || '',
    })),
  }));
  const rpc = await client.rpc('save_weakness', { p_rows: payload });
  if (rpc.error) throw rpc.error;
  const saved = Array.isArray(rpc.data) ? rpc.data : rpc.data ? [rpc.data] : [];
  return saved.map(mapWeaknessReport).filter(Boolean);
}

async function syncWeakness(ctx, studyLog, answers, options = {}) {
  const hint = 'Supabase SQL 편집기에서 supabase-weak-areas.sql 파일을 실행해 주세요.';
  const local = await computeWeakness(studyLog, answers);
  const client = studyStatsClient(ctx.accessToken);
  if (!client) return { weakness: local, source: 'local', hint };
  try {
    let remote = await listWeaknessRemote(client);
    if (!remote.length || options.force || weaknessScore(local) > weaknessScore(remote)) {
      remote = await saveWeaknessRemote(client, local);
    }
    return { weakness: remote.length ? remote : local, source: 'supabase' };
  } catch (err) {
    if (!isMissingWrongNotesFn(err)) console.warn('weakness sync', err.message || err);
    return {
      weakness: local,
      source: 'local',
      hint: isMissingWrongNotesFn(err) ? hint : err.message || hint,
    };
  }
}

async function questionIndexMaps() {
  const now = Date.now();
  if (questionIndexCache.maps && now - questionIndexCache.at < QUESTION_INDEX_TTL_MS) {
    return questionIndexCache.maps;
  }
  const cfg = supabaseConfig();
  if (!cfg) return new Map();
  const supabase = makeSupabase(cfg);
  const rows = await fetchSupabasePages(() =>
    supabase.from('questions').select('id,subjects').order('id', { ascending: true })
  );
  const bySubject = new Map();
  rows.forEach((row) => {
    const code = resolveSubjectCode(rowSubject(row));
    if (!code || row.id == null) return;
    if (!bySubject.has(code)) bySubject.set(code, []);
    bySubject.get(code).push(Number(row.id));
  });
  const maps = new Map();
  const counts = {};
  bySubject.forEach((ids, code) => {
    const indexById = new Map();
    ids.forEach((id, i) => indexById.set(id, i));
    maps.set(code, indexById);
    counts[code] = ids.length;
  });
  questionIndexCache = { at: now, maps, counts };
  return maps;
}

async function questionsByIds(ids) {
  const unique = [...new Set((ids || []).map(Number).filter((id) => Number.isFinite(id) && id > 0))];
  const map = new Map();
  if (!unique.length) return map;
  const cfg = supabaseConfig();
  if (!cfg) return map;
  const supabase = makeSupabase(cfg);
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const { data, error } = await supabase
      .from('questions')
      .select('id, subjects, type, question')
      .in('id', chunk);
    if (error) continue;
    (data || []).forEach((row) => map.set(Number(row.id), row));
  }
  return map;
}

function mapWrongNoteRow(row, indexMaps, questionMap) {
  const joined =
    row.questions && typeof row.questions === 'object' && !Array.isArray(row.questions)
      ? row.questions
      : Array.isArray(row.questions)
        ? row.questions[0]
        : null;
  const fromTable = questionMap && Number.isFinite(Number(row.question_id))
    ? questionMap.get(Number(row.question_id))
    : null;
  const q = fromTable || joined || {};
  const storedIndex = Number(row.question_index);
  const subject =
    resolveSubjectCode(row.subjects) ||
    resolveSubjectCode(rowSubject(q)) ||
    '';
  const questionId = Number(row.question_id);
  const indexMap = subject && indexMaps ? indexMaps.get(subject) : null;
  let index = Number.isInteger(storedIndex) ? storedIndex : undefined;
  if (!Number.isInteger(index) && indexMap && Number.isFinite(questionId)) {
    index = indexMap.get(questionId);
  }
  if (!Number.isInteger(index) && indexMaps && Number.isFinite(questionId)) {
    indexMaps.forEach((byId) => {
      if (Number.isInteger(index)) return;
      const found = byId.get(questionId);
      if (Number.isInteger(found)) index = found;
    });
  }
  return {
    id: row.id,
    questionId: Number.isFinite(questionId) ? questionId : null,
    subject,
    index: Number.isInteger(index) ? index : -1,
    topic: String(row.topic || q.type || q.topic || '').trim(),
    q: String(row.note || q.question || q.q || '').trim(),
    date: row.last_wrong_at || row.created_at || new Date().toISOString(),
    wrongCount: Number(row.wrong_count) || 1,
    selectedAnswer: row.selected_answer != null ? Number(row.selected_answer) : null,
  };
}

function wrongNotesClient(accessToken) {
  return accessToken ? makeUserSupabase(accessToken) : makeAnonClient();
}

function isMissingWrongNotesFn(error) {
  const msg = String((error && error.message) || '');
  const code = String((error && error.code) || '');
  return (
    code === 'PGRST202' ||
    /could not find the function/i.test(msg) ||
    /schema cache/i.test(msg)
  );
}

async function mapWrongNoteRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const needsLookup = list.some((row) => {
    const storedIndex = Number(row.question_index);
    const note = String(row.note || '').trim();
    const topic = String(row.topic || '').trim();
    const joined =
      row.questions && typeof row.questions === 'object' && !Array.isArray(row.questions)
        ? row.questions
        : Array.isArray(row.questions)
          ? row.questions[0]
          : null;
    const qText = String((joined && (joined.question || joined.q)) || '').trim();
    return !Number.isInteger(storedIndex) || !(note || qText) || !topic;
  });
  const indexMaps = needsLookup ? await questionIndexMaps() : null;
  const questionMap = needsLookup ? await questionsByIds(list.map((row) => row.question_id)) : null;
  return list.map((row) => mapWrongNoteRow(row, indexMaps, questionMap));
}

async function listWrongNotesRemote(client) {
  if (!client) return [];
  const rpc = await client.rpc('list_wrong_notes');
  if (rpc.error) throw rpc.error;
  return mapWrongNoteRows(rpc.data || []);
}

async function saveWrongNoteRemote(client, fields) {
  if (!client) return null;
  const questionId = Number(fields.questionId);
  const index = Number(fields.index);
  const selected = Number(fields.selectedAnswer);
  const payload = {
    p_question_id: Number.isFinite(questionId) && questionId > 0 ? questionId : null,
    p_subjects: fields.subject ? String(fields.subject) : null,
    p_question_index: Number.isInteger(index) ? index : null,
    p_topic: fields.topic ? String(fields.topic) : null,
    p_note: fields.q ? String(fields.q) : null,
    p_selected_answer: Number.isFinite(selected) ? selected : null,
    p_last_wrong_at: fields.date || new Date().toISOString(),
    p_increment: fields.increment !== false,
  };
  let result = await client.rpc('upsert_wrong_note', payload);
  if (result.error && payload.p_question_id && /foreign key|question_id/i.test(result.error.message || '')) {
    result = await client.rpc('upsert_wrong_note', { ...payload, p_question_id: null });
  }
  if (result.error) throw result.error;
  return result.data || null;
}

async function deleteWrongNoteRemote(client, fields) {
  if (!client) return false;
  const questionId = Number(fields && fields.questionId);
  const index = Number(fields && fields.index);
  const { error } = await client.rpc('delete_wrong_note', {
    p_question_id: Number.isFinite(questionId) && questionId > 0 ? questionId : null,
    p_subjects: fields && fields.subject ? String(fields.subject) : null,
    p_question_index: Number.isInteger(index) ? index : null,
    p_all: !!(fields && fields.all),
  });
  if (error) throw error;
  return true;
}

async function migrateLocalWrongNotes(client) {
  const store = Store.load();
  if (store.wrongNotesSynced) return;
  const local = Array.isArray(store.wrongNotes) ? store.wrongNotes : [];
  if (!local.length) {
    store.wrongNotesSynced = true;
    Store.save(store);
    return;
  }
  for (const item of local) {
    try {
      const questionId = await resolveQuestionId(item.subject, item.index, item.questionId);
      await saveWrongNoteRemote(client, {
        questionId,
        subject: item.subject,
        index: item.index,
        topic: item.topic,
        q: item.q,
        selectedAnswer: item.selectedAnswer,
        date: item.date,
        increment: false,
      });
    } catch (err) {
      console.warn('wrong_notes migrate', err.message || err);
    }
  }
  const notes = await listWrongNotesRemote(client);
  if (notes.length) {
    store.wrongNotesSynced = true;
    Store.save(store);
  }
}

async function listAuthWrongNotes(accessToken, userId) {
  const supabase = makeUserSupabase(accessToken);
  if (!supabase || !userId) return [];
  try {
    return await listWrongNotesRemote(supabase);
  } catch (err) {
    if (!isMissingWrongNotesFn(err)) throw err;
  }
  let rows = [];
  const joined = await supabase
    .from('wrong_notes')
    .select(
      'id, user_id, question_id, subjects, question_index, topic, note, wrong_count, last_wrong_at, selected_answer, questions(id, subjects, type, question)'
    )
    .eq('user_id', userId)
    .order('last_wrong_at', { ascending: false });
  if (joined.error) {
    const plain = await supabase
      .from('wrong_notes')
      .select('id, user_id, question_id, note, wrong_count, last_wrong_at, selected_answer')
      .eq('user_id', userId)
      .order('last_wrong_at', { ascending: false });
    if (plain.error) return [];
    rows = plain.data || [];
  } else {
    rows = joined.data || [];
  }
  return mapWrongNoteRows(rows);
}

async function saveAuthWrongNote(accessToken, userId, fields) {
  const supabase = makeUserSupabase(accessToken);
  if (!supabase || !userId) return null;
  try {
    return await saveWrongNoteRemote(supabase, fields);
  } catch (err) {
    if (!isMissingWrongNotesFn(err)) {
      console.warn('wrong_notes save', err.message || err);
      return null;
    }
  }
  const questionId = Number(fields.questionId);
  if (!Number.isFinite(questionId) || questionId <= 0) return null;
  const selected = Number(fields.selectedAnswer);
  const payload = {
    last_wrong_at: fields.date || new Date().toISOString(),
    subjects: fields.subject || null,
    question_index: Number.isInteger(Number(fields.index)) ? Number(fields.index) : null,
    topic: fields.topic || null,
    note: fields.q || null,
  };
  if (Number.isFinite(selected)) payload.selected_answer = selected;
  const { data: existing } = await supabase
    .from('wrong_notes')
    .select('id, wrong_count')
    .eq('user_id', userId)
    .eq('question_id', questionId)
    .maybeSingle();
  if (existing && existing.id) {
    const { error } = await supabase
      .from('wrong_notes')
      .update({
        ...payload,
        wrong_count: fields.increment === false ? Number(existing.wrong_count) || 1 : (Number(existing.wrong_count) || 1) + 1,
      })
      .eq('id', existing.id);
    if (error) return null;
    return existing;
  }
  const { data, error } = await supabase
    .from('wrong_notes')
    .insert({
      user_id: userId,
      question_id: questionId,
      wrong_count: 1,
      ...payload,
    })
    .select('*')
    .maybeSingle();
  if (error) return null;
  return data;
}

async function deleteAuthWrongNote(accessToken, userId, questionId) {
  const supabase = makeUserSupabase(accessToken);
  if (!supabase || !userId) return false;
  try {
    return await deleteWrongNoteRemote(supabase, { questionId, all: questionId == null });
  } catch (err) {
    if (!isMissingWrongNotesFn(err)) return false;
  }
  if (questionId == null) {
    const { error } = await supabase.from('wrong_notes').delete().eq('user_id', userId);
    return !error;
  }
  const { error } = await supabase
    .from('wrong_notes')
    .delete()
    .eq('user_id', userId)
    .eq('question_id', questionId);
  return !error;
}

async function resolveQuestionId(subject, index, questionId) {
  const direct = Number(questionId);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const wanted = resolveSubjectCode(subject);
  if (!wanted || !Number.isInteger(index) || index < 0) return null;
  const maps = await questionIndexMaps();
  const indexById = maps.get(wanted);
  if (!indexById) return null;
  for (const [id, qi] of indexById.entries()) {
    if (qi === index) return id;
  }
  return null;
}

async function loadWrongNotes(ctx) {
  const client = wrongNotesClient(ctx.accessToken);
  const local = () => Store.load().wrongNotes || [];
  const hint = 'Supabase SQL 편집기에서 supabase-wrong-notes.sql 파일을 실행해 주세요.';
  if (!client) {
    return { notes: local(), source: 'local', hint };
  }
  try {
    await migrateLocalWrongNotes(client);
    const notes = await listWrongNotesRemote(client);
    return { notes, source: 'supabase' };
  } catch (err) {
    if (isMissingWrongNotesFn(err)) {
      if (ctx.accessToken && ctx.user && ctx.user.id) {
        try {
          const notes = await listAuthWrongNotes(ctx.accessToken, ctx.user.id);
          if (notes.length) return { notes, source: 'supabase' };
        } catch {
          /* fall through */
        }
      }
      return { notes: local(), source: 'local', hint };
    }
    console.warn('wrong_notes load', err.message || err);
    return { notes: local(), source: 'local', hint: err.message || hint };
  }
}

async function authSignUp({ name, email, password }) {
  const supabase = makeAnonClient();
  if (!supabase) throw noSupabaseError();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { name, nickname: name, provider: 'email' } },
  });
  if (error) throw translateAuthError(error, '회원가입에 실패했습니다.');
  const identities = data && data.user && Array.isArray(data.user.identities) ? data.user.identities : null;
  if (data && data.user && identities && identities.length === 0 && !data.session) {
    const err = new Error('이미 가입된 이메일입니다.');
    err.status = 409;
    throw err;
  }
  let session = data.session;
  let user = data.user;
  if (!session) {
    const again = await supabase.auth.signInWithPassword({ email, password });
    if (again.error) throw translateAuthError(again.error, '가입은 되었지만 바로 로그인할 수 없습니다.');
    session = again.data.session;
    user = again.data.user || user;
  }
  if (!session) {
    const err = new Error('가입은 되었지만 이메일 확인이 필요합니다. Supabase Authentication → Providers → Email에서 Confirm email을 꺼 주세요.');
    err.status = 403;
    throw err;
  }
  return { user, session };
}

async function authLogin({ email, password }) {
  const supabase = makeAnonClient();
  if (!supabase) throw noSupabaseError();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw translateAuthError(error, '로그인에 실패했습니다.');
  return { user: data.user, session: data.session };
}

function socialAuthEmail(profile) {
  const real = String(profile.email || '').trim().toLowerCase();
  if (real.includes('@')) return real;
  const id = String(profile.providerId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  return `${profile.provider}.${id}@oauth.passcoach.app`;
}

function socialAuthPassword(provider, providerId) {
  const secret = (process.env.SUPABASE_ANON_KEY || DEFAULT_SUPABASE_ANON_KEY || 'passcoach').slice(0, 80);
  return `${crypto.createHmac('sha256', secret).update(`passcoach:${provider}:${providerId}`).digest('hex')}Aa1!`;
}

async function authSignInOrSignUp({ email, password, name, metadata, allowFallback }) {
  const supabase = makeAnonClient();
  if (!supabase) throw noSupabaseError();
  const signedIn = await supabase.auth.signInWithPassword({ email, password });
  if (!signedIn.error && signedIn.data.session) {
    return { user: signedIn.data.user, session: signedIn.data.session };
  }
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { name, nickname: name, ...metadata } },
  });
  if (error) {
    if (allowFallback && /already/i.test(error.message || '')) {
      const fallback = `${metadata.provider}.${metadata.provider_id}@oauth.passcoach.app`;
      if (fallback !== email) {
        return authSignInOrSignUp({
          email: fallback,
          password,
          name,
          metadata,
          allowFallback: false,
        });
      }
    }
    throw translateAuthError(error, '소셜 로그인에 실패했습니다.');
  }
  let session = data.session;
  let user = data.user;
  if (!session) {
    const again = await supabase.auth.signInWithPassword({ email, password });
    if (again.error) {
      if (allowFallback) {
        const fallback = `${metadata.provider}.${metadata.provider_id}@oauth.passcoach.app`;
        if (fallback !== email) {
          return authSignInOrSignUp({
            email: fallback,
            password,
            name,
            metadata,
            allowFallback: false,
          });
        }
      }
      throw translateAuthError(again.error, '소셜 로그인에 실패했습니다.');
    }
    session = again.data.session;
    user = again.data.user || user;
  }
  return { user, session };
}

async function completeSocialLogin(res, profile) {
  const name =
    profile.name ||
    (profile.provider === 'kakao' ? '카카오 사용자' : profile.provider === 'google' ? '구글 사용자' : '네이버 사용자');
  const metadata = {
    provider: profile.provider,
    provider_id: String(profile.providerId),
  };
  const { user, session } = await authSignInOrSignUp({
    email: socialAuthEmail(profile),
    password: socialAuthPassword(profile.provider, profile.providerId),
    name,
    metadata,
    allowFallback: true,
  });
  await startAuthSession(res, session, user);
  redirect(res, '/index.html');
}

async function signOutAuth(accessToken) {
  const cfg = supabaseConfig();
  if (!cfg || !accessToken) return;
  try {
    await fetch(`${cfg.url}/auth/v1/logout`, {
      method: 'POST',
      headers: {
        apikey: cfg.key,
        Authorization: `Bearer ${accessToken}`,
      },
    });
  } catch {
    /* ignore */
  }
}

function joinedLabel(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .format(d)
      .replace(/-/g, '.');
  } catch {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
  }
}

function dateOrNull(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const match = raw.match(/^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})$/);
  if (!match) return null;
  return `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`;
}

function accountFromProfile(profile, fallback) {
  const base = { ...Store.DEFAULT_ACCOUNT, ...(fallback || {}) };
  const created =
    (profile && profile.joined_on) ||
    (fallback && fallback.created_at) ||
    (profile && profile.created_at) ||
    '';
  const joined = joinedLabel(created) || (base.joined === '2024.01.15' ? '' : base.joined);
  if (!profile || typeof profile !== 'object') return { ...base, joined };
  return {
    ...base,
    name: profile.nickname || profile.name || base.name,
    email: profile.email || base.email,
    goal: profile.target_exam != null ? profile.target_exam : base.goal,
    targetDate: profile.target_date || base.targetDate || '',
    joined,
    subjects: Array.isArray(profile.subjects) ? profile.subjects : base.subjects,
    dailyTarget: Number(profile.daily_target) > 0 ? Number(profile.daily_target) : base.dailyTarget,
    notify: { ...base.notify, ...(profile.notify || {}) },
  };
}

function emptyAccountFromUser(user) {
  return {
    ...Store.DEFAULT_ACCOUNT,
    name: (user && user.name) || '',
    email: (user && user.email) || '',
    joined: joinedLabel(user && user.created_at),
    goal: '',
    targetDate: '',
    subjects: [],
    dailyTarget: 30,
    notify: { study: true, review: true, event: false },
  };
}

async function syncAuthMetadata(req, { name, email }) {
  const cookies = Store.parseCookies(req);
  const supabase = makeAnonClient();
  if (!supabase || !cookies.passcoach_access || !cookies.passcoach_refresh) return null;
  const { data, error } = await supabase.auth.setSession({
    access_token: cookies.passcoach_access,
    refresh_token: cookies.passcoach_refresh,
  });
  if (error || !data.session) return null;
  const payload = {};
  if (name) payload.data = { name, nickname: name };
  if (email) payload.email = email;
  if (!Object.keys(payload).length) return data.session.user;
  const updated = await supabase.auth.updateUser(payload);
  if (updated.error) throw translateAuthError(updated.error, '계정 정보를 바꾸지 못했습니다.');
  return updated.data.user;
}

function mapNoticeRow(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    id: row.id,
    title: row.title || '',
    content: row.content || '',
    pinned: !!row.pinned,
    author_id: row.author_id || null,
    author_name: row.author_name || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function noticeFail(error, fallback) {
  const msg = String((error && error.message) || '');
  const err = new Error(fallback || '공지 요청에 실패했습니다.');
  if (/does not exist|schema cache|could not find the table|PGRST205|relation .*notices/i.test(msg)) {
    err.message = '공지사항 테이블이 없습니다. supabase-notices.sql을 실행해 주세요.';
    err.status = 503;
    err.hint = 'Supabase SQL 편집기에서 supabase-notices.sql 파일을 실행해 주세요.';
    return err;
  }
  if (FREE_PERIOD && /permission denied/i.test(msg) && /select|table notices/i.test(msg)) {
    err.message = '비회원 공지 읽기 권한이 없습니다. supabase-free-period.sql을 실행해 주세요.';
    err.status = 503;
    err.hint = 'Supabase SQL 편집기에서 supabase-free-period.sql 파일을 실행해 주세요.';
    return err;
  }
  if (/row-level security|permission denied|42501/i.test(msg)) {
    err.message = '관리자만 공지를 작성·수정·삭제할 수 있습니다.';
    err.status = 403;
    return err;
  }
  if (msg) err.message = msg;
  err.status = (error && error.status) || 400;
  return err;
}

async function isNoticeAdmin(ctx) {
  if (!ctx || !ctx.user || !ctx.accessToken || !ctx.user.id) return false;
  const supabase = makeUserSupabase(ctx.accessToken);
  if (!supabase) return false;
  const { data, error } = await supabase.from('profiles').select('is_admin').eq('id', ctx.user.id).maybeSingle();
  if (error) return false;
  return !!(data && data.is_admin);
}

function noticesClient(ctx) {
  const token = ctx && ctx.accessToken;
  const supabase = token ? makeUserSupabase(token) : null;
  if (!supabase) {
    const err = new Error('공지사항을 불러오지 못했습니다.');
    err.status = 503;
    err.hint = 'Supabase 설정이 필요합니다.';
    throw err;
  }
  return supabase;
}

async function listNoticesFromSupabase(ctx) {
  const supabase = noticesClient(ctx);
  const { data, error } = await supabase
    .from('notices')
    .select('*')
    .order('pinned', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) throw noticeFail(error, '공지사항을 불러오지 못했습니다.');
  return (data || []).map(mapNoticeRow).filter(Boolean);
}

function reportFail(error, fallback) {
  const msg = String((error && error.message) || '');
  const err = new Error(fallback || '오류 신고 요청에 실패했습니다.');
  if (FREE_PERIOD && /permission denied for function|로그인이 필요합니다/i.test(msg)) {
    err.message = '비회원 오류 신고 권한이 없습니다. supabase-free-period.sql을 실행해 주세요.';
    err.status = 503;
    err.hint = 'Supabase SQL 편집기에서 supabase-free-period.sql 파일을 실행해 주세요.';
    return err;
  }
  if (/does not exist|schema cache|could not find the table|PGRST205|function .*report|relation .*reports/i.test(msg)) {
    err.message = '오류 신고 테이블이 없습니다. supabase-reports.sql을 실행해 주세요.';
    err.status = 503;
    err.hint = 'Supabase SQL 편집기에서 supabase-reports.sql 파일을 실행해 주세요.';
    return err;
  }
  if (msg) err.message = msg;
  err.status = /관리자만|비밀번호/.test(msg) ? 403 : (error && error.status) || 400;
  return err;
}

function mapReportSummary(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    id: row.id,
    title: row.title || '',
    created_at: row.created_at,
    has_answer: !!row.has_answer,
  };
}

function mapReportDetail(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    ...mapReportSummary(row),
    content: row.content || '',
    author_name: row.author_name || '',
    answer: row.answer || '',
    answered_at: row.answered_at || null,
    updated_at: row.updated_at,
  };
}

async function callReportRpc(ctx, name, args) {
  const supabase = noticesClient(ctx);
  const { data, error } = await supabase.rpc(name, args || {});
  if (error) throw reportFail(error, '오류 신고 요청에 실패했습니다.');
  return data;
}

function legalFail(error, fallback) {
  const msg = String((error && error.message) || '');
  const err = new Error(fallback || '약관을 불러오지 못했습니다.');
  if (/does not exist|schema cache|could not find the table|PGRST205|relation .*legal_pages/i.test(msg)) {
    err.message = '약관 테이블이 없습니다. supabase-legal.sql을 실행해 주세요.';
    err.status = 503;
    err.hint = 'Supabase SQL 편집기에서 supabase-legal.sql 파일을 실행해 주세요.';
    return err;
  }
  if (msg) err.message = msg;
  err.status = (error && error.status) || 400;
  return err;
}

function mapLegalPage(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    slug: row.slug,
    title: row.title || '',
    lead: row.lead || '',
    content: row.content || '',
    sort_order: Number(row.sort_order) || 0,
    updated_at: row.updated_at || null,
  };
}

const LEGAL_SLUGS = new Set(['terms', 'privacy', 'support']);

async function legalClient() {
  const supabase = makeAnonClient();
  if (!supabase) {
    const err = new Error('약관을 불러오지 못했습니다.');
    err.status = 503;
    err.hint = 'Supabase 설정이 필요합니다.';
    throw err;
  }
  return supabase;
}

async function listLegalPages() {
  const supabase = await legalClient();
  const { data, error } = await supabase
    .from('legal_pages')
    .select('slug,title,lead,content,sort_order,updated_at')
    .order('sort_order', { ascending: true });
  if (error) throw legalFail(error, '약관을 불러오지 못했습니다.');
  return (data || []).map(mapLegalPage).filter(Boolean);
}

async function getLegalPage(slug) {
  const key = String(slug || '').toLowerCase();
  if (!LEGAL_SLUGS.has(key)) return null;
  const supabase = await legalClient();
  const { data, error } = await supabase.from('legal_pages').select('slug,title,lead,content,sort_order,updated_at').eq('slug', key).maybeSingle();
  if (error) throw legalFail(error, '약관을 불러오지 못했습니다.');
  return mapLegalPage(data);
}

async function handleRequest(req, res) {
  setSecurityHeaders(res);
  const restored = incomingUrl(req);
  if (restored && restored !== req.url) req.url = restored;
  const url = decodeURIComponent((req.url || '/').split('?')[0]);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.end();
  }

  if (url === '/api/legal' && req.method === 'GET') {
    try {
      const pages = await listLegalPages();
      return json(res, 200, { pages });
    } catch (err) {
      return json(res, err.status || 400, { error: err.message || '약관을 불러오지 못했습니다.', hint: err.hint });
    }
  }

  const legalMatch = url.match(/^\/api\/legal\/([^/]+)$/);
  if (legalMatch && req.method === 'GET') {
    try {
      const page = await getLegalPage(legalMatch[1]);
      if (!page) return json(res, 404, { error: '항목을 찾을 수 없습니다.' });
      return json(res, 200, { page });
    } catch (err) {
      return json(res, err.status || 400, { error: err.message || '약관을 불러오지 못했습니다.', hint: err.hint });
    }
  }

  if (url === '/api/health' && req.method === 'GET') {
    const kind = provider();
    const supabase = Boolean(supabaseConfig());
    return json(res, 200, { ok: Boolean(kind) || supabase, provider: kind, supabase, ai: Boolean(kind) });
  }

  if (url.startsWith('/api/') && !isPublicApi(url)) {
    const user = await currentSessionUser(req, res);
    if (!user) return json(res, 401, { error: '로그인이 필요합니다.' });
  }

  if (url === '/api/subjects' && req.method === 'GET') {
    try {
      const subjects = await fetchSubjectsFromSupabase();
      let counts = {};
      try {
        counts = await fetchQuestionCounts();
      } catch (_) {
        counts = {};
      }
      const withCounts = subjects.map((row) => {
        const id = resolveSubjectCode(row.name) || resolveSubjectCode(row.code) || '';
        const questionCount = id && counts[id] != null ? counts[id] : 0;
        return { ...row, questionCount };
      });
      return json(res, 200, { source: 'supabase', subjects: withCounts, counts });
    } catch (err) {
      if (err.code === 'NO_SUPABASE') {
        return json(res, 503, {
          error: 'NO_SUPABASE',
          hint: '.env에 SUPABASE_URL과 SUPABASE_ANON_KEY를 넣고 node server.js를 다시 실행해 주세요.',
        });
      }
      return json(res, 502, {
        error: err.message || 'Supabase 과목 조회에 실패했습니다.',
        hint: 'subjects 테이블과 RLS(익명 select 허용)를 확인해 주세요.',
      });
    }
  }

  if (url === '/api/question-image' && req.method === 'GET') {
    try {
      const qs = new URL(req.url || '/', 'http://127.0.0.1').searchParams;
      const bucket = String(qs.get('bucket') || 'question-images').trim() || 'question-images';
      const objectPath = String(qs.get('path') || '').replace(/^\/+/, '').trim();
      if (
        !objectPath ||
        objectPath.includes('..') ||
        objectPath.includes('\\') ||
        !/^[\p{L}\p{N}._\-/\s()]+$/u.test(objectPath)
      ) {
        return json(res, 400, { error: '이미지 경로가 올바르지 않습니다.' });
      }
      const cfg = supabaseConfig();
      if (!cfg) return json(res, 503, { error: 'NO_SUPABASE' });
      const supabase = makeSupabase(cfg);
      const found = await downloadStorageImage(supabase, bucket, objectPath);
      if (!found || !found.data) {
        return json(res, 404, { error: '이미지를 찾지 못했습니다.' });
      }
      const buf = Buffer.from(await found.data.arrayBuffer());
      res.statusCode = 200;
      res.setHeader('Content-Type', imageContentType(found.path, found.data.type));
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.end(buf);
    } catch (err) {
      return json(res, 502, { error: err.message || '이미지를 불러오지 못했습니다.' });
    }
  }

  if (url === '/api/questions' && req.method === 'GET') {
    try {
      const rawUrl = req.url || '/';
      const qs = rawUrl.includes('?') ? new URL(rawUrl, 'http://127.0.0.1').searchParams : new URLSearchParams();
      const subjects = qs.get('subjects') || qs.get('subject') || 'korean';
      const questions = await fetchQuestionsFromSupabase(subjects);
      return json(res, 200, { source: 'supabase', subjects, questions });
    } catch (err) {
      if (err.code === 'NO_SUPABASE') {
        return json(res, 503, {
          error: 'NO_SUPABASE',
          hint: '.env에 SUPABASE_URL과 SUPABASE_ANON_KEY를 넣고 node server.js를 다시 실행해 주세요.',
        });
      }
      return json(res, 502, {
        error: err.message || 'Supabase 문제 조회에 실패했습니다.',
        hint: 'questions 테이블과 RLS(익명 select 허용)를 확인해 주세요.',
      });
    }
  }

  /* ── 앱 데이터 API (회원은 Supabase, 그 외는 서버 파일) ── */
  if (url === '/api/session' && req.method === 'GET') {
    const user = await currentSessionUser(req, res);
    return json(res, 200, { user });
  }

  if (url === '/api/auth/signup' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req, 20_000)) || '{}');
      const name = sanitizePlainText(body.name, 20);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!name || !email.includes('@') || password.length < 6) {
        return json(res, 400, { error: '이름·이메일·비밀번호(6자 이상)를 확인해 주세요.' });
      }
      const { user, session } = await authSignUp({ name, email, password });
      const publicInfo = await startAuthSession(res, session, user);
      console.log('signup auth.users', publicInfo && publicInfo.id);
      return json(res, 200, { user: publicInfo });
    } catch (err) {
      return json(res, err.status || 400, {
        error: err.hint ? `${err.message} ${err.hint}` : (err.message || '회원가입에 실패했습니다.'),
        hint: err.hint,
      });
    }
  }

  if (url === '/api/auth/login' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req, 20_000)) || '{}');
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const { user, session } = await authLogin({ email, password });
      const publicInfo = await startAuthSession(res, session, user);
      return json(res, 200, { user: publicInfo });
    } catch (err) {
      return json(res, err.status || 400, {
        error: err.hint ? `${err.message} ${err.hint}` : (err.message || '로그인에 실패했습니다.'),
        hint: err.hint,
      });
    }
  }

  if (url === '/api/auth/logout' && req.method === 'POST') {
    const ctx = await sessionContext(req, res);
    if (ctx.accessToken) {
      await signOutAuth(ctx.accessToken);
    }
    if (ctx.legacyToken) {
      try {
        await authRpc('delete_app_session', { p_token: ctx.legacyToken });
      } catch {
        /* ignore */
      }
      const store = Store.load();
      if (store.sessions[ctx.legacyToken]) {
        delete store.sessions[ctx.legacyToken];
        Store.save(store);
      }
    }
    Store.clearAuthCookies(res);
    return json(res, 200, { ok: true });
  }

  if (url === '/api/auth/find-id' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req, 20_000)) || '{}');
      const name = String(body.name || '').trim();
      const email = String(body.email || '').trim().toLowerCase();
      const accounts = [];
      if (email.includes('@')) {
        const row = await authRpc('confirm_account_email', { p_email: email });
        if (row && row.found && row.email) accounts.push(row.email);
      }
      if (name) {
        const rows = await authRpc('find_account_emails', { p_name: name });
        const list = Array.isArray(rows) ? rows : [];
        list.forEach((item) => {
          const value = typeof item === 'string' ? item : item && item.email;
          if (value && !accounts.includes(value)) accounts.push(value);
        });
      }
      if (!name && !email.includes('@')) {
        return json(res, 400, { error: '이름 또는 이메일을 입력해 주세요.' });
      }
      return json(res, 200, { accounts });
    } catch (err) {
      return json(res, err.status || 400, {
        error: err.hint ? `${err.message} ${err.hint}` : (err.message || '아이디를 찾지 못했습니다.'),
        hint: err.hint || (err.status === 503 ? 'Supabase SQL 편집기에서 supabase-find-account.sql을 실행해 주세요.' : undefined),
      });
    }
  }

  if (url === '/api/auth/reset-password' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req, 20_000)) || '{}');
      const email = String(body.email || '').trim().toLowerCase();
      if (!email.includes('@')) {
        return json(res, 400, { error: '가입한 이메일을 입력해 주세요.' });
      }
      const supabase = makeAnonClient();
      if (!supabase) throw noSupabaseError();
      const redirectTo = `${requestOrigin(req)}/reset-password.html`;
      const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
      if (error) throw translateAuthError(error, '재설정 메일을 보내지 못했습니다.');
      return json(res, 200, {
        ok: true,
        message: '가입된 이메일이면 비밀번호 재설정 메일을 보냈습니다. 메일함을 확인해 주세요.',
      });
    } catch (err) {
      return json(res, err.status || 400, { error: err.message || '재설정 메일을 보내지 못했습니다.' });
    }
  }

  if (url === '/api/auth/recover-password' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req, 20_000)) || '{}');
      const password = String(body.password || '');
      if (password.length < 6) {
        return json(res, 400, { error: '비밀번호는 6자 이상이어야 합니다.' });
      }
      const supabase = makeAnonClient();
      if (!supabase) throw noSupabaseError();
      const code = String(body.code || '').trim();
      const accessToken = String(body.accessToken || body.access_token || '').trim();
      const refreshToken = String(body.refreshToken || body.refresh_token || '').trim();
      let sessionUser = null;
      let session = null;
      if (code) {
        const exchanged = await supabase.auth.exchangeCodeForSession(code);
        if (exchanged.error) throw translateAuthError(exchanged.error, '재설정 링크가 만료되었습니다.');
        session = exchanged.data.session;
        sessionUser = exchanged.data.user;
      } else if (accessToken && refreshToken) {
        const restored = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        });
        if (restored.error) throw translateAuthError(restored.error, '재설정 링크가 만료되었습니다.');
        session = restored.data.session;
        sessionUser = restored.data.user;
      } else {
        return json(res, 400, { error: '유효한 재설정 링크가 아닙니다.' });
      }
      const updated = await supabase.auth.updateUser({ password });
      if (updated.error) throw translateAuthError(updated.error, '비밀번호를 바꾸지 못했습니다.');
      const nextSession = updated.data.session || session;
      const nextUser = updated.data.user || sessionUser;
      if (nextSession && nextUser) {
        const publicInfo = await startAuthSession(res, nextSession, nextUser);
        return json(res, 200, { user: publicInfo });
      }
      return json(res, 200, { ok: true });
    } catch (err) {
      return json(res, err.status || 400, { error: err.message || '비밀번호를 바꾸지 못했습니다.' });
    }
  }

  if (url === '/api/auth/kakao' && req.method === 'GET') {
    const restKey = envValue('KAKAO_REST_API_KEY', 'KAKAO_CLIENT_ID');
    if (!restKey) return snsErrorRedirect(res, 'kakao', 'nokey');
    const redirectUri = envValue('KAKAO_REDIRECT_URI') || `${requestOrigin(req)}/api/auth/kakao/callback`;
    const state = makeOAuthState('kakao');
    const authorize = new URL('https://kauth.kakao.com/oauth/authorize');
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('client_id', restKey);
    authorize.searchParams.set('redirect_uri', redirectUri);
    authorize.searchParams.set('state', state);
    return redirect(res, authorize.toString());
  }

  if (url === '/api/auth/kakao/callback' && req.method === 'GET') {
    try {
      const qs = new URL(req.url || '/', 'http://127.0.0.1').searchParams;
      if (qs.get('error')) return snsErrorRedirect(res, 'kakao', 'denied');
      const code = String(qs.get('code') || '');
      const state = String(qs.get('state') || '');
      if (!code || !takeOAuthState(state, 'kakao')) return snsErrorRedirect(res, 'kakao', 'failed');
      const restKey = envValue('KAKAO_REST_API_KEY', 'KAKAO_CLIENT_ID');
      const redirectUri = envValue('KAKAO_REDIRECT_URI') || `${requestOrigin(req)}/api/auth/kakao/callback`;
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: restKey,
        redirect_uri: redirectUri,
        code,
      });
      const secret = envValue('KAKAO_CLIENT_SECRET');
      if (secret) body.set('client_secret', secret);
      const tokenRes = await fetch('https://kauth.kakao.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
        body,
      });
      const token = await tokenRes.json();
      if (!tokenRes.ok || !token.access_token) {
        const desc = `${token.error || ''} ${token.error_description || ''}`.toLowerCase();
        console.warn('kakao token', token.error || tokenRes.status);
        if (desc.includes('redirect')) return snsErrorRedirect(res, 'kakao', 'redirect');
        if (desc.includes('secret') || desc.includes('client')) return snsErrorRedirect(res, 'kakao', 'secret');
        return snsErrorRedirect(res, 'kakao', 'failed');
      }
      const meRes = await fetch('https://kapi.kakao.com/v2/user/me', {
        headers: { Authorization: `Bearer ${token.access_token}` },
      });
      const me = await meRes.json();
      if (!meRes.ok || !me.id) return snsErrorRedirect(res, 'kakao', 'failed');
      const account = me.kakao_account || {};
      const kakaoProfile = account.profile || {};
      const properties = me.properties || {};
      return await completeSocialLogin(res, {
        provider: 'kakao',
        providerId: me.id,
        name: kakaoProfile.nickname || properties.nickname,
        email: account.email,
      });
    } catch {
      return snsErrorRedirect(res, 'kakao', 'failed');
    }
  }

  if (url === '/api/auth/naver' && req.method === 'GET') {
    const clientId = envValue('NAVER_CLIENT_ID');
    const clientSecret = envValue('NAVER_CLIENT_SECRET');
    if (!clientId || !clientSecret) return snsErrorRedirect(res, 'naver', 'nokey');
    const redirectUri = envValue('NAVER_REDIRECT_URI') || `${requestOrigin(req)}/api/auth/naver/callback`;
    const state = makeOAuthState('naver');
    const authorize = new URL('https://nid.naver.com/oauth2.0/authorize');
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('client_id', clientId);
    authorize.searchParams.set('redirect_uri', redirectUri);
    authorize.searchParams.set('state', state);
    return redirect(res, authorize.toString());
  }

  if (url === '/api/auth/naver/callback' && req.method === 'GET') {
    try {
      const qs = new URL(req.url || '/', 'http://127.0.0.1').searchParams;
      if (qs.get('error')) return snsErrorRedirect(res, 'naver', 'denied');
      const code = String(qs.get('code') || '');
      const state = String(qs.get('state') || '');
      if (!code || !takeOAuthState(state, 'naver')) return snsErrorRedirect(res, 'naver', 'failed');
      const clientId = envValue('NAVER_CLIENT_ID');
      const clientSecret = envValue('NAVER_CLIENT_SECRET');
      const redirectUri = envValue('NAVER_REDIRECT_URI') || `${requestOrigin(req)}/api/auth/naver/callback`;
      const tokenUrl = new URL('https://nid.naver.com/oauth2.0/token');
      tokenUrl.searchParams.set('grant_type', 'authorization_code');
      tokenUrl.searchParams.set('client_id', clientId);
      tokenUrl.searchParams.set('client_secret', clientSecret);
      tokenUrl.searchParams.set('code', code);
      tokenUrl.searchParams.set('state', state);
      tokenUrl.searchParams.set('redirect_uri', redirectUri);
      const tokenRes = await fetch(tokenUrl);
      const token = await tokenRes.json();
      if (!tokenRes.ok || !token.access_token) return snsErrorRedirect(res, 'naver', 'failed');
      const meRes = await fetch('https://openapi.naver.com/v1/nid/me', {
        headers: { Authorization: `Bearer ${token.access_token}` },
      });
      const me = await meRes.json();
      const info = me.response || {};
      if (!meRes.ok || me.resultcode !== '00' || !info.id) return snsErrorRedirect(res, 'naver', 'failed');
      return await completeSocialLogin(res, {
        provider: 'naver',
        providerId: info.id,
        name: info.name || info.nickname,
        email: info.email,
      });
    } catch {
      return snsErrorRedirect(res, 'naver', 'failed');
    }
  }

  if (url === '/api/auth/google' && req.method === 'GET') {
    const clientId = envValue('GOOGLE_CLIENT_ID');
    const clientSecret = envValue('GOOGLE_CLIENT_SECRET');
    if (!clientId || !clientSecret) return snsErrorRedirect(res, 'google', 'nokey');
    const redirectUri = envValue('GOOGLE_REDIRECT_URI') || `${requestOrigin(req)}/api/auth/google/callback`;
    const state = makeOAuthState('google');
    const authorize = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('client_id', clientId);
    authorize.searchParams.set('redirect_uri', redirectUri);
    authorize.searchParams.set('scope', 'openid email profile');
    authorize.searchParams.set('state', state);
    authorize.searchParams.set('prompt', 'select_account');
    return redirect(res, authorize.toString());
  }

  if (url === '/api/auth/google/callback' && req.method === 'GET') {
    try {
      const qs = new URL(req.url || '/', 'http://127.0.0.1').searchParams;
      if (qs.get('error')) return snsErrorRedirect(res, 'google', 'denied');
      const code = String(qs.get('code') || '');
      const state = String(qs.get('state') || '');
      if (!code || !takeOAuthState(state, 'google')) return snsErrorRedirect(res, 'google', 'failed');
      const clientId = envValue('GOOGLE_CLIENT_ID');
      const clientSecret = envValue('GOOGLE_CLIENT_SECRET');
      const redirectUri = envValue('GOOGLE_REDIRECT_URI') || `${requestOrigin(req)}/api/auth/google/callback`;
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          code,
        }),
      });
      const token = await tokenRes.json();
      if (!tokenRes.ok || !token.access_token) return snsErrorRedirect(res, 'google', 'failed');
      const meRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${token.access_token}` },
      });
      const me = await meRes.json();
      if (!meRes.ok || !me.sub) return snsErrorRedirect(res, 'google', 'failed');
      return await completeSocialLogin(res, {
        provider: 'google',
        providerId: me.sub,
        name: me.name || me.given_name,
        email: me.email,
      });
    } catch {
      return snsErrorRedirect(res, 'google', 'failed');
    }
  }

  if (url === '/api/wrong-notes' && req.method === 'GET') {
    const ctx = await sessionContext(req, res);
    try {
      const payload = await loadWrongNotes(ctx);
      return json(res, 200, { ...payload, user: ctx.user || null });
    } catch (err) {
      return json(res, 200, {
        notes: [],
        source: 'local',
        user: ctx.user || null,
        error: err.message,
      });
    }
  }

  if (url === '/api/wrong-notes' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req, 40_000)) || '{}');
      const ctx = await sessionContext(req, res);
      const subject = String(body.subject || '');
      const index = Number(body.index);
      const questionId = await resolveQuestionId(subject, index, body.questionId || body.question_id);
      const fields = {
        questionId,
        subject,
        index,
        topic: body.topic || '',
        q: body.q || '',
        selectedAnswer: body.selectedAnswer || body.selected_answer,
        increment: true,
      };
      const client = wrongNotesClient(ctx.accessToken);
      if (client) {
        try {
          await saveWrongNoteRemote(client, fields);
          const notes = await listWrongNotesRemote(client);
          return json(res, 200, { notes, source: 'supabase' });
        } catch (err) {
          if (!isMissingWrongNotesFn(err) && ctx.accessToken && ctx.user && ctx.user.id) {
            await saveAuthWrongNote(ctx.accessToken, ctx.user.id, fields);
            const notes = await listAuthWrongNotes(ctx.accessToken, ctx.user.id);
            if (notes.length) return json(res, 200, { notes, source: 'supabase' });
          } else if (isMissingWrongNotesFn(err) && ctx.accessToken && ctx.user && ctx.user.id) {
            await saveAuthWrongNote(ctx.accessToken, ctx.user.id, fields);
            const notes = await listAuthWrongNotes(ctx.accessToken, ctx.user.id);
            return json(res, 200, { notes, source: 'supabase' });
          }
          if (!isMissingWrongNotesFn(err)) console.warn('wrong_notes post', err.message || err);
        }
      }
      const store = Store.load();
      const list = (store.wrongNotes || []).filter((item) => !(item.subject === subject && item.index === index));
      list.unshift({
        subject,
        index,
        topic: body.topic || '',
        q: body.q || '',
        date: new Date().toISOString(),
        questionId: questionId || null,
      });
      store.wrongNotes = list;
      Store.save(store);
      return json(res, 200, {
        notes: list,
        source: 'local',
        hint: 'Supabase SQL 편집기에서 supabase-wrong-notes.sql 파일을 실행해 주세요.',
      });
    } catch (err) {
      return json(res, 400, { error: err.message || '저장 실패' });
    }
  }

  if (url === '/api/wrong-notes' && req.method === 'DELETE') {
    try {
      const body = JSON.parse((await readBody(req, 20_000)) || '{}');
      const ctx = await sessionContext(req, res);
      const client = wrongNotesClient(ctx.accessToken);
      const questionId = body.all
        ? null
        : await resolveQuestionId(body.subject, Number(body.index), body.questionId || body.question_id);
      if (client) {
        try {
          await deleteWrongNoteRemote(client, {
            questionId,
            subject: body.subject,
            index: body.index,
            all: !!body.all,
          });
          const notes = await listWrongNotesRemote(client);
          return json(res, 200, { notes, source: 'supabase' });
        } catch (err) {
          if (ctx.accessToken && ctx.user && ctx.user.id) {
            if (body.all) await deleteAuthWrongNote(ctx.accessToken, ctx.user.id, null);
            else if (questionId) await deleteAuthWrongNote(ctx.accessToken, ctx.user.id, questionId);
            const notes = await listAuthWrongNotes(ctx.accessToken, ctx.user.id);
            if (!isMissingWrongNotesFn(err) || notes.length) {
              return json(res, 200, { notes, source: 'supabase' });
            }
          }
        }
      }
      const store = Store.load();
      if (body.all) store.wrongNotes = [];
      else {
        const subject = String(body.subject || '');
        const index = Number(body.index);
        store.wrongNotes = (store.wrongNotes || []).filter((item) => !(item.subject === subject && item.index === index));
      }
      Store.save(store);
      return json(res, 200, { notes: store.wrongNotes, source: 'local' });
    } catch (err) {
      return json(res, 400, { error: err.message || '삭제 실패' });
    }
  }

  if (url === '/api/study-log' && req.method === 'GET') {
    const ctx = await sessionContext(req, res);
    const answers = await loadUserAnswers(ctx);
    const log = mergeLogWithAnswers(readStudyLogFor(ctx), answers);
    const [stats, grades, weakness] = await Promise.all([
      computeStudyStats(log, answers),
      computeSubjectGrades(log, answers),
      computeWeakness(log, answers),
    ]);
    if (stats && stats.attempted) persistStudySnapshot(ctx, log, answers);
    return json(res, 200, {
      log,
      answers,
      stats,
      grades,
      weakness,
      source: ctx.user ? 'supabase' : 'local',
    });
  }

  if (url === '/api/study-log' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req, 20_000)) || '{}');
      const subject = String(body.subject || '');
      const index = String(body.index);
      const ctx = await sessionContext(req, res);
      const existingLog = readStudyLogFor(ctx);
      const prev = existingLog[subject] && existingLog[subject][index];
      let questionUsage = null;
      try {
        const consumed = await consumeQuestion(ctx, prev);
        questionUsage = consumed.usage;
      } catch (err) {
        if (err.status === 429) {
          return json(res, 429, {
            error: err.message,
            questions: err.usage,
            hint: err.hint,
          });
        }
        throw err;
      }
      const questionId = Number(body.questionId || body.question_id);
      writeStudyLogEntry(ctx, subject, index, {
        topic: body.topic || '',
        correct: !!body.correct,
        date: new Date().toISOString(),
        questionId: Number.isFinite(questionId) && questionId > 0 ? questionId : null,
      });

      if (Number.isFinite(questionId) && questionId > 0) {
        const selected = Number(body.selectedAnswer || body.selected_answer);
        const responseTime = Number(body.responseTime || body.response_time);
        const payload = {
          questionId,
          selectedAnswer: Number.isFinite(selected) ? selected : null,
          isCorrect: !!body.correct || !!body.is_correct,
          responseTime: Number.isFinite(responseTime) ? Math.max(0, Math.round(responseTime)) : null,
        };
        if (ctx.accessToken && ctx.user && ctx.user.id) {
          try {
            await saveAuthAnswer(ctx.accessToken, ctx.user.id, payload);
          } catch {
            /* 테이블/RLS 가 없으면 로컬 학습기록만 유지 */
          }
        } else if (ctx.legacyToken) {
          try {
            await authRpc('save_user_answer', {
              p_token: ctx.legacyToken,
              p_question_id: payload.questionId,
              p_selected_answer: payload.selectedAnswer,
              p_is_correct: payload.isCorrect,
              p_response_time: payload.responseTime,
            });
          } catch {
            /* 테이블/함수가 없으면 로컬 학습기록만 유지 */
          }
        }
      }

      const answers = await loadUserAnswers(ctx);
      const log = mergeLogWithAnswers(readStudyLogFor(ctx), answers);
      const [stats, grades, weakness] = await Promise.all([
        computeStudyStats(log, answers),
        computeSubjectGrades(log, answers),
        computeWeakness(log, answers),
      ]);
      persistStudySnapshot(ctx, log, answers);
      return json(res, 200, {
        log,
        answers,
        stats,
        grades,
        weakness,
        questions: questionUsage,
        source: ctx.user ? 'supabase' : 'local',
      });
    } catch (err) {
      return json(res, err.status || 400, { error: err.message || '저장 실패' });
    }
  }

  if (url === '/api/account' && req.method === 'GET') {
    const ctx = await sessionContext(req, res);
    const user = ctx.user;
    if (!user) {
      return json(res, 200, { user: null, account: null, plan: effectivePlanId('free'), payments: [], profile: null });
    }
    const store = Store.load();
    const fromUser = emptyAccountFromUser(user);
    const stored = store.accounts[Store.accountKey(user)] || {};
    const local = {
      ...fromUser,
      ...stored,
      joined: fromUser.joined || (stored.joined === '2024.01.15' ? '' : stored.joined),
      created_at: user.created_at || null,
    };
    local.name = user.name || local.name;
    local.email = user.email || local.email;
    let profile = null;
    let hint = '';
    if (ctx.accessToken) {
      try {
        profile = await fetchAuthProfile(ctx.accessToken, user, ctx.authUser);
      } catch (err) {
        hint = err.hint || err.message || '';
        profile = null;
      }
    } else if (ctx.legacyToken) {
      try {
        profile = await authRpc('get_profile', { p_token: ctx.legacyToken });
      } catch (err) {
        hint = err.hint || err.message || '';
        profile = null;
      }
    }
    const account = accountFromProfile(profile, local);
    return json(res, 200, {
      account,
      plan: effectivePlanId((profile && profile.plan) || store.plan),
      payments: store.payments || [],
      user,
      profile,
      hint: hint || undefined,
    });
  }

  if (url === '/api/account' && req.method === 'PUT') {
    try {
      const body = JSON.parse((await readBody(req, 40_000)) || '{}');
      const ctx = await sessionContext(req, res);
      const user = ctx.user;
      if (!user) return json(res, 401, { error: '로그인이 필요합니다.' });
      const store = Store.load();
      const key = Store.accountKey(user);
      const fromUser = emptyAccountFromUser(user);
      const prev = { ...fromUser, ...(store.accounts[key] || {}) };
      const next = {
        ...prev,
        ...(body.account || {}),
        notify: { ...prev.notify, ...((body.account && body.account.notify) || {}) },
        email: user.email,
        joined: fromUser.joined,
        created_at: user.created_at || null,
      };
      if (body.account && body.account.name) next.name = sanitizePlainText(body.account.name, 20);
      next.name = sanitizePlainText(next.name, 20);
      next.goal = sanitizePlainText(next.goal, 40);
      store.accounts[key] = next;
      Store.save(store);

      let profile = null;
      if (ctx.accessToken) {
        profile = await upsertAuthProfile(ctx.accessToken, user, {
          nickname: next.name || null,
          email: user.email || next.email || null,
          target_exam: next.goal || null,
          target_date: dateOrNull(next.targetDate),
          plan: 'premium',
          subjects: Array.isArray(next.subjects) ? next.subjects : [],
          daily_target: Number(next.dailyTarget) || 30,
          notify: next.notify,
        });
        try {
          await syncAuthMetadata(req, { name: next.name });
        } catch {
          /* 메타데이터 갱신은 선택 */
        }
      } else if (ctx.legacyToken) {
        profile = await authRpc('upsert_profile', {
          p_token: ctx.legacyToken,
          p_nickname: next.name || null,
          p_target_exam: next.goal || null,
          p_target_date: dateOrNull(next.targetDate),
          p_plan: 'premium',
        });
      } else {
        return json(res, 401, { error: '로그인이 필요합니다.' });
      }
      return json(res, 200, { account: accountFromProfile(profile, next), profile });
    } catch (err) {
      return json(res, err.status || 400, {
        error: err.hint ? `${err.message} ${err.hint}` : (err.message || '저장 실패'),
        hint: err.hint,
      });
    }
  }

  if (url === '/api/account/password' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req, 10_000)) || '{}');
      const ctx = await sessionContext(req, res);
      if (!ctx.user || !ctx.user.email) return json(res, 401, { error: '로그인이 필요합니다.' });
      const currentPassword = String(body.currentPassword || body.current || '');
      const newPassword = String(body.newPassword || body.next || '');
      if (newPassword.length < 6) {
        return json(res, 400, { error: '새 비밀번호는 6자 이상이어야 합니다.' });
      }
      const supabase = makeAnonClient();
      const signedIn = await supabase.auth.signInWithPassword({
        email: ctx.user.email,
        password: currentPassword,
      });
      if (signedIn.error) {
        return json(res, 401, { error: '현재 비밀번호가 올바르지 않습니다.' });
      }
      const updated = await supabase.auth.updateUser({ password: newPassword });
      if (updated.error) throw translateAuthError(updated.error, '비밀번호를 바꾸지 못했습니다.');
      if (updated.data.session) {
        await startAuthSession(res, updated.data.session, updated.data.user || ctx.authUser);
      }
      return json(res, 200, { ok: true });
    } catch (err) {
      return json(res, err.status || 400, { error: err.message || '비밀번호 변경에 실패했습니다.' });
    }
  }

  if (url === '/api/billing/plan' && req.method === 'PUT') {
    try {
      const body = JSON.parse((await readBody(req, 10_000)) || '{}');
      const store = Store.load();
      store.plan = 'premium';
      Store.save(store);
      const ctx = await sessionContext(req, res);
      if (ctx.accessToken && ctx.user) {
        try {
          const key = Store.accountKey(ctx.user);
          const acc = { ...Store.DEFAULT_ACCOUNT, ...(store.accounts[key] || {}) };
          await upsertAuthProfile(ctx.accessToken, ctx.user, {
            nickname: acc.name || ctx.user.name || null,
            target_exam: acc.goal || null,
            target_date: dateOrNull(acc.targetDate),
            plan: 'premium',
          });
        } catch {
          /* profiles 가 없으면 로컬 이용권만 유지 */
        }
      } else if (ctx.legacyToken) {
        try {
          const user = ctx.user;
          const key = Store.accountKey(user);
          const acc = { ...Store.DEFAULT_ACCOUNT, ...(store.accounts[key] || {}) };
          await authRpc('upsert_profile', {
            p_token: ctx.legacyToken,
            p_nickname: acc.name || (user && user.name) || null,
            p_target_exam: acc.goal || null,
            p_target_date: dateOrNull(acc.targetDate),
            p_plan: 'premium',
          });
        } catch {
          /* profiles 가 없으면 로컬 이용권만 유지 */
        }
      }
      return json(res, 200, { plan: 'premium' });
    } catch (err) {
      return json(res, 400, { error: err.message || '저장 실패' });
    }
  }

  if (url === '/api/billing/payments' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req, 20_000)) || '{}');
      const store = Store.load();
      const row = {
        id: `${Date.now()}`,
        plan: body.plan,
        name: body.name,
        amount: Number(body.amount) || 0,
        date: new Date().toISOString(),
        status: '결제 완료',
      };
      store.payments = [row, ...(store.payments || [])];
      Store.save(store);
      return json(res, 200, { payments: store.payments });
    } catch (err) {
      return json(res, 400, { error: err.message || '저장 실패' });
    }
  }

  if (url === '/api/account/leave' && req.method === 'POST') {
    const ctx = await sessionContext(req, res);
    const user = ctx.user;
    const store = Store.load();
    const key = Store.accountKey(user);
    delete store.accounts[key];
    if (ctx.accessToken && user && user.id) {
      try {
        const client = makeUserSupabase(ctx.accessToken);
        if (client) {
          try {
            await client.rpc('withdraw_account');
          } catch {
            await client
              .from('profiles')
              .update({
                status: '회원탈퇴',
                email: user.email || undefined,
                updated_at: new Date().toISOString(),
              })
              .eq('id', user.id);
          }
          await client.from('user_answers').delete().eq('user_id', user.id);
          await client.from('wrong_notes').delete().eq('user_id', user.id);
          await client.from('study_stats').delete().eq('user_id', user.id);
          await client.from('subject_grades').delete().eq('user_id', user.id);
          await client.from('weakness_reports').delete().eq('user_id', user.id);
          await client.from('weak_areas').delete().eq('user_id', user.id);
          await client.from('ai_usage').delete().eq('user_id', user.id);
          await client.from('question_usage').delete().eq('user_id', user.id);
        }
      } catch {
        /* ignore */
      }
      const admin = makeServiceSupabase();
      if (admin && user.id) {
        try {
          await admin
            .from('profiles')
            .update({
              status: '회원탈퇴',
              email: user.email || undefined,
              updated_at: new Date().toISOString(),
            })
            .eq('id', user.id);
        } catch {
          /* status 컬럼이 없으면 아래 SQL을 실행해야 합니다 */
        }
      }
      await signOutAuth(ctx.accessToken);
    } else if (user && user.email) {
      try {
        await authRpc('delete_app_user', { p_email: user.email });
      } catch {
        /* ignore */
      }
      store.users = store.users.filter((u) => String(u.email).toLowerCase() !== String(user.email).toLowerCase());
      Object.keys(store.sessions).forEach((sid) => {
        if (store.sessions[sid].email === user.email) delete store.sessions[sid];
      });
    }
    store.wrongNotes = [];
    store.studyLog = {};
    store.questionUsage = null;
    store.plan = 'free';
    store.payments = [];
    Store.save(store);
    Store.clearAuthCookies(res);
    return json(res, 200, { ok: true });
  }

  const noticeMatch = url.match(/^\/api\/notices(?:\/([^/]+))?$/);
  if (noticeMatch) {
    try {
      const ctx = await sessionContext(req, res);
      if (!ctx.user) return json(res, 401, { error: '로그인 후 이용하세요' });
      const noticeId = noticeMatch[1];
      const admin = await isNoticeAdmin(ctx);

      if (req.method === 'GET' && !noticeId) {
        const notices = await listNoticesFromSupabase(ctx);
        return json(res, 200, { notices, admin });
      }

      if (req.method === 'GET' && noticeId) {
        const supabase = noticesClient(ctx);
        const { data, error } = await supabase.from('notices').select('*').eq('id', noticeId).maybeSingle();
        if (error) throw noticeFail(error, '공지를 불러오지 못했습니다.');
        const notice = mapNoticeRow(data);
        if (!notice) return json(res, 404, { error: '공지를 찾을 수 없습니다.' });
        return json(res, 200, { notice, admin });
      }

      if (req.method === 'POST' && !noticeId) {
        if (!admin) return json(res, 403, { error: '관리자만 공지를 작성할 수 있습니다.' });
        const body = JSON.parse((await readBody(req, 80_000)) || '{}');
        const title = sanitizePlainText(body.title, 80);
        const content = sanitizePlainText(body.content, 20000);
        if (!title || !content) return json(res, 400, { error: '제목과 내용을 입력해 주세요.' });
        const supabase = noticesClient(ctx);
        const { data, error } = await supabase
          .from('notices')
          .insert({
            title,
            content,
            pinned: !!body.pinned,
            author_id: ctx.user.id,
            author_name: sanitizePlainText(ctx.user.name || '', 40),
          })
          .select('*')
          .maybeSingle();
        if (error) throw noticeFail(error, '공지를 저장하지 못했습니다.');
        return json(res, 200, {
          ok: true,
          notice: mapNoticeRow(data),
          notices: await listNoticesFromSupabase(ctx),
          admin: true,
        });
      }

      if ((req.method === 'PUT' || req.method === 'PATCH') && noticeId) {
        if (!admin) return json(res, 403, { error: '관리자만 공지를 수정할 수 있습니다.' });
        const body = JSON.parse((await readBody(req, 80_000)) || '{}');
        const patch = { updated_at: new Date().toISOString() };
        if (body.title != null) patch.title = sanitizePlainText(body.title, 80);
        if (body.content != null) patch.content = sanitizePlainText(body.content, 20000);
        if (body.pinned != null) patch.pinned = !!body.pinned;
        if (body.title != null && !patch.title) return json(res, 400, { error: '제목을 입력해 주세요.' });
        if (body.content != null && !patch.content) return json(res, 400, { error: '내용을 입력해 주세요.' });
        const supabase = noticesClient(ctx);
        const { data, error } = await supabase.from('notices').update(patch).eq('id', noticeId).select('*').maybeSingle();
        if (error) throw noticeFail(error, '공지를 수정하지 못했습니다.');
        const notice = mapNoticeRow(data);
        if (!notice) return json(res, 404, { error: '공지를 찾을 수 없습니다.' });
        return json(res, 200, {
          ok: true,
          notice,
          notices: await listNoticesFromSupabase(ctx),
          admin: true,
        });
      }

      if (req.method === 'DELETE' && noticeId) {
        if (!admin) return json(res, 403, { error: '관리자만 공지를 삭제할 수 있습니다.' });
        const supabase = noticesClient(ctx);
        const { error } = await supabase.from('notices').delete().eq('id', noticeId);
        if (error) throw noticeFail(error, '공지를 삭제하지 못했습니다.');
        return json(res, 200, { ok: true, notices: await listNoticesFromSupabase(ctx), admin: true });
      }

      return json(res, 405, { error: '허용되지 않은 요청입니다.' });
    } catch (err) {
      return json(res, err.status || 400, {
        error: err.message || '공지 요청에 실패했습니다.',
        hint: err.hint,
      });
    }
  }

  const reportMatch = url.match(/^\/api\/reports(?:\/([^/]+)(?:\/(open|reply))?)?$/);
  if (reportMatch) {
    try {
      const ctx = await sessionContext(req, res);
      if (!ctx.user) return json(res, 401, { error: '로그인 후 이용하세요' });
      const reportId = reportMatch[1];
      const action = reportMatch[2];
      const admin = await isNoticeAdmin(ctx);

      if (req.method === 'GET' && !reportId) {
        const rows = await callReportRpc(ctx, 'list_reports');
        const reports = (Array.isArray(rows) ? rows : []).map(mapReportSummary).filter(Boolean);
        return json(res, 200, { reports, admin });
      }

      if (req.method === 'POST' && !reportId) {
        const body = JSON.parse((await readBody(req, 80_000)) || '{}');
        const title = sanitizePlainText(body.title, 80);
        const content = sanitizePlainText(body.content, 20000);
        const password = String(body.password || '');
        if (!title || !content) return json(res, 400, { error: '제목과 내용을 입력해 주세요.' });
        if (password.length < 4) return json(res, 400, { error: '비밀번호는 4자 이상이어야 합니다.' });
        const row = await callReportRpc(ctx, 'create_report', {
          p_title: title,
          p_content: content,
          p_password: password,
        });
        const list = await callReportRpc(ctx, 'list_reports');
        return json(res, 200, {
          ok: true,
          report: mapReportDetail(row),
          reports: (Array.isArray(list) ? list : []).map(mapReportSummary).filter(Boolean),
          admin,
        });
      }

      if (req.method === 'POST' && reportId && action === 'open') {
        const body = JSON.parse((await readBody(req, 20_000)) || '{}');
        const row = await callReportRpc(ctx, 'open_report', {
          p_id: Number(reportId),
          p_password: body.password != null ? String(body.password) : '',
        });
        const report = mapReportDetail(row);
        if (!report) return json(res, 404, { error: '글을 찾을 수 없습니다.' });
        return json(res, 200, { report, admin });
      }

      if (req.method === 'POST' && reportId && action === 'reply') {
        if (!admin) return json(res, 403, { error: '관리자만 답변할 수 있습니다.' });
        const body = JSON.parse((await readBody(req, 80_000)) || '{}');
        const answer = sanitizePlainText(body.answer, 20000);
        if (!answer) return json(res, 400, { error: '답변을 입력해 주세요.' });
        const row = await callReportRpc(ctx, 'reply_report', { p_id: Number(reportId), p_answer: answer });
        const list = await callReportRpc(ctx, 'list_reports');
        return json(res, 200, {
          ok: true,
          report: mapReportDetail(row),
          reports: (Array.isArray(list) ? list : []).map(mapReportSummary).filter(Boolean),
          admin: true,
        });
      }

      if (req.method === 'DELETE' && reportId && !action) {
        if (!admin) return json(res, 403, { error: '관리자만 삭제할 수 있습니다.' });
        await callReportRpc(ctx, 'delete_report', { p_id: Number(reportId) });
        const list = await callReportRpc(ctx, 'list_reports');
        return json(res, 200, {
          ok: true,
          reports: (Array.isArray(list) ? list : []).map(mapReportSummary).filter(Boolean),
          admin: true,
        });
      }

      return json(res, 405, { error: '허용되지 않은 요청입니다.' });
    } catch (err) {
      return json(res, err.status || 400, {
        error: err.message || '오류 신고 요청에 실패했습니다.',
        hint: err.hint,
      });
    }
  }

  if (url === '/api/ai-usage' && req.method === 'GET') {
    const ctx = await sessionContext(req, res);
    ctx.guestKey = Store.guestId(req, res);
    const loaded = await loadAiUsage(ctx);
    return json(res, 200, loaded);
  }

  if (url === '/api/entitlements' && req.method === 'GET') {
    const ctx = await sessionContext(req, res);
    ctx.guestKey = Store.guestId(req, res);
    const payload = await entitlementsPayload(ctx);
    return json(res, 200, payload);
  }

  if (url === '/api/ask' && req.method === 'POST') {
    try {
      const raw = await readBody(req, 80_000);
      const payload = raw ? JSON.parse(raw) : {};
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      const clean = messages
        .filter((item) => item && (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string')
        .slice(-12)
        .map((item) => ({ role: item.role, content: item.content.slice(0, 2000) }));
      if (!clean.length || clean[clean.length - 1].role !== 'user') {
        return json(res, 400, { error: '질문을 입력해 주세요.' });
      }
      const requestKey = clientOpenAIKey(payload.apiKey);
      if (!provider() && !requestKey) {
        return json(res, 503, {
          error: 'NO_KEY',
          hint: 'Supabase Dashboard → Edge Functions → Secrets에 OPENAI_API_KEY를 등록하고 ask-ai 함수를 배포해 주세요.',
        });
      }
      const ctx = await sessionContext(req, res);
      ctx.guestKey = Store.guestId(req, res);
      const loaded = await loadAiUsage(ctx);
      if (loaded.usage && loaded.usage.limit != null && Number(loaded.usage.remaining) <= 0) {
        return json(res, 429, {
          error: `${loaded.usage.periodLabel} AI 선생님 이용 횟수 ${loaded.usage.limit}회를 모두 사용했습니다.`,
          usage: loaded.usage,
          source: loaded.source,
          hint: loaded.hint,
        });
      }
      const answer = await askModel(clean, requestKey);
      const bumped = await bumpAiUsage(ctx);
      return json(res, 200, { answer, usage: bumped.usage, source: bumped.source });
    } catch (err) {
      const status = err.code === 'NO_KEY' ? 503 : 502;
      return json(res, status, {
        error: err.message || 'AI 응답에 실패했습니다.',
        hint: err.hint,
      });
    }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end('method');
  }

  let file = url === '/' ? '/index.html' : url;
  const fp = path.normalize(path.join(ROOT, file));
  if (!fp.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  if (file.endsWith('.html') && !isPublicHtml(file)) {
    const user = await currentSessionUser(req, res);
    if (!user) return redirect(res, '/index.html?needLogin=1');
  }
  fs.readFile(fp, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('nf');
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(handleRequest);

if (!process.env.VERCEL) {
  server.listen(PORT, process.env.HOST || '127.0.0.1', () => {
    const kind = provider();
    const supabase = Boolean(supabaseConfig());

    console.log(`Server running at http://127.0.0.1:${PORT}`);
    console.log(kind === 'supabase' ? 'AI provider: supabase Edge Function ask-ai' : kind ? `AI provider: ${kind}` : 'AI key missing');
    console.log(
      supabase
        ? 'Supabase configuration loaded'
        : 'Supabase configuration missing'
    );
    questionIndexMaps().catch((err) => console.warn('question index warm', err && err.message));
  });
}

module.exports = handleRequest;