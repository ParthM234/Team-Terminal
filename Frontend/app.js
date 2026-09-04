// ============================================================
// Sankhya Setu — shared app.js, loaded on every page.
//
// This file used to be one inline <script> inside a single-page app,
// where every screen's HTML coexisted in the DOM and "navigation" just
// toggled which <section> had the .active class. Now each screen is its
// own real HTML file, so:
//   - goScreen(name) does a real page navigation (location.href), not a
//     class toggle.
//   - Every block that touches an element belonging to only ONE screen
//     (e.g. #spinMark, #role-list, #dropzone, #course-chips) is guarded
//     with an existence check, since this same app.js loads on pages
//     that don't have that element at all.
//   - Data that used to flow between screens via shared in-memory
//     variables (quiz source, review data, "which screen did I come
//     from") now flows via URL query params, since a real page load
//     resets plain JS variables. The signup wizard is the one exception
//     — it's kept as a single page (signup.html) with its original
//     internal step-toggling, because carrying password fields across
//     real page loads via the URL would be unsafe.
// ============================================================

// ---------- Supabase client (declared first, before anything else can throw) ----------
const SUPABASE_URL = 'https://hvkkwapsnmaalcqzmyfh.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_28mh4OF6mfGsqN2eyrtH7w_EgliBmqw';
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

// The Python/LangChain quiz-generation backend (main.py). Currently
// only running locally — update this once it's actually deployed.
const BACKEND_URL = 'http://localhost:8000';

// ---------- cross-page navigation ----------
// The signup wizard's 6 steps live in ONE file (signup.html), so any
// goScreen('signup-…') call — e.g. the "Create an account" link on the
// login page — should land on that single file, not a nonexistent
// "signup-1.html".
function goScreen(name) {
  const fileMap = { landing: 'index' };
  const target = name.startsWith('signup') ? 'signup' : (fileMap[name] || name);
  window.location.href = target + '.html';
}

function initials(name) {
  if (!name) return '--';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || '--';
}

function toggleDemoMenu() {
  document.getElementById('demoMenu').classList.toggle('show');
}
function jump(name) {
  goScreen(name);
}

// ---- dashboard sidebar + tabs (dashboard.html only) ----
function toggleSidebar() {
  const sb = document.getElementById('appSidebar');
  const bd = document.getElementById('sidebarBackdrop');
  if (sb) sb.classList.toggle('open');
  if (bd) bd.classList.toggle('show');
}
function switchDashTab(tab) {
  ['overview', 'progress'].forEach(t => {
    const btn = document.getElementById('tab-' + t);
    const panel = document.getElementById('panel-' + t);
    if (btn) btn.classList.toggle('active', t === tab);
    if (panel) panel.style.display = (t === tab) ? 'block' : 'none';
  });
}

// ============================================================
// Session-aware bits: fab visibility + profile hydration.
// Runs on every page via initPage() at the bottom of this file.
// ============================================================
const APP_SCREENS = ['dashboard', 'role', 'upload', 'spin', 'quiz', 'results', 'practice', 'progress'];
let currentUser = null;
let quizTaken = false;
let readinessScore = 0;

async function initPage() {
  const screen = document.body.dataset.screen;
  const fab = document.getElementById('profileFab');

  const sidebarPageMap = {
    dashboard: 'dashboard.html', role: 'role.html', upload: 'upload.html',
    progress: 'progress.html', practice: 'practice.html', profile: 'profile.html'
  };
  const activeHref = sidebarPageMap[screen];
  document.querySelectorAll('.sb-link').forEach(link => {
    if (link.tagName === 'A') link.classList.toggle('active', link.getAttribute('href') === activeHref);
  });

  const { data: { session } } = await supabaseClient.auth.getSession();

  if (session) {
    const { data: profile } = await supabaseClient
      .from('profiles')
      .select('*, ministries(name), job_roles(name)')
      .eq('id', session.user.id)
      .single();

    currentUser = {
      id: session.user.id,
      name: profile?.full_name || '',
      email: session.user.email || '',
      ministry: profile?.ministries?.name || '',
      designation: profile?.job_roles?.name || '',
      years: profile?.years_in_role,
      qualification: profile?.qualification || '',
      field: profile?.field_of_study || '',
      photo: null
    };

    if (fab) {
      const showFab = screen !== 'profile' && APP_SCREENS.includes(screen);
      fab.style.display = showFab ? 'flex' : 'none';
      const fabInitials = document.getElementById('fabInitials');
      if (fabInitials) fabInitials.textContent = initials(currentUser.name);
      fab.setAttribute('onclick', "location.href='profile.html?from=" + screen + "'");
    }

    const sbName = document.getElementById('sbUserName');
    const sbRole = document.getElementById('sbUserRole');
    if (sbName) sbName.textContent = currentUser.name || 'Your profile';
    if (sbRole) sbRole.textContent = [currentUser.designation, currentUser.ministry].filter(Boolean).join(' · ') || 'Statistical Service';
  } else if (fab) {
    fab.style.display = 'none';
  }

  // ---- per-screen setup that used to happen inside goScreen() ----
  if (screen === 'profile') renderProfile();

  if (screen === 'dashboard') {
    if (currentUser) {
      const firstName = currentUser.name.split(' ')[0] || 'there';
      const gName = document.getElementById('dashGreetName');
      const gRole = document.getElementById('dashGreetRole');
      if (gName) gName.textContent = 'Welcome back, ' + firstName;
      if (gRole) gRole.textContent = [currentUser.designation, currentUser.ministry].filter(Boolean).join(' · ') || "Here's your learning snapshot.";
    }

    if (quizTaken) {
      const emptyOver = document.getElementById('dash-overview-empty');
      const fullOver = document.getElementById('dash-overview-full');
      const emptyProg = document.getElementById('dash-progress-empty');
      const fullProg = document.getElementById('dash-progress-full');
      const statR = document.getElementById('statReady');
      const statW = document.getElementById('statWeak');

      if (emptyOver) emptyOver.style.display = 'none';
      if (fullOver) fullOver.style.display = 'block';
      if (emptyProg) emptyProg.style.display = 'none';
      if (fullProg) fullProg.style.display = 'block';
      if (statR) statR.textContent = readinessScore + '%';
      if (statW) statW.textContent = '2';
    }
  }

  if (screen === 'results') {
    renderResults();
  }

  if (screen === 'practice') {
    loadRecommendedCourses();
  }

  if (screen === 'spin') {
    const params = new URLSearchParams(location.search);
    const step = params.get('step') || 'building';
    const source = params.get('source') || 'role';

    if (step === 'scoring') {
      document.getElementById('spin-title').textContent = 'Scoring your answers…';
      document.getElementById('spin-sub').textContent = 'Matching results against what your role requires.';
      runSubmitQuiz();
    } else {
      if (source !== 'role') {
        // Only the standard role-based quiz is wired up right now —
        // upload/reassess navigate here but there's no backend support
        // for them yet, so fail clearly rather than pretend to work.
        showSpinError("This quiz type isn't available yet — only the standard quiz works right now.");
        return;
      }
      document.getElementById('spin-title').textContent = 'Building your quiz…';
      document.getElementById('spin-sub').textContent = '20 quick questions across your role\'s key skills, generated just for you.';
      runGenerateQuiz();
    }
  }

  if (screen === 'quiz') {
    loadQuizData();
  }

  if (screen === 'signup-success-redirect-name') {
    // placeholder, unused — see signup.html's own inline handling instead
  }
}

// ---- profile screen ----
function triggerPhotoUpload() {
  document.getElementById('photoInput').click();
}

function handlePhotoUpload(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    currentUser.photo = e.target.result;
    renderProfile();
  };
  reader.readAsDataURL(file);
}

function renderProfile() {
  if (!currentUser) return;
  document.getElementById('profileName').textContent = currentUser.name || 'Your name';
  document.getElementById('profileRole').textContent =
    [currentUser.designation, currentUser.ministry].filter(Boolean).join(' · ') || 'Add your job details';
  document.getElementById('pf-email').textContent = currentUser.email || '—';
  document.getElementById('pf-ministry').textContent = currentUser.ministry || '—';
  document.getElementById('pf-desig').textContent = currentUser.designation || '—';
  document.getElementById('pf-years').textContent = (currentUser.years || currentUser.years === 0) ? currentUser.years : '—';
  document.getElementById('pf-qual').textContent = currentUser.qualification || '—';
  document.getElementById('pf-field').textContent = currentUser.field || '—';

  const ini = initials(currentUser.name);
  document.getElementById('avatarLgInitials').textContent = ini;
  document.getElementById('fabInitials').textContent = ini;

  const lgImg = document.getElementById('avatarLgImg');
  const lgInitials = document.getElementById('avatarLgInitials');
  const fabImg = document.getElementById('fabImg');
  const fabInitials = document.getElementById('fabInitials');
  const photoBtnLabel = document.getElementById('photoBtnLabel');

  if (currentUser.photo) {
    lgImg.src = currentUser.photo; lgImg.style.display = 'block'; lgInitials.style.display = 'none';
    fabImg.src = currentUser.photo; fabImg.style.display = 'block'; fabInitials.style.display = 'none';
    photoBtnLabel.textContent = 'Change profile photo';
  } else {
    lgImg.style.display = 'none'; lgInitials.style.display = 'block';
    fabImg.style.display = 'none'; fabInitials.style.display = 'block';
    photoBtnLabel.textContent = 'Upload profile photo';
  }

  document.getElementById('profile-progress-empty').style.display = quizTaken ? 'none' : 'block';
  document.getElementById('profile-progress-full').style.display = quizTaken ? 'block' : 'none';
  if (quizTaken) document.getElementById('pf-meter-num').textContent = readinessScore + '%';
}

async function signOut() {
  await supabaseClient.auth.signOut();
  currentUser = null;
  quizTaken = false;
  goScreen('landing');
}

// ---- landing page: animate the hero result meter once, on load ----
(function () {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const num = document.getElementById('heroMeterNum');
  if (!num) return;
  const segs = document.querySelectorAll('#heroMock .meter-seg i');
  if (reduce) {
    segs.forEach(s => s.style.width = (s.dataset.w || 0) + '%');
    num.textContent = '52%';
    return;
  }
  setTimeout(() => {
    segs.forEach(s => s.style.width = (s.dataset.w || 0) + '%');
    let n = 0; const target = 52;
    const t = setInterval(() => {
      n += 2;
      if (n >= target) { n = target; clearInterval(t); }
      num.textContent = n + '%';
    }, 22);
  }, 300);
})();

// ---- landing page: animate the "your gaps" ledger values when scrolled into view ----
(function () {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const box = document.getElementById('gapsMock');
  if (!box) return;
  const vals = box.querySelectorAll('.lval');
  if (reduce) {
    vals.forEach(v => v.textContent = v.dataset.target + '%');
    return;
  }
  let done = false;
  const io = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting && !done) {
        done = true;
        vals.forEach((v, i) => {
          setTimeout(() => {
            const target = Number(v.dataset.target);
            let n = 0;
            const t = setInterval(() => {
              n += 2;
              if (n >= target) { n = target; clearInterval(t); }
              v.textContent = n + '%';
            }, 18);
          }, i * 90);
        });
        io.disconnect();
      }
    });
  }, { threshold: .4 });
  io.observe(box);
})();

// ---- spinner tally animation (spin.html only) ----
const spinMark = document.getElementById('spinMark');
if (spinMark) {
  for (let i = 0; i < 8; i++) {
    const b = document.createElement('div');
    b.className = 'bar';
    b.style.transform = `rotate(${i * 45}deg)`;
    b.style.animation = `tickfade 1s ${i * 0.1}s infinite`;
    spinMark.appendChild(b);
  }
}

// ---- login ----
function showPhone() {
  document.getElementById('mode-choice').style.display = 'none';
  document.getElementById('mode-phone').style.display = 'block';
  document.getElementById('mode-email').style.display = 'none';
  document.getElementById('back-to-choice').style.display = 'block';
}
function showEmailLogin() {
  document.getElementById('mode-choice').style.display = 'none';
  document.getElementById('mode-phone').style.display = 'none';
  document.getElementById('mode-email').style.display = 'block';
  document.getElementById('back-to-choice').style.display = 'block';
}
function showChoice() {
  document.getElementById('mode-choice').style.display = 'flex';
  document.getElementById('mode-phone').style.display = 'none';
  document.getElementById('mode-email').style.display = 'none';
  document.getElementById('back-to-choice').style.display = 'none';
}
async function loginWithEmail() {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-pass').value;
  const errEl = document.getElementById('login-error');
  const btn = document.getElementById('login-submit-btn');
  errEl.classList.remove('show');

  if (!email || !password) {
    errEl.textContent = 'Enter both your email and password.';
    errEl.classList.add('show');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Signing in…';

  const { error } = await supabaseClient.auth.signInWithPassword({ email, password });

  btn.disabled = false;
  btn.textContent = 'Sign in';

  if (error) {
    console.error('Login failed:', error);
    errEl.textContent = error.message || 'Could not sign in. Check your email and password.';
    errEl.classList.add('show');
    return;
  }

  goScreen('dashboard');
}
function startGoogleLogin(btn) {
  // Demo stub — not wired to a real provider. Real accounts should use
  // "Continue with Email" above.
  const original = btn.innerHTML;
  btn.innerHTML = 'Signing in…';
  setTimeout(() => {
    alert('Google sign-in is a demo placeholder in this build. Use "Continue with Email" to sign in with a real account.');
    btn.innerHTML = original;
  }, 600);
}
function sendOtp() {
  const phone = document.getElementById('phone').value;
  if (phone.length !== 10) { alert('Enter a valid 10-digit mobile number.'); return; }
  document.getElementById('otp-block').style.display = 'block';
  document.getElementById('otp1').focus();
}
function otpNext(el) {
  if (el.value.length === 1 && el.nextElementSibling && el.nextElementSibling.classList.contains('otp')) {
    el.nextElementSibling.focus();
  }
}
function verifyOtp() {
  const vals = ['otp1', 'otp2', 'otp3', 'otp4'].map(id => document.getElementById(id).value);
  if (vals.some(v => v === '')) { alert('Enter all 4 digits.'); return; }
  alert('Mobile OTP sign-in is a demo placeholder in this build. Use "Continue with Email" to sign in with a real account.');
}

// ---- upload (upload.html only) ----
const dz = document.getElementById('dropzone');
if (dz) {
  ['dragenter', 'dragover'].forEach(evt => dz.addEventListener(evt, e => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(evt => dz.addEventListener(evt, e => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', () => showFilePicked('Uploaded_Training_Material.pdf'));
}
function filePicked(input) {
  const name = input.files.length ? input.files[0].name : 'Survey_Methodology_Notes.pdf';
  showFilePicked(name);
}
function showFilePicked(name) {
  document.getElementById('fileName').textContent = name;
  document.getElementById('filePicked').classList.add('show');
  document.getElementById('upload-continue').disabled = false;
}

// ---- quiz flow entry point (called from role.html, upload.html, progress.html) ----
// Used to configure the spin/quiz screens directly via DOM writes; now it
// just navigates; spin.html now makes the actual backend calls and
// hands data to the next page via sessionStorage (20 questions is too
// much to pass through a URL, which is how every other page-to-page
// handoff in this site works).
function startQuiz(source) {
  if (source !== 'role') {
    alert("This quiz type isn't available yet — only the standard quiz works right now.");
    return;
  }
  window.location.href = 'spin.html?source=' + encodeURIComponent(source);
}

function showSpinError(message) {
  document.getElementById('spin-loading').style.display = 'none';
  const errBox = document.getElementById('spin-error');
  document.getElementById('spin-error-message').textContent = message;
  errBox.style.display = 'block';
}

async function runGenerateQuiz() {
  if (!currentUser || !currentUser.id) {
    showSpinError('You need to be signed in to take a quiz.');
    return;
  }
  try {
    const res = await fetch(BACKEND_URL + '/generate-quiz', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile_id: currentUser.id })
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.detail || 'The quiz could not be generated.');
    }
    sessionStorage.setItem('quizData', JSON.stringify(data));
    window.location.href = 'quiz.html';
  } catch (err) {
    console.error('generate-quiz failed:', err);
    showSpinError(err.message || 'Could not reach the quiz backend. Is it running?');
  }
}

async function runSubmitQuiz() {
  const raw = sessionStorage.getItem('quizSubmission');
  if (!raw) {
    showSpinError('Your quiz answers were lost. Please retake the quiz.');
    return;
  }
  const submission = JSON.parse(raw);
  try {
    const res = await fetch(BACKEND_URL + '/submit-quiz', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(submission)
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.detail || 'The quiz could not be scored.');
    }
    sessionStorage.setItem('quizResults', JSON.stringify(data));
    sessionStorage.removeItem('quizData');
    sessionStorage.removeItem('quizSubmission');
    window.location.href = 'results.html';
  } catch (err) {
    console.error('submit-quiz failed:', err);
    showSpinError(err.message || 'Could not reach the quiz backend. Is it running?');
  }
}

// ---- quiz-taking (quiz.html only) ----
let quizData = null;
let quizQuestionIndex = 0;
let quizCollectedAnswers = [];
let quizSelectedOption = null;

function loadQuizData() {
  const raw = sessionStorage.getItem('quizData');
  if (!raw) {
    // Nobody generated a quiz for this session — send them back rather
    // than show a broken empty page.
    window.location.href = 'role.html';
    return;
  }
  quizData = JSON.parse(raw);
  quizQuestionIndex = 0;
  quizCollectedAnswers = [];
  renderQuestion();
}

function renderQuestion() {
  const total = quizData.questions.length;
  const q = quizData.questions[quizQuestionIndex];
  quizSelectedOption = null;

  document.getElementById('quiz-tab').textContent = `Q${quizQuestionIndex + 1} / ${total}`;
  document.getElementById('quiz-skill').textContent = q.skill;
  document.getElementById('quiz-question').textContent = q.question;

  const optionsEl = document.getElementById('quiz-options');
  optionsEl.innerHTML = '';
  q.options.forEach(opt => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'opt';
    btn.innerHTML = '<span class="sq"></span>' + opt;
    btn.onclick = () => selectOption(btn, opt);
    optionsEl.appendChild(btn);
  });

  const fb = document.getElementById('quiz-feedback');
  fb.classList.remove('show', 'good', 'bad');
  fb.textContent = '';

  const nextBtn = document.getElementById('quiz-next');
  nextBtn.disabled = true;
  nextBtn.textContent = (quizQuestionIndex === total - 1) ? 'See my results' : 'Next question';
}

function selectOption(btn, optionText) {
  // Deliberately no right/wrong feedback here — the correct answer
  // stays server-side until the whole quiz is submitted and scored,
  // so someone can't just read the feedback to game the assessment.
  document.querySelectorAll('#quiz-options .opt').forEach(o => o.classList.remove('selected'));
  btn.classList.add('selected');
  quizSelectedOption = optionText;
  document.getElementById('quiz-next').disabled = false;
}

function nextQuestion() {
  const q = quizData.questions[quizQuestionIndex];
  quizCollectedAnswers.push({ question_id: q.id, selected_option: quizSelectedOption });

  if (quizQuestionIndex < quizData.questions.length - 1) {
    quizQuestionIndex++;
    renderQuestion();
  } else {
    sessionStorage.setItem('quizSubmission', JSON.stringify({
      attempt_id: quizData.attempt_id,
      answers: quizCollectedAnswers
    }));
    window.location.href = 'spin.html?step=scoring';
  }
}

// ---- results (results.html only) ----
function skillTier(scorePercent) {
  if (scorePercent >= 80) return { tag: 'STRONG', color: 'var(--teal)' };
  if (scorePercent >= 65) return { tag: 'SOLID', color: 'var(--teal)' };
  if (scorePercent >= 50) return { tag: 'GETTING THERE', color: 'var(--amber)' };
  return { tag: 'NEEDS WORK', color: 'var(--brick)' };
}

function renderResults() {
  const raw = sessionStorage.getItem('quizResults');
  if (!raw) {
    window.location.href = 'dashboard.html';
    return;
  }
  const results = JSON.parse(raw);
  quizTaken = true;
  readinessScore = Math.round(results.overall_score_percent);

  const numEl = document.getElementById('meter-num');
  const filled = Math.round(results.overall_score_percent / 20);
  for (let i = 1; i <= 5; i++) {
    const seg = document.getElementById('seg' + i);
    seg.style.width = (i <= filled) ? '100%' : '0%';
  }
  let n = 0;
  const target = Math.round(results.overall_score_percent);
  const t = setInterval(() => {
    n += 2;
    if (n >= target) { n = target; clearInterval(t); }
    numEl.textContent = n + '%';
  }, 22);

  const sorted = [...results.skills].sort((a, b) => b.score_percent - a.score_percent);
  const strongest = sorted[0];
  const weakest = sorted.slice(-2).map(s => s.skill);
  const msgEl = document.getElementById('results-message');
  if (strongest) {
    msgEl.querySelector('b').textContent = `You're strongest in ${strongest.skill}.`;
    msgEl.querySelector('span').textContent = weakest.length
      ? `Focus on ${weakest.join(' and ')} next — that's where the gap is biggest.`
      : '';
  }

  const listEl = document.getElementById('results-list');
  listEl.innerHTML = '';
  sorted.forEach((s, i) => {
    const tier = skillTier(s.score_percent);
    const row = document.createElement('div');
    row.className = 'lrow rise';
    row.style.animationDelay = (i * 0.05) + 's';
    row.innerHTML = `<span class="sq2" style="background:${tier.color};"></span><span class="lname">${s.skill}</span><span class="dots"></span><span class="lval">${Math.round(s.score_percent)}%</span><span class="ltag">${tier.tag}</span>`;
    listEl.appendChild(row);
  });
}

// ---- practice: real course recommendations from skill_gaps (practice.html only) ----
let recommendedCourses = [];
let recommendedIndex = 0;

async function loadRecommendedCourses() {
  const loadingEl = document.getElementById('practice-loading');
  const emptyEl = document.getElementById('practice-empty');
  const contentEl = document.getElementById('practice-content');

  if (!currentUser || !currentUser.id) {
    loadingEl.textContent = 'Sign in to see your recommendations.';
    return;
  }

  // Worst gap first — this is the single source of truth for "where is
  // this person behind," computed by the skill_gaps view from their
  // latest quiz scores vs. their role's required levels.
  const { data: gaps, error: gapsError } = await supabaseClient
    .from('skill_gaps')
    .select('skill_id, skill_name, gap')
    .eq('profile_id', currentUser.id)
    .gt('gap', 0)
    .order('gap', { ascending: false });

  if (gapsError) {
    console.error('Failed to load skill gaps:', gapsError);
    loadingEl.textContent = "Couldn't load your recommendations right now.";
    return;
  }

  if (!gaps || gaps.length === 0) {
    loadingEl.style.display = 'none';
    emptyEl.style.display = 'block';
    return;
  }

  const skillIds = gaps.map(g => g.skill_id);
  const { data: courseLinks, error: coursesError } = await supabaseClient
    .from('course_skills')
    .select('skill_id, courses(id, title, description, igot_link)')
    .in('skill_id', skillIds);

  if (coursesError || !courseLinks || courseLinks.length === 0) {
    console.error('Failed to load matching courses:', coursesError);
    loadingEl.style.display = 'none';
    emptyEl.style.display = 'block';
    emptyEl.querySelector('h3').textContent = 'No matching courses yet';
    emptyEl.querySelector('p').textContent = 'You have open gaps, but no course in the catalog covers them yet.';
    return;
  }

  // Order courses by how bad the gap is for the skill they address —
  // a course fixing your worst gap should show up first.
  const gapBySkillId = Object.fromEntries(gaps.map(g => [g.skill_id, g]));
  recommendedCourses = courseLinks
    .filter(link => link.courses)
    .map(link => ({
      title: link.courses.title,
      description: link.courses.description || '',
      igot_link: link.courses.igot_link || '',
      skill_name: gapBySkillId[link.skill_id]?.skill_name || '',
      gap: gapBySkillId[link.skill_id]?.gap || 0
    }))
    .sort((a, b) => b.gap - a.gap);

  recommendedIndex = 0;
  loadingEl.style.display = 'none';
  contentEl.style.display = 'block';
  renderRecommendedCourse();
}

function renderRecommendedCourse() {
  const c = recommendedCourses[recommendedIndex];
  document.getElementById('course-num').textContent = `${recommendedIndex + 1} / RECOMMENDED (${recommendedCourses.length})`;
  document.getElementById('course-title').textContent = c.title;
  document.getElementById('course-meta').textContent = c.description || 'On iGOT Karmayogi';
  document.getElementById('course-tag').textContent = 'FIXES: ' + c.skill_name.toUpperCase();
}

function nextCourse() {
  if (recommendedCourses.length === 0) return;
  recommendedIndex = (recommendedIndex + 1) % recommendedCourses.length;
  const card = document.getElementById('course-card');
  card.style.opacity = '0';
  card.style.transform = 'translateY(5px)';
  card.style.transition = 'opacity .15s ease, transform .15s ease';
  setTimeout(() => {
    renderRecommendedCourse();
    card.style.opacity = '1';
    card.style.transform = 'translateY(0)';
  }, 160);
}

function openCurrentCourse() {
  const c = recommendedCourses[recommendedIndex];
  if (c && c.igot_link) {
    window.open(c.igot_link, '_blank');
  } else {
    goScreen('progress');
  }
}

// ============================================================
// Signup wizard (signup.html only — kept as one file, see header note)
// ============================================================
let signupCurrent = 0;
const signupSteps = ['signup-1', 'signup-2', 'signup-3', 'signup-4', 'signup-review', 'signup-success'];

function showSignupStep(name) {
  document.querySelectorAll('#app .screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById('screen-' + name);
  if (el) el.classList.add('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ---- ministry / job role dropdowns (signup.html step 2 only) ----
async function loadMinistryAndRoleDropdowns() {
  const ministrySelect = document.getElementById('f-ministry');
  const roleSelect = document.getElementById('f-desig');
  if (!ministrySelect || !roleSelect) return;

  const [{ data: ministries, error: ministryError }, { data: jobRoles, error: roleError }] = await Promise.all([
    supabaseClient.from('ministries').select('id, name').order('name'),
    supabaseClient.from('job_roles').select('id, name').order('name')
  ]);

  if (ministryError || !ministries) {
    console.error('Could not load ministries:', ministryError);
    ministrySelect.innerHTML = '<option value="">Could not load ministries</option>';
  } else {
    ministrySelect.innerHTML = '<option value="">Select one</option>' +
      ministries.map(m => `<option value="${m.id}">${m.name}</option>`).join('');
  }

  if (roleError || !jobRoles) {
    console.error('Could not load job roles:', roleError);
    roleSelect.innerHTML = '<option value="">Could not load job roles</option>';
  } else {
    roleSelect.innerHTML = '<option value="">Select one</option>' +
      jobRoles.map(r => `<option value="${r.id}">${r.name}</option>`).join('');
  }
}
loadMinistryAndRoleDropdowns();

function showFieldError(inputId, errId, show) {
  document.getElementById(inputId).classList.toggle('err', show);
  document.getElementById(errId).classList.toggle('show', show);
}

function togglePw(id, btn) {
  const el = document.getElementById(id);
  const isPw = el.type === 'password';
  el.type = isPw ? 'text' : 'password';
  btn.textContent = isPw ? 'HIDE' : 'SHOW';
}

function checkPwStrength() {
  const v = document.getElementById('f-pass').value;
  let score = 0;
  if (v.length >= 8) score++;
  if (/[A-Z]/.test(v) && /[0-9]/.test(v)) score++;
  if (/[^A-Za-z0-9]/.test(v) && v.length >= 10) score++;
  ['pw1', 'pw2', 'pw3'].forEach((id, i) => {
    document.getElementById(id).className = i < score ? ('on' + score) : '';
  });
}

function validateStep1() {
  let ok = true;
  const name = document.getElementById('f-name').value.trim();
  const email = document.getElementById('f-email').value.trim();
  const pass = document.getElementById('f-pass').value;
  const pass2 = document.getElementById('f-pass2').value;
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  showFieldError('f-name', 'err-name', name === ''); if (name === '') ok = false;
  showFieldError('f-email', 'err-email', !emailOk); if (!emailOk) ok = false;
  showFieldError('f-pass', 'err-pass', pass.length < 8); if (pass.length < 8) ok = false;
  showFieldError('f-pass2', 'err-pass2', pass2 !== pass || pass2 === ''); if (pass2 !== pass || pass2 === '') ok = false;
  return ok;
}

function validateStep2() {
  let ok = true;
  const ministry = document.getElementById('f-ministry').value.trim();
  const desig = document.getElementById('f-desig').value.trim();
  const years = document.getElementById('f-years').value;
  const yearsOk = years !== '' && Number(years) >= 0 && Number(years) <= 50;

  showFieldError('f-ministry', 'err-ministry', ministry === ''); if (ministry === '') ok = false;
  showFieldError('f-desig', 'err-desig', desig === ''); if (desig === '') ok = false;
  showFieldError('f-years', 'err-years', !yearsOk); if (!yearsOk) ok = false;
  return ok;
}

function validateStep3() {
  let ok = true;
  const qual = document.getElementById('f-qual').value;
  const field = document.getElementById('f-field').value.trim();
  showFieldError('f-qual', 'err-qual', qual === ''); if (qual === '') ok = false;
  showFieldError('f-field', 'err-field', field === ''); if (field === '') ok = false;
  return ok;
}

function shakeCurrent() {
  const el = document.getElementById('screen-' + signupSteps[signupCurrent]);
  el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake');
}

function goStep(dir) {
  if (dir === 1 && !validateStep1()) { shakeCurrent(); return; }
  if (dir === 2 && !validateStep2()) { shakeCurrent(); return; }
  if (dir === 3 && !validateStep3()) { shakeCurrent(); return; }
  signupCurrent += (dir > 0 ? 1 : dir);
  showSignupStep(signupSteps[signupCurrent]);
}

// ---- iGOT course chips (signup.html only) ----
let selectedCourses = [];
let noneDone = false;
const chipGrid = document.getElementById('course-chips');

async function loadCourseChips() {
  if (!chipGrid) return;
  const { data: courses, error } = await supabaseClient.from('courses').select('id, title').order('title');
  if (error || !courses) {
    console.error('Could not load courses:', error);
    chipGrid.innerHTML = '<p class="note">Could not load the course list. You can skip this step.</p>';
    return;
  }
  chipGrid.innerHTML = '';
  courses.forEach(course => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'chip';
    el.innerHTML = `<span class="dot"></span>${course.title}`;
    el.onclick = () => {
      if (noneDone) toggleNone();
      el.classList.toggle('selected');
      if (el.classList.contains('selected')) selectedCourses.push(course.title);
      else selectedCourses = selectedCourses.filter(c => c !== course.title);
    };
    chipGrid.appendChild(el);
  });
}
loadCourseChips();


function toggleNone() {
  noneDone = !noneDone;
  const btn = document.getElementById('none-toggle');
  if (noneDone) {
    selectedCourses = [];
    document.querySelectorAll('.chip').forEach(c => c.classList.remove('selected'));
    chipGrid.style.opacity = '.4';
    chipGrid.style.pointerEvents = 'none';
    btn.style.color = 'var(--teal)';
    btn.textContent = "✓ Noted — you're just starting out";
  } else {
    chipGrid.style.opacity = '1';
    chipGrid.style.pointerEvents = 'auto';
    btn.style.color = '';
    btn.textContent = "I haven't completed any yet";
  }
}

// ---- review ----
function showReview() {
  const box = document.getElementById('review-box');
  const courseText = noneDone ? "None yet" : (selectedCourses.length ? selectedCourses.join(', ') : "None selected");
  const rows = [
    ['Name', document.getElementById('f-name').value.trim()],
    ['Email', document.getElementById('f-email').value.trim()],
    ['Ministry / Dept.', document.getElementById('f-ministry').selectedOptions[0]?.text || ''],
    ['Designation', document.getElementById('f-desig').selectedOptions[0]?.text || ''],
    ['Years in role', document.getElementById('f-years').value],
    ['Qualification', document.getElementById('f-qual').value],
    ['Field of study', document.getElementById('f-field').value.trim()],
    ['iGOT courses done', courseText]
  ];
  box.innerHTML = '<div class="ledger-tab">REVIEW</div>' +
    rows.map(([k, v]) => `<div class="rev-row"><span class="rk">${k}</span><span class="rv">${v || '—'}</span></div>`).join('');
  showSignupStep('signup-review');
}

// ---- Supabase: real auth signup + profile row ----
async function createAccount() {
  const btn = document.getElementById('create-account-btn');
  const name = document.getElementById('f-name').value.trim();
  const email = document.getElementById('f-email').value.trim();
  const password = document.getElementById('f-pass').value;
  const ministryId = document.getElementById('f-ministry').value || null;
  const jobRoleId = document.getElementById('f-desig').value || null;
  const years = Number(document.getElementById('f-years').value);
  const qual = document.getElementById('f-qual').value;
  const field = document.getElementById('f-field').value.trim();
  const courses = noneDone ? [] : selectedCourses;

  if (btn) { btn.disabled = true; btn.textContent = 'Creating account…'; }

  // Step 1: create the actual auth user (this is what lets them log back in later)
  const { data: signUpData, error: signUpError } = await supabaseClient.auth.signUp({
    email: email,
    password: password
  });

  if (signUpError) {
    console.error('Auth signup failed:', signUpError);
    if (btn) { btn.disabled = false; btn.textContent = 'Create account'; }
    alert(signUpError.message || 'Something went wrong creating your account. Please try again.');
    return;
  }

  const userId = signUpData.user ? signUpData.user.id : null;
  if (!userId) {
    if (btn) { btn.disabled = false; btn.textContent = 'Create account'; }
    alert('Account created, but something went wrong linking your profile. Please contact support.');
    return;
  }

  // Step 2: insert the profile row, keyed to the new auth user's id
  const { error: profileError } = await supabaseClient.from('profiles').insert({
    id: userId,
    full_name: name,
    ministry_id: ministryId,
    job_role_id: jobRoleId,
    years_in_role: years,
    qualification: qual,
    field_of_study: field,
    igot_courses: courses
  });

  if (btn) { btn.disabled = false; btn.textContent = 'Create account'; }

  if (profileError) {
    console.error('Profile save failed:', profileError);
    alert('Your account was created, but saving your profile details failed. Please try logging in and updating your profile.');
    return;
  }

  const thanksName = document.getElementById('thanks-name');
  if (thanksName) thanksName.textContent = name.split(' ')[0] || 'there';
  showSignupStep('signup-success');
}

// ---- run page-specific setup ----
initPage();
