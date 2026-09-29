/* 화면에 표시되는 콘텐츠 정의. 서버 연동 시 이 구조를 그대로 API 응답으로 대체하면 됩니다. */

const ICONS = {
  home: '<path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1v-9.5Z"/>',
  book: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H4V5.5Z"/><path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H14a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h6V5.5Z"/>',
  note: '<path d="M6 3.5h9L19.5 8v12a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 20V5A1.5 1.5 0 0 1 6 3.5Z"/><path d="M14.5 3.5V8h5"/><path d="M8.5 13h7M8.5 17h4"/>',
  chart: '<path d="M4 20h16"/><rect x="6" y="12" width="3" height="6" rx="1"/><rect x="11" y="8" width="3" height="10" rx="1"/><rect x="16" y="4" width="3" height="14" rx="1"/>',
  robot: '<rect x="4.5" y="8" width="15" height="11" rx="3.5"/><path d="M12 4.5V8"/><circle cx="12" cy="3.5" r="1.4"/><circle cx="9.3" cy="13" r="1.3"/><circle cx="14.7" cy="13" r="1.3"/><path d="M2.5 12v3M21.5 12v3"/>',
  card: '<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M3 10h18M7 14.5h3"/>',
  gift: '<rect x="3.5" y="8.5" width="17" height="11.5" rx="2"/><path d="M3.5 13h17M12 8.5V20"/><path d="M12 8.5S10.5 4 8 4a2.2 2.2 0 0 0 0 4.5M12 8.5S13.5 4 16 4a2.2 2.2 0 0 1 0 4.5"/>',
  megaphone: '<path d="M4 10.5v3a1.5 1.5 0 0 0 1.5 1.5H8l7 4.5V6L8 10.5H5.5A1.5 1.5 0 0 0 4 12Z"/><path d="M18 9.5a4 4 0 0 1 0 5"/>',
  user: '<circle cx="12" cy="8.5" r="3.6"/><path d="M4.8 20a7.2 7.2 0 0 1 14.4 0"/>',
  medal: '<path d="M8 4.5h8v4a4 4 0 0 1-8 0v-4Z"/><path d="M8 6.2H5.4A2 2 0 0 0 7.4 8.4"/><path d="M16 6.2h2.6A2 2 0 0 1 16.6 8.4"/><path d="M12 12.5V16"/><path d="M8.5 19.5h7"/><path d="M9.5 16h5v3.5h-5z"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1.6"/>',
};

/* 사이드바 메뉴. href가 있는 항목만 실제 페이지로 이동합니다. */
const NAV_GROUPS = {
  navPrimary: [
    { id: 'home', label: '홈', icon: 'home', href: 'index.html' },
    { id: 'wrong', label: '오답노트', icon: 'note', href: 'review.html', feature: 'review' },
    { id: 'score', label: '나의 학습 현황', icon: 'chart', href: 'record.html', feature: 'record' },
    { id: 'grades', label: '나의 성적', icon: 'medal', href: 'grades.html', feature: 'grades' },
    { id: 'weakness', label: '나의 약점 분석', icon: 'target', href: 'weakness.html', feature: 'weakness' },
    { id: 'teacher', label: 'AI 선생님', icon: 'robot', href: 'teacher.html', feature: 'teacher' },
  ],
  navSecondary: [
    { id: 'billing', label: '이용권/결제', icon: 'card', href: 'billing.html' },
    { id: 'event', label: '오류 신고', icon: 'gift', href: 'report.html' },
    { id: 'notice', label: '공지사항', icon: 'megaphone', href: 'notice.html' },
  ],
  navAccount: [
    { id: 'account', label: '내 계정', icon: 'user', href: 'account.html' },
  ],
};

/* 과목 카드. quiz: true 인 항목은 클릭 시 문제 풀이 화면으로 이동합니다. */
const SUBJECTS = [
  { id: 'korean',  title: '9급 국어',   cta: '국어 시험', meta: '총 —제', emoji: '📖', quiz: true, tags: ['국어', '어문규정', '문학'] },
  { id: 'english', title: '9급 영어',   cta: '영어 시험', meta: '총 —제',   emoji: '🔤', quiz: true, tags: ['영어', '어휘', '독해'] },
  { id: 'history', title: '한국사능력검정시험', cta: '한국사 시험', meta: '총 —제',   emoji: '🏛️', quiz: true, tags: ['한국사', '근현대사'] },
  { id: 'adminlaw',title: '행정법',     cta: '행정법 시험', meta: '총 —제',   emoji: '⚖️', quiz: true, tags: ['행정법', '판례'] },
  { id: 'adminsci',title: '행정학',     cta: '행정학 시험', meta: '총 —제',   emoji: '🏢', quiz: true, tags: ['행정학', '조직론'] },
  { id: 'peducation', title: '교육학개론', cta: '교육학개론 시험', meta: '총 —제', emoji: '📚', quiz: true, tags: ['교육학'] },
  { id: 'localtax', title: '지방세법', cta: '지방세법 시험', meta: '총 —제', emoji: '💴', quiz: true, tags: ['지방세'] },
  { id: 'accounting', title: '회계학', cta: '회계학 시험', meta: '총 —제', emoji: '🧮', quiz: true, tags: ['회계학'] },
  { id: 'socialwelfare', title: '사회복지학개론', cta: '사회복지학개론 시험', meta: '총 —제', emoji: '🤝', quiz: true, tags: ['사회복지'] },
  { id: 'ask', title: 'AI에게 질문하기', cta: '바로 질문하기', meta: '개념 질문 가능', emoji: '✨',
    tags: ['AI', '질문', '개념'], variant: 'ai', badge: 'AI', href: 'teacher.html' },
];

/* 학습 도구 카드. href가 있는 항목만 실제 페이지로 이동합니다. */
const FEATURES = [
  { id: 'review',  title: '오답노트',        desc: '틀린 문제를 다시 복습하세요.',     accent: 'var(--green)', href: 'review.html', feature: 'review' },
  { id: 'record',  title: '나의 학습 현황',   desc: '학습 분석 리포트를 확인하세요.',   accent: 'var(--violet)', href: 'record.html', feature: 'record' },
  { id: 'grades',  title: '나의 성적',       desc: '과목별 정답률과 성적을 확인하세요.', accent: '#ca8a04', href: 'grades.html', feature: 'grades' },
  { id: 'weakness', title: '나의 약점 분석', desc: '틀린 유형을 모아 맞춤 훈련을 하세요.', accent: 'var(--primary)', href: 'weakness.html', feature: 'weakness' },
  { id: 'pass',    title: '이용권/결제',     desc: '프리미엄 혜택을 확인하세요.',      accent: 'var(--orange)', href: 'billing.html' },
];
