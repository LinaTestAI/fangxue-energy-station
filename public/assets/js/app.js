/* ====================================================================
 * 放学能量站 · H5 小程序 前端逻辑
 * - 微信网页授权（snsapi_base 静默授权）自动登录
 * - 作业 / 历史记录与服务端按用户同步
 * - 5 个视图的完整交互（来自原型）
 * ==================================================================== */

/* ---------- 学科映射（可自定义，按账号存储在服务端） ---------- */
const DEFAULT_SUBJECTS = {
  '数学':{cls:'math',emoji:'➗'},'语文':{cls:'',emoji:'📝'},'英语':{cls:'eng',emoji:'🔤'},
  '体育':{cls:'pe',emoji:'🏃'},'科学':{cls:'',emoji:'🔬'},'美术':{cls:'',emoji:'🎨'},
  '音乐':{cls:'',emoji:'🎵'}
};
let subjectsState = null;   // null 表示使用默认学科；否则为用户自定义
function getSubjects() { return subjectsState || DEFAULT_SUBJECTS; }
function subjectKeys() { return Object.keys(getSubjects()).concat(['其他']); }

/* 解锁后娱乐时长（分钟），按账号存储在服务端 */
let entertainMinutes = 30;
function setEntertain(m) {
  entertainMinutes = m;
  const el = document.getElementById('entertainVal');
  if (el) el.textContent = m + ' 分钟';
  saveSettings();
}
/* 设置统一保存（娱乐时长 + 学科）到服务端 */
async function saveSettings() {
  try {
    await apiPost('/api/settings', {
      entertainMinutes,
      subjects: subjectsState || DEFAULT_SUBJECTS,
    });
  } catch (e) { toast('设置保存失败'); }
}

/* ---------- 业务状态 ---------- */
let hw = [];          // 今日作业 [{id,subj,title,min,done}]
let history = [];     // 历史记录 [{id,subj,title,min}]
let hwFocusId = null; // 正在进行倒计时的作业 id（一次仅一项）
let hwFocusRemain = 0; // 该项剩余秒数
let hwTimer = null;    // 作业倒计时计时器
let loggedIn = false;

/* ====================================================================
 * 1. 网络层（携带 cookie 凭证）
 * ==================================================================== */
async function apiGet(url) {
  const r = await fetch(url, { credentials: 'include' });
  if (r.status === 401) return null;
  if (!r.ok) throw new Error('GET ' + url + ' -> ' + r.status);
  return await r.json();
}
async function apiPost(url, data) {
  const r = await fetch(url, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error('POST ' + url + ' -> ' + r.status);
  return await r.json();
}
/* 保存作业 / 历史（失败仅提示，不阻断交互） */
async function persistHW() {
  try { await apiPost('/api/homework', hw); } catch (e) { toast('作业保存失败'); }
}
async function persistHistory() {
  try { await apiPost('/api/history', history); } catch (e) { toast('历史保存失败'); }
}

/* ====================================================================
 * 2. 微信授权自动登录引导
 * ==================================================================== */
function isWeChat() {
  return /MicroMessenger/i.test(navigator.userAgent);
}
function showLogin(title, desc) {
  const m = document.getElementById('loginMask');
  m.classList.remove('hide');
  if (title) document.getElementById('loginTitle').textContent = title;
  if (desc) document.getElementById('loginDesc').textContent = desc;
}
function hideLogin() {
  document.getElementById('loginMask').classList.add('hide');
}
function loginError(msg) {
  document.getElementById('loginSpin').style.display = 'none';
  document.getElementById('loginTitle').textContent = '登录失败';
  document.getElementById('loginDesc').textContent = msg || '请重试';
  document.getElementById('loginRetry').style.display = 'block';
}

async function bootstrap() {
  loggedIn = false;
  showLogin('正在登录…', isWeChat() ? '微信授权中，请稍候' : '本地调试登录中…');
  // 重置重试按钮（避免上次失败残留）
  document.getElementById('loginSpin').style.display = 'block';
  document.getElementById('loginRetry').style.display = 'none';

  try {
    // 2.1 先尝试读取当前登录态
    const user = await apiGet('/api/user');
    if (user) { onLoggedIn(user); return; }

    // 2.2 未登录：微信内走静默授权跳转；否则本地调试用模拟登录
    if (isWeChat()) {
      const cb = location.origin + '/api/wechat/callback';
      location.href = '/api/wechat/auth?redirect_uri=' + encodeURIComponent(cb);
      return; // 回调后会带 cookie 重定向回本页，再次进入 bootstrap 即登录成功
    } else {
      await apiPost('/api/wechat/mock-login', {});
      const u = await apiGet('/api/user');
      if (u) { onLoggedIn(u); } else { loginError('无法获取用户信息'); }
    }
  } catch (e) {
    loginError('网络异常，请检查服务是否启动');
  }
}

async function onLoggedIn(user) {
  loggedIn = true;
  // 切换账号时清理上一账号的运行态，避免交叉
  clearInterval(focusTimer); focusTimer = null;
  clearInterval(ecTimer); ecTimer = null; entertainRunning = false;
  clearInterval(hwTimer); hwTimer = null; hwFocusId = null; hwFocusRemain = 0;

  hideLogin();

  // 1) 设置（娱乐时长 + 学科），按账号隔离
  try {
    const s = await apiGet('/api/settings');
    if (s && typeof s === 'object') {
      if (s.entertainMinutes > 0) entertainMinutes = s.entertainMinutes;
      // 兼容旧版数组格式（["数学","语文"...]）与对象格式（{"数学":{cls,emoji}}）
      if (Array.isArray(s.subjects)) {
        subjectsState = Object.fromEntries(s.subjects.map(k => [k, { cls: '', emoji: '📄' }]));
      } else if (s.subjects && typeof s.subjects === 'object') {
        subjectsState = s.subjects;
      }
    }
  } catch (e) {}

  // 2) 该账号的作业（默认演示账号空时填充样例，其余账号空则留空以示独立）
  try {
    const h = await apiGet('/api/homework');
    if (Array.isArray(h) && h.length) {
      hw = h;
    } else if (user.openid === 'openid_demo') {
      hw = seedHomework(); await persistHW();
    } else {
      hw = [];
    }
  } catch (e) { hw = []; }

  // 3) 该账号的历史
  try {
    const his = await apiGet('/api/history');
    if (Array.isArray(his) && his.length) history = his;
    else if (user.openid === 'openid_demo') { history = seedHistory(); await persistHistory(); }
    else { history = []; }
  } catch (e) { history = []; }

  setEntertain(entertainMinutes);   // 同步设置页显示
  renderHW();
  renderHistory();
  renderSummary();
  toast('登录成功' + (user.openid === 'openid_demo' ? ' 👋' : ''));
}

/* 首次演示数据 */
function seedHomework() {
  return [
    { id: 1, subj: '数学', title: '口算题卡一页', min: 15, done: true },
    { id: 2, subj: '语文', title: '背诵第5课+默写生字', min: 20, done: false },
    { id: 3, subj: '英语', title: '听读 Unit3 单词', min: 10, done: false },
  ];
}
function seedHistory() {
  return [
    { id: 201, subj: '数学', title: '计算每日一练', min: 15 },
    { id: 202, subj: '语文', title: '阅读理解一篇', min: 20 },
    { id: 203, subj: '英语', title: '朗读课文 Unit2', min: 10 },
    { id: 204, subj: '体育', title: '跳绳 100 个', min: 10 },
  ];
}

/* ====================================================================
 * 3. 今日作业清单
 * ==================================================================== */
function renderHW() {
  const list = document.getElementById('hwList');
  list.innerHTML = '';
  if (!hw.length) {
    list.innerHTML = '<div class="empty">还没有作业，点右上角「+ 添加」吧</div>';
  }
  hw.forEach((h, idx) => {
    const s = getSubjects()[h.subj] || { cls: '', emoji: '📄' };
    const focusing = hwFocusId === h.id;
    const locked = !h.done && hwFocusId !== null && !focusing; // 有别的作业在专注中 → 本项锁定
    const div = document.createElement('div');
    div.className = 'hw' + (h.done ? ' done' : '') + (focusing ? ' focusing' : '') + (locked ? ' locked' : '');
    let right;
    if (h.done) right = '✓';
    else if (focusing) right = `<span class="cd" id="hwCD-${h.id}">${mmss(hwFocusRemain)}</span>`;
    else if (locked) right = '🔒';
    else right = `${h.min}′ ▶`;
    div.innerHTML = `
      <div class="check">${h.done ? '✓' : ''}</div>
      <div class="info">
        <span class="subj ${s.cls}">${h.subj}</span>
        <div class="title">${h.title}</div>
        <div class="meta">${h.done ? '已完成 ✓' : (focusing ? '专注中…' : (locked ? '待解锁' : '点击开始'))}</div>
      </div>
      <div class="time">${right}</div>
      <div class="reorder">
        <button class="mv ${idx === 0 ? 'dis' : ''}" ${idx === 0 ? 'disabled' : ''} onclick="event.stopPropagation();moveHW(${idx},-1)">▲</button>
        <button class="mv ${idx === hw.length - 1 ? 'dis' : ''}" ${idx === hw.length - 1 ? 'disabled' : ''} onclick="event.stopPropagation();moveHW(${idx},1)">▼</button>
      </div>`;
    if (!h.done && !focusing && !locked) div.onclick = () => startFocusTask(h.id);
    list.appendChild(div);
  });
  updateUnlock();
  renderSummary();
}
function moveHW(idx, dir) {
  const ni = idx + dir;
  if (ni < 0 || ni >= hw.length) return;
  const t = hw[idx]; hw[idx] = hw[ni]; hw[ni] = t;
  renderHW();
  persistHW();
  toast('已调整完成顺序');
}
/* 秒 → mm:ss */
function mmss(sec) {
  const m = String(Math.floor(sec / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return m + ':' + s;
}
/* 开始某项作业的专注倒计时（时长 = 该项预计完成分钟数） */
function startFocusTask(id) {
  const h = hw.find(x => x.id === id);
  if (!h || h.done || hwFocusId) return; // 一次只专注一项
  hwFocusId = id;
  hwFocusRemain = h.min * 60;
  renderHW();
  clearInterval(hwTimer);
  hwTimer = setInterval(() => {
    hwFocusRemain--;
    const el = document.getElementById('hwCD-' + id);
    if (el) el.textContent = mmss(hwFocusRemain);
    if (hwFocusRemain <= 0) {
      clearInterval(hwTimer);
      completeTask(id);
    }
  }, 1000);
  toast('开始专注：' + h.subj + ' ' + h.min + ' 分钟');
}
/* 倒计时结束 → 标记完成并持久化，解锁下一项 */
function completeTask(id) {
  const h = hw.find(x => x.id === id);
  if (!h) return;
  h.done = true;
  hwFocusId = null; hwFocusRemain = 0;
  clearInterval(hwTimer);
  renderHW();
  persistHW();
  updateUnlock();
  toast('完成！下一项已解锁 🔓');
}
function updateUnlock() {
  const all = hw.length > 0 && hw.every(h => h.done);
  const btn = document.getElementById('unlockBtn');
  btn.disabled = !all;
  btn.textContent = all ? '全部完成 · 解锁手机 🔓' : '全部完成才能解锁 🔓';
  btn.onclick = all ? doUnlock : null;
  const pct = hw.length ? Math.round(hw.filter(h => h.done).length / hw.length * 100) : 0;
  document.getElementById('energyTitle').textContent = `能量已充 ${pct}%`;
  document.getElementById('energyBar').style.width = pct + '%';
}
function renderSummary() {
  const el = document.getElementById('summaryList');
  if (!el) return;
  if (!hw.length) { el.innerHTML = '<div class="empty">暂无作业</div>'; return; }
  el.innerHTML = hw.map(h => `
    <div class="preview-item">
      <span class="subj">${h.subj}</span>
      <span style="flex:1;font-size:14px;font-weight:600;">${h.title}</span>
      <span style="font-size:12px;color:${h.done ? '#1E9E4A' : '#AEB4BF'};">${h.done ? '✓' : '…'}</span>
    </div>`).join('');
}

/* ---------- 解锁 ---------- */
function tryUnlock() {
  const all = hw.length > 0 && hw.every(h => h.done);
  if (all) doUnlock(); else toast('还有作业没完成哦');
}
function doUnlock() {
  toast('🎉 作业全部完成，手机已解锁！');
  const c = document.getElementById('unlockCenter');
  c.querySelector('.battery').textContent = '🔋';
  c.querySelector('h2').textContent = '能量充满 · 手机已解锁';
  c.querySelector('p').textContent = '娱乐倒计时结束后将重新锁定';
  document.getElementById('entertainCD').style.display = 'block';
  document.getElementById('ctrlBtns').style.display = 'flex';
  startEntertain(entertainMinutes * 60);
  go('v-unlock');
}
let ecTimer = null, entertainRemain = 0, entertainRunning = false;
function startEntertain(sec) {
  entertainRemain = sec; entertainRunning = true; runEntertain();
}
function runEntertain() {
  clearInterval(ecTimer);
  ecTimer = setInterval(() => {
    entertainRemain--;
    if (entertainRemain <= 0) {
      clearInterval(ecTimer); entertainRunning = false; updateCD();
      toast('⏰ 娱乐时间到，手机已重新锁定'); relock(); return;
    }
    updateCD();
  }, 1000);
}
function updateCD() {
  const el = document.getElementById('entertainCD');
  if (!el) return;
  const m = String(Math.floor(entertainRemain / 60)).padStart(2, '0');
  const s = String(entertainRemain % 60).padStart(2, '0');
  el.textContent = `${m}:${s}`;
}
/* 暂停：停止倒计时；开始：从暂停点继续（不重置已用时间） */
function pauseEntertain() { clearInterval(ecTimer); entertainRunning = false; toast('已暂停，倒计时停止'); }
function resumeEntertain() { if (!entertainRunning && entertainRemain > 0) { entertainRunning = true; runEntertain(); toast('继续倒计时'); } }
function relock() {
  const c = document.getElementById('unlockCenter');
  c.querySelector('.battery').textContent = '🔒';
  c.querySelector('h2').textContent = '手机已锁定';
  c.querySelector('p').textContent = '明天继续加油完成作业吧！';
  document.getElementById('entertainCD').style.display = 'none';
  document.getElementById('ctrlBtns').style.display = 'none';
}

/* ====================================================================
 * 4. 添加作业（智能解析 + 确认列表编辑/删除 + 历史）
 * ==================================================================== */
function seg(b, mode) {
  document.querySelectorAll('#v-add .seg button').forEach(x => x.classList.remove('on'));
  b.classList.add('on');
  document.getElementById('pasteBox').style.display = mode === 'paste' ? 'block' : 'none';
  document.getElementById('ocrBox').style.display = mode === 'ocr' ? 'block' : 'none';
}
function pickImage() { document.getElementById('ocrFile').click(); }
function onImageChosen() {
  const f = document.getElementById('ocrFile');
  if (f.files && f.files.length) toast('已选择图片（演示：直接按示例解析）');
}
/* 一次提交只识别一个学科：扫描整段文本，取首个命中的学科关键字 */
function detectSubject(text) {
  for (const k in getSubjects()) { if (text.includes(k)) return k; }
  return '其他';
}
function parseHW() {
  const txt = document.getElementById('hwInput').value;
  const lines = (txt || '数学：口算题卡一页（约15分钟）\n数学：应用题5道（约20分钟）\n数学：口算打卡（约10分钟）')
    .split('\n').map(s => s.trim()).filter(Boolean);
  const batch = detectSubject(txt || '数学');
  window.__batchSubject = batch;
  const found = lines.map(line => {
    const m = line.match(/(\d+)\s*分钟/);
    return { subj: batch, title: line.replace(/[（(].*?[)）]/g, '').slice(0, 20), min: m ? +m[1] : 15 };
  });
  window.__parsed = found;
  renderPreview();
  document.getElementById('previewBox').style.display = 'block';
}
/* 确认列表：每条可改学科/内容/时长，可删除 */
function renderPreview() {
  const box = document.getElementById('previewList');
  const batch = window.__batchSubject || '其他';
  let html = `<div class="batch-banner">本次提交识别为：<b>${batch}</b> · 整批作业将归档到该学科</div>`;
  html += (window.__parsed || []).map((f, idx) => {
    const opts = subjectKeys().map(k => `<option ${k === f.subj ? 'selected' : ''}>${k}</option>`).join('');
    return `<div class="preview-item">
      <select class="pv-subj" onchange="editItem(${idx},'subj',this.value)">${opts}</select>
      <input class="pv-title" value="${f.title}" oninput="editItem(${idx},'title',this.value)"/>
      <input class="pv-min" type="number" min="1" value="${f.min}" oninput="editItem(${idx},'min',this.value)"/>′
      <button class="pv-del" onclick="delItem(${idx})" title="删除">✕</button>
    </div>`;
  }).join('');
  if (!window.__parsed || window.__parsed.length === 0)
    html += '<div class="empty">暂无作业项，可返回修改后重新解析</div>';
  box.innerHTML = html;
}
function editItem(idx, field, val) {
  if (window.__parsed && window.__parsed[idx]) {
    window.__parsed[idx][field] = (field === 'min') ? (+val || 15) : val;
  }
}
function delItem(idx) {
  if (window.__parsed) window.__parsed.splice(idx, 1);
  renderPreview();
  toast('已删除该项');
}
function confirmHW() {
  const maxId = hw.length ? Math.max(...hw.map(h => h.id)) : 0;
  const hmax = history.length ? Math.max(...history.map(h => h.id)) : 200;
  (window.__parsed || []).forEach((f, i) => {
    hw.push({ id: maxId + i + 1, subj: f.subj, title: f.title, min: f.min, done: false });
    history.push({ id: hmax + i + 1, subj: f.subj, title: f.title, min: f.min });
  });
  renderHW();
  renderHistory();
  // 确认加入后清空输入框与确认列表，避免重复提交
  document.getElementById('hwInput').value = '';
  document.getElementById('previewBox').style.display = 'none';
  document.getElementById('previewList').innerHTML = '';
  window.__parsed = [];
  persistHW();
  persistHistory();
  toast('已加入今日作业清单');
  go('v-home');
}

/* ---------- 历史作业记录 ---------- */
function renderHistory() {
  const box = document.getElementById('historyList');
  if (!box) return;
  if (!history.length) { box.innerHTML = '<div class="empty">暂无历史记录</div>'; return; }
  box.innerHTML = history.map((h, idx) => `
    <div class="preview-item">
      <select class="pv-subj" onchange="editHis(${idx},'subj',this.value)">${subjectKeys().map(k => `<option ${k === h.subj ? 'selected' : ''}>${k}</option>`).join('')}</select>
      <input class="pv-title" value="${h.title}" oninput="editHis(${idx},'title',this.value)"/>
      <input class="pv-min" type="number" min="1" value="${h.min}" oninput="editHis(${idx},'min',this.value)"/>′
      <button class="pv-del" onclick="delHis(${idx})" title="删除">✕</button>
      <button class="pv-reuse" onclick="reuseHis(${idx})" title="加入今日">＋</button>
    </div>`).join('');
}
function editHis(idx, field, val) {
  if (history[idx]) { history[idx][field] = (field === 'min') ? (+val || 15) : val; persistHistory(); }
}
function delHis(idx) { history.splice(idx, 1); renderHistory(); persistHistory(); toast('已删除历史记录'); }
function reuseHis(idx) {
  const h = history[idx];
  if (!h) return;
  const maxId = hw.length ? Math.max(...hw.map(x => x.id)) : 0;
  hw.push({ id: maxId + 1, subj: h.subj, title: h.title, min: h.min, done: false });
  renderHW(); persistHW(); toast('已加入今日作业');
}

/* ====================================================================
 * 5. 专注训练
 * ==================================================================== */
let focusTimer = null;
function pick(el, row) {
  document.querySelectorAll('#' + row + ' .opt').forEach(x => x.classList.remove('on'));
  el.classList.add('on');
}
function startFocus() {
  const dur = +document.querySelector('#durRow .opt.on').dataset.v;
  const proj = document.querySelector('#projRow .opt.on').dataset.v;
  const emoji = { '读书': '📖', '坐姿': '🧘', '站姿': '🚶' }[proj];
  document.getElementById('projName').textContent = emoji + ' ' + proj;
  document.getElementById('focusRun').style.display = 'block';
  document.getElementById('focusBtn').textContent = '重新开始';   // 训练中按钮变为“重新开始”
  let sec = dur * 60;
  const ring = document.getElementById('ring');
  const total = dur * 60;
  clearInterval(focusTimer);   // 重算前先清除旧计时器，避免叠加
  focusTimer = setInterval(() => {
    sec--;
    const m = String(Math.floor(sec / 60)).padStart(2, '0');
    const s = String(sec % 60).padStart(2, '0');
    ring.textContent = `${m}:${s}`;
    const deg = (1 - sec / total) * 360;
    ring.style.background = `conic-gradient(var(--green) ${deg}deg,#E8F8EE ${deg}deg)`;
    if (sec <= 0) {
      clearInterval(focusTimer);
      document.getElementById('focusBtn').textContent = '开始专注';
      toast('🎉 专注完成，太棒了！');
    }
  }, 1000);
}

/* ====================================================================
 * 6. 导航 / 提示 / 工具
 * ==================================================================== */
function go(v) {
  document.querySelectorAll('.view').forEach(x => x.classList.remove('active'));
  document.getElementById(v).classList.add('active');
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.v === v));
  const scr = document.querySelector('.screen.active');
  if (scr) scr.scrollTop = 0;
}

let tt;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(tt); tt = setTimeout(() => t.classList.remove('show'), 1800);
}

/* 清除本地缓存（退出登录态，演示用） */
async function clearData() {
  try { await apiPost('/api/wechat/mock-login', {}); } catch (e) {}
  toast('缓存已重置，重新登录');
  setTimeout(bootstrap, 600);
}

/* 状态栏时钟 */
function tickClock() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const el = document.getElementById('clock');
  if (el) el.textContent = `${hh}:${mm}`;
  const wd = ['周日','周一','周二','周三','周四','周五','周六'][d.getDay()];
  const de = document.getElementById('todayDate');
  if (de) de.textContent = `${wd} · ${d.getMonth() + 1}月${d.getDate()}日`;
}

/* ---------- 设置弹层（解锁后娱乐时长 / 学科自定义） ---------- */
function openSheet(id) { document.getElementById(id).classList.add('show'); }
function closeSheet(id) { document.getElementById(id).classList.remove('show'); }

function openEntertainModal() {
  const grid = document.getElementById('entertainOpts');
  const opts = [15, 20, 30, 45, 60];
  grid.innerHTML = opts.map(m =>
    `<button class="chip-opt ${m === entertainMinutes ? 'on' : ''}" onclick="pickEntertain(${m})">${m} 分钟</button>`
  ).join('');
  openSheet('entertainSheet');
}
function pickEntertain(m) {
  setEntertain(m);
  document.querySelectorAll('#entertainOpts .chip-opt').forEach(b =>
    b.classList.toggle('on', +b.textContent.replace(/\D/g, '') === m));
}

function openSubjectModal() { renderSubjManage(); openSheet('subjectSheet'); }
function renderSubjManage() {
  const box = document.getElementById('subjManage');
  const keys = Object.keys(getSubjects());
  if (!keys.length) { box.innerHTML = '<div class="empty">暂无学科</div>'; return; }
  box.innerHTML = keys.map(k =>
    `<span class="subj-chip">${k}<button onclick="delSubject('${k}')" title="删除">✕</button></span>`
  ).join('');
}
function addSubject() {
  const inp = document.getElementById('subjInput');
  const name = (inp.value || '').trim();
  if (!name) return;
  if (!subjectsState) subjectsState = Object.assign({}, DEFAULT_SUBJECTS);  // 不污染默认学科
  if (subjectsState[name]) { toast('该学科已存在'); return; }
  subjectsState[name] = { cls: '', emoji: '📄' };
  renderSubjManage(); inp.value = ''; saveSettings(); toast('已添加学科：' + name);
}
function delSubject(k) {
  if (!subjectsState) subjectsState = Object.assign({}, DEFAULT_SUBJECTS);
  if (Object.keys(subjectsState).length <= 1) { toast('至少保留一个学科'); return; }
  delete subjectsState[k];
  renderSubjManage(); saveSettings(); toast('已删除：' + k);
}

/* ====================================================================
 * 启动
 * ==================================================================== */
tickClock();
setInterval(tickClock, 30000);
const _ev = document.getElementById('entertainVal');   // 仅同步显示，未登录不保存
if (_ev) _ev.textContent = entertainMinutes + ' 分钟';
bootstrap();
