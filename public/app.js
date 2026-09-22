'use strict';

/* ==================================================================
   状态
   ================================================================== */
const S = {
  presets: [],
  settings: {},
  prompt: '',
  batches: [],
  current: null,
  queue: [],
  grading: false,
  open: new Set(),
  editing: null,
  recordBatch: null,
  recordData: null,
  archive: null,
  archClass: '',
  qThumb: ''
};

/* ==================================================================
   工具
   ================================================================== */
async function api(path, body) {
  const opt = body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : {};
  const res = await fetch(path, opt);
  let j;
  try { j = await res.json(); } catch (e) { j = { ok: false, error: '返回内容解析失败' }; }
  if (!res.ok && !j.error) j.error = 'HTTP ' + res.status;
  return j;
}

const esc = (s) => String(s === undefined || s === null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function tierClass(score) {
  if (score >= 21) return 'b1';
  if (score >= 16) return 'b2';
  if (score >= 11) return 'b3';
  if (score >= 6) return 'b4';
  return 'b5';
}
function tierOf(score) {
  if (score >= 21) return '一档（优秀）';
  if (score >= 16) return '二档（良好）';
  if (score >= 11) return '三档（合格）';
  if (score >= 6) return '四档（较差）';
  return '五档（极差）';
}
function eff(e) {
  if (e.review && e.review.confirmed) return e.review;
  return e.ai || null;
}
function statusBadge(e) {
  if (e.status === 'pending') return '<span class="badge bg-pend">未批改</span>';
  if (e.status === 'grading') return '<span class="badge bg-run">批改中…</span>';
  if (e.status === 'error') return '<span class="badge bg-err">批改失败</span>';
  if (e.reviewed) return '<span class="badge bg-rev">教师已复核</span>';
  if (isEmptyResult(e.ai)) return '<span class="badge bg-err">疑似空结果</span>';
  return '<span class="badge bg-done">AI 初评</span>';
}

/* 模型偶尔会返回空模板（全 0 分、无任何文本），这不是真实成绩，要当成失败处理 */
function isEmptyResult(r) {
  if (!r) return false;
  const text = String(r.transcription || '') + String(r.comment || '');
  const hasList = (r.problems && r.problems.length) || (r.suggestions && r.suggestions.length) ||
    (r.deductions && r.deductions.length) || (r.pointsDetail && r.pointsDetail.length);
  return !text.trim() && !hasList;
}

/* 需要重新批改：失败、或结果为空且教师尚未复核 */
function needsRegrade(e) {
  if (e.reviewed) return false;
  if (e.status === 'error') return true;
  return e.status === 'done' && isEmptyResult(e.ai);
}

/* 是否有可用的批改结果（既要有结果，又不能是空模板；未批改的 ai 为 null 也要排除） */
function hasResult(e) {
  const r = eff(e);
  return !!(r && !isEmptyResult(r));
}
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/* 图片压缩：降低传输体积，同时保留足够手写辨识度 */
function compress(file, maxSide, quality) {
  maxSide = maxSide || 1800;
  quality = quality || 0.85;
  return new Promise((resolve, reject) => {
    if (!/^image\//.test(file.type)) { reject(new Error('不是图片文件')); return; }
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = function () {
      let w = img.naturalWidth, h = img.naturalHeight;
      const scale = Math.min(1, maxSide / Math.max(w, h));
      w = Math.round(w * scale); h = Math.round(h * scale);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve({ dataUrl: c.toDataURL('image/jpeg', quality), w: w, h: h });
    };
    img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
    img.src = url;
  });
}

/* ==================================================================
   视图切换
   ================================================================== */
document.querySelectorAll('.topnav button').forEach(function (b) {
  b.addEventListener('click', function () {
    document.querySelectorAll('.topnav button').forEach((x) => x.classList.remove('on'));
    document.querySelectorAll('.view').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    document.getElementById('view-' + b.dataset.v).classList.add('on');
    if (b.dataset.v === 'records') renderRecords();
    if (b.dataset.v === 'archive') renderArchive();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
});

/* ==================================================================
   初始化
   ================================================================== */
async function loadState() {
  const st = await api('/api/state');
  if (!st.ok) { alert('读取数据失败：' + (st.error || '')); return; }
  S.presets = st.presets || [];
  S.settings = st.settings || {};
  S.prompt = st.prompt || '';
  S.batches = st.batches || [];
  renderStatus();
  renderBatchSelect();
  renderPresets();
  fillSettings();
  document.getElementById('promptBox').value = S.prompt;
  renderBatchList();
  if (S.batches.length) {
    if (!S.current || !S.batches.some((b) => b.id === S.current.id)) {
      await openBatch(S.batches[0].id);
    }
  } else {
    renderWorkbench();
  }
  renderRecords();
}

function renderStatus() {
  const el = document.getElementById('apiStatus');
  if (S.settings.hasKey) {
    el.className = 'dotst ok';
    el.querySelector('span').textContent = '接口已配置 ' + (S.settings.model || '');
  } else {
    el.className = 'dotst no';
    el.querySelector('span').textContent = '未配置接口';
  }
}

function renderBatchSelect() {
  const sel = document.getElementById('batchSelect');
  if (!S.batches.length) {
    sel.innerHTML = '<option value="">（还没有批次，先新建一个）</option>';
    return;
  }
  sel.innerHTML = S.batches.map(function (b) {
    return '<option value="' + b.id + '">' + esc(b.title) + (b.className ? ' · ' + esc(b.className) : '') +
      '（' + b.done + '/' + b.count + '）</option>';
  }).join('');
  if (S.current) sel.value = S.current.id;
}

/* ==================================================================
   批次
   ================================================================== */
async function openBatch(id) {
  const r = await api('/api/batch/get', { id: id });
  if (!r.ok) return;
  S.current = r.batch;
  S.open = new Set();
  S.editing = null;
  document.getElementById('batchSelect').value = id;
  renderWorkbench();
}

async function refreshCurrent() {
  if (!S.current) return;
  const r = await api('/api/batch/get', { id: S.current.id });
  if (r.ok) S.current = r.batch;
}

async function refreshSummaries() {
  const st = await api('/api/state');
  if (st.ok) { S.batches = st.batches; renderBatchSelect(); renderBatchList(); }
}

document.getElementById('batchSelect').addEventListener('change', function () {
  if (this.value) openBatch(this.value);
});

document.getElementById('btnNewBatch').addEventListener('click', function () {
  const c = document.getElementById('newBatchCard');
  c.style.display = c.style.display === 'none' ? 'block' : 'none';
  if (c.style.display === 'block') document.getElementById('nbTitle').focus();
});
document.getElementById('btnCancelBatch').addEventListener('click', function () {
  document.getElementById('newBatchCard').style.display = 'none';
});

document.getElementById('btnCreateBatch').addEventListener('click', async function () {
  const title = document.getElementById('nbTitle').value.trim();
  if (!title) { alert('请先填写作文题目'); return; }
  const points = ['nbP1', 'nbP2', 'nbP3'].map((id) => document.getElementById(id).value.trim()).filter(Boolean);
  const r = await api('/api/batch/create', {
    title: title,
    className: document.getElementById('nbClass').value.trim(),
    points: points
  });
  if (!r.ok) { alert('创建失败：' + r.error); return; }
  ['nbTitle', 'nbClass', 'nbP1', 'nbP2', 'nbP3'].forEach((id) => { document.getElementById(id).value = ''; });
  resetQuestionPhoto();
  document.getElementById('newBatchCard').style.display = 'none';
  await refreshSummaries();
  await openBatch(r.batch.id);
});

document.getElementById('btnDelBatch').addEventListener('click', async function () {
  if (!S.current) { alert('当前没有选中批次'); return; }
  if (!confirm('确定删除批次「' + S.current.title + '」及其全部作文照片和记录？此操作不可恢复。')) return;
  const r = await api('/api/batch/delete', { id: S.current.id });
  warnCleanup(r);
  S.current = null;
  await refreshSummaries();
  if (S.batches.length) await openBatch(S.batches[0].id);
  else renderWorkbench();
});

/* 照片文件没删干净时明确提醒，避免学生信息留在磁盘上 */
function warnCleanup(r) {
  if (r && r.cleanupFailed) {
    alert('记录已删除，但有 ' + r.cleanupFailed + ' 张照片文件未能删除。\n\n请手动打开文件夹清理：\n' + (r.uploadDir || 'data/uploads'));
  }
}

/* ==================================================================
   题目拍照识别
   ================================================================== */
const qDrop = document.getElementById('qDrop');
const qFile = document.getElementById('qFile');

qDrop.addEventListener('click', () => qFile.click());
qDrop.addEventListener('dragover', function (e) { e.preventDefault(); qDrop.classList.add('over'); });
qDrop.addEventListener('dragleave', () => qDrop.classList.remove('over'));
qDrop.addEventListener('drop', function (e) {
  e.preventDefault();
  qDrop.classList.remove('over');
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) handleQuestionPhoto(f);
});
qFile.addEventListener('change', function () {
  if (this.files[0]) handleQuestionPhoto(this.files[0]);
  this.value = '';
});

// 支持直接粘贴截图（从 PDF 里截作文题是最快的方式）
document.getElementById('newBatchCard').addEventListener('paste', function (e) {
  const items = (e.clipboardData && e.clipboardData.items) || [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].type && items[i].type.indexOf('image/') === 0) {
      const f = items[i].getAsFile();
      if (f) { handleQuestionPhoto(f); e.preventDefault(); return; }
    }
  }
});

document.getElementById('qClear').addEventListener('click', resetQuestionPhoto);

function resetQuestionPhoto() {
  document.getElementById('qResult').style.display = 'none';
  document.getElementById('qThumb').src = '';
  document.getElementById('qInfo').innerHTML = '';
  S.qThumb = '';
}

document.getElementById('qThumb').addEventListener('click', function () {
  if (!this.src) return;
  document.getElementById('modalImg').src = this.src;
  document.getElementById('modalCap').textContent = '试卷题目照片';
  document.getElementById('modal').classList.add('on');
});

async function handleQuestionPhoto(file) {
  const box = document.getElementById('qResult');
  const info = document.getElementById('qInfo');
  box.style.display = 'flex';
  info.innerHTML = '<span class="spin">正在识别题目…</span>';

  let dataUrl;
  try {
    const c = await compress(file);
    dataUrl = c.dataUrl;
    S.qThumb = dataUrl;
    document.getElementById('qThumb').src = dataUrl;
  } catch (e) {
    info.innerHTML = '<span class="bad">图片读取失败：</span>' + esc(e.message);
    return;
  }

  if (!S.settings.hasKey) {
    info.innerHTML = '<span class="bad">还没有配置 API Key</span>，无法自动识别。' +
      '到「设置」填好 Key 后重试，或直接手动输入题目和要点（不影响后续批改）。';
    return;
  }

  const r = await api('/api/parse-question', { dataUrl: dataUrl });
  if (!r.ok) {
    info.innerHTML = '<span class="bad">识别失败：</span>' + esc(r.error || '未知错误') +
      (r.raw ? '<div class="ta mono" style="margin-top:8px;max-height:110px">' + esc(r.raw) + '</div>' : '') +
      '<div style="margin-top:6px;color:var(--ink3)">可以手动输入题目和要点，不影响后续批改。</div>';
    return;
  }

  const q = r.question || {};
  if (q.title) document.getElementById('nbTitle').value = q.title;
  const pts = q.points || [];
  ['nbP1', 'nbP2', 'nbP3'].forEach(function (id, i) {
    if (pts[i]) document.getElementById(id).value = pts[i];
  });

  let html = '';
  if (q.title) html += '<div><b>题目：</b>' + esc(q.title) + '</div>';
  if (q.titleCn) html += '<div><b>中文题干：</b>' + esc(q.titleCn) + '</div>';
  const meta = [];
  if (q.wordLimit) meta.push('词数 ' + q.wordLimit);
  if (q.format) meta.push('文体 ' + q.format);
  if (meta.length) html += '<div><b>要求：</b>' + esc(meta.join('　·　')) + '</div>';
  if (pts.length) {
    html += '<div><b>识别到 ' + pts.length + ' 个要点：</b><ul>' +
      pts.map((p) => '<li>' + esc(p) + '</li>').join('') + '</ul></div>';
    if (pts.length > 3) {
      html += '<div style="color:var(--t4)">识别到 ' + pts.length +
        ' 个要点，表单只有 3 个输入框，多出的请自行取舍或合并。</div>';
    }
  } else {
    html += '<div class="bad">没有识别出明确的写作要点，请手动填写。</div>';
  }
  if (q.raw) html += '<div style="margin-top:6px;color:var(--ink3)">识别原文：' + esc(q.raw).slice(0, 200) + '</div>';
  html += '<div class="ok" style="margin-top:8px">✓ 已填入下方表单，请核对无误后再创建批次</div>';
  info.innerHTML = html;
}

/* ==================================================================
   工作台渲染
   ================================================================== */
function renderWorkbench() {
  const b = S.current;
  const info = document.getElementById('batchInfo');
  const up = document.getElementById('uploadCard');
  const sub = document.getElementById('curSub');

  if (!b) {
    sub.textContent = '';
    info.innerHTML = '<div class="empty"><div class="ic">📋</div>还没有批改批次<br>点右上角「＋ 新建批次」，填好作文题目和 3 个核心要点再上传照片</div>';
    up.style.display = 'none';
    document.getElementById('essayList').innerHTML = '';
    document.getElementById('resSub').textContent = '';
    return;
  }

  up.style.display = 'block';
  const done = b.essays.filter((e) => e.status === 'done').length;
  const rev = b.essays.filter((e) => e.reviewed).length;
  const pts = (b.points || []).length
    ? b.points.map((p, i) => (i + 1) + '. ' + esc(p)).join('　')
    : '未填写（漏点判定会不准，建议补上）';
  sub.textContent = '创建于 ' + fmtDate(b.createdAt);
  info.innerHTML = '<div class="tip" style="margin-top:14px">' +
    '<b>题目：</b>' + esc(b.title) +
    (b.className ? '　　<b>班级：</b>' + esc(b.className) : '') +
    '<br><b>核心要点：</b>' + pts +
    '<br><b>进度：</b>已上传 ' + b.essays.length + ' 篇　·　已批改 ' + done + ' 篇　·　教师已复核 ' + rev + ' 篇' +
    '</div>';

  renderQueue();
  renderEssays();
}

function renderQueue() {
  const g = document.getElementById('qgrid');
  g.innerHTML = S.queue.map(function (it, i) {
    return '<div class="qitem"><img src="' + it.dataUrl + '" alt="">' +
      '<button class="x" data-qi="' + i + '" title="移除">×</button>' +
      '<div class="cap"><span>' + esc(it.name).slice(0, 12) + '</span><span>' + (it.w || '') + 'px</span></div></div>';
  }).join('');
  const n = S.queue.length;
  document.getElementById('btnGrade').disabled = n === 0 || S.grading;
  document.getElementById('btnClearQueue').disabled = n === 0 || S.grading;
  document.getElementById('gradeHint').textContent = n
    ? '共 ' + n + ' 张待批改，编号将从第 ' + ((S.current ? S.current.essays.length : 0) + 1) + ' 号开始'
    : '';
}

document.getElementById('qgrid').addEventListener('click', function (ev) {
  const b = ev.target.closest('[data-qi]');
  if (!b) return;
  S.queue.splice(Number(b.dataset.qi), 1);
  renderQueue();
});

/* ---------- 上传 ---------- */
const drop = document.getElementById('drop');
const fileInput = document.getElementById('fileInput');

drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', function (e) {
  e.preventDefault();
  drop.classList.remove('over');
  handleFiles(e.dataTransfer.files);
});
fileInput.addEventListener('change', function () {
  handleFiles(this.files);
  this.value = '';
});

async function handleFiles(files) {
  if (!files || !files.length) return;
  if (!S.current) { alert('请先新建或选择一个批次'); return; }
  const arr = Array.from(files);
  const hint = document.getElementById('gradeHint');
  for (let i = 0; i < arr.length; i++) {
    hint.textContent = '正在处理第 ' + (i + 1) + '/' + arr.length + ' 张…';
    try {
      const c = await compress(arr[i]);
      S.queue.push({ dataUrl: c.dataUrl, name: arr[i].name, w: c.w, h: c.h });
      renderQueue();
    } catch (e) {
      alert(arr[i].name + '：' + e.message);
    }
  }
  renderQueue();
}

document.getElementById('btnClearQueue').addEventListener('click', function () {
  S.queue = [];
  renderQueue();
});

/* ---------- 批改 ---------- */
document.getElementById('btnGrade').addEventListener('click', async function () {
  if (S.grading || !S.current) return;
  if (!S.settings.hasKey) {
    if (!confirm('还没有配置 AI 接口，暂时无法自动批改。\n\n是否现在去「设置」填写 API Key？')) return;
    document.querySelector('.topnav button[data-v=settings]').click();
    return;
  }
  const total = S.queue.length;
  if (!total) return;

  S.grading = true;
  const pw = document.getElementById('progWrap'), pt = document.getElementById('progTxt');
  pw.style.display = 'block'; pt.style.display = 'flex';
  renderQueue();

  const items = S.queue.slice();
  S.queue = [];
  renderQueue();

  let okCount = 0, failCount = 0;

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const pct = Math.round((i / total) * 100);
    document.getElementById('progBar').style.width = pct + '%';
    pt.innerHTML = '<span>正在处理第 ' + (i + 1) + ' / ' + total + ' 篇</span><span>' + pct + '%</span>';

    let up;
    try {
      up = await api('/api/upload', { batchId: S.current.id, name: it.name, dataUrl: it.dataUrl });
    } catch (e) {
      failCount++; continue;
    }
    if (!up.ok) { failCount++; continue; }

    S.current.essays.push(up.essay);
    S.open.add(up.essay.id);
    renderEssays();

    const g = await api('/api/grade', { batchId: S.current.id, essayId: up.essay.id });
    if (g.essay) {
      const idx = S.current.essays.findIndex((x) => x.id === g.essay.id);
      if (idx > -1) S.current.essays[idx] = g.essay;
    }
    if (g.ok && g.essay && g.essay.status === 'done') okCount++; else failCount++;
    renderEssays();

    document.getElementById('progBar').style.width = Math.round(((i + 1) / total) * 100) + '%';
  }

  document.getElementById('progBar').style.width = '100%';
  pt.innerHTML = '<span>完成：成功 ' + okCount + ' 篇' + (failCount ? '，失败 ' + failCount + ' 篇' : '') + '</span><span>100%</span>';

  S.grading = false;
  renderQueue();
  renderWorkbench();
  await refreshSummaries();
  setTimeout(function () { pw.style.display = 'none'; pt.style.display = 'none'; }, 4000);
});

/* ---------- 结果卡片 ---------- */
function renderEssays() {
  const box = document.getElementById('essayList');
  const b = S.current;
  const btn = document.getElementById('btnRegrade');
  if (!b || !b.essays.length) {
    box.innerHTML = '<div class="empty"><div class="ic">🗂</div>这个批次还没有作文<br>选好照片后点「开始批改」，结果会按编号出现在这里</div>';
    document.getElementById('resSub').textContent = '';
    btn.style.display = 'none';
    return;
  }
  const done = b.essays.filter((e) => e.status === 'done' && !isEmptyResult(e.ai)).length;
  const rev = b.essays.filter((e) => e.reviewed).length;
  const bad = b.essays.filter(needsRegrade).length;
  document.getElementById('resSub').textContent = '共 ' + b.essays.length + ' 篇 · 已批改 ' + done + ' · 已复核 ' + rev;
  if (bad) {
    btn.style.display = 'inline-block';
    btn.textContent = '重批未成功的 ' + bad + ' 篇';
  } else {
    btn.style.display = 'none';
  }
  // 范文按钮显示还差多少篇
  const mk = document.getElementById('btnMakeEssays');
  const valid = b.essays.filter(hasResult);
  const miss = valid.filter(noEssay).length;
  if (valid.length && miss) {
    mk.style.display = 'inline-block';
    mk.textContent = '生成范文（还差 ' + miss + ' 篇）';
  } else if (valid.length) {
    mk.style.display = 'inline-block';
    mk.textContent = '范文已齐 ' + valid.length + ' 篇';
  } else {
    mk.style.display = 'none';
  }

  box.innerHTML = b.essays.map(essayCard).join('');
}

/* ==================================================================
   学生范文生成 & 学生报告导出
   ================================================================== */
function noEssay(e) {
  return !(e.modelEssayRes && e.modelEssayRes.text);
}
function essayCounts(b) {
  const valid = b.essays.filter(hasResult);
  return { valid: valid.length, missing: valid.filter(noEssay).length, need: valid.filter(noEssay) };
}

document.getElementById('btnMakeEssays').addEventListener('click', async function () {
  const b = S.current;
  if (!b) { alert('请先选择批次'); return; }
  if (!S.settings.hasKey) { alert('请先到「设置」配置 AI 接口'); return; }
  const c = essayCounts(b);
  if (!c.valid) { alert('这个批次还没有批改结果，先把作文批改完再生成范文。'); return; }
  if (!c.missing) { alert('已批改的 ' + c.valid + ' 篇都已经有范文了。'); return; }
  if (!confirm('将为 ' + c.missing + ' 篇作文生成「适配学生水平」的范文。\n\n' +
    '每篇约需十几秒，按输出字数计费。生成后可在每篇详情里查看和修改，也可直接导出学生报告。\n\n是否继续？')) return;

  const list = c.need.slice();
  const pw = document.getElementById('progWrap'), pt = document.getElementById('progTxt');
  pw.style.display = 'block'; pt.style.display = 'flex';
  this.disabled = true;

  let okN = 0, badN = 0;
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const pct = Math.round((i / list.length) * 100);
    document.getElementById('progBar').style.width = pct + '%';
    pt.innerHTML = '<span>正在为第 ' + item.no + ' 号写范文（' + (i + 1) + ' / ' + list.length + '）</span><span>' + pct + '%</span>';
    const res = await api('/api/essay/model', { batchId: b.id, essayId: item.id });
    if (res.ok && res.essay) {
      const idx = S.current.essays.findIndex((x) => x.id === item.id);
      if (idx > -1) S.current.essays[idx] = res.essay;
      okN++;
    } else {
      badN++;
    }
    renderEssays();
  }

  document.getElementById('progBar').style.width = '100%';
  pt.innerHTML = '<span>范文生成完成：成功 ' + okN + ' 篇' + (badN ? '，失败 ' + badN + ' 篇' : '') + '</span><span>100%</span>';
  this.disabled = false;
  await refreshCurrent();
  renderWorkbench();
  if (badN) alert(badN + ' 篇范文生成失败，可再点一次重试。');
  setTimeout(function () { pw.style.display = 'none'; pt.style.display = 'none'; }, 5000);
});

async function exportStudentReport(batchId) {
  const id = batchId || (S.current && S.current.id) || S.recordBatch;
  if (!id) { alert('请先选择一个批次'); return; }
  const r = await api('/api/batch/get', { id: id });
  if (!r.ok) { alert('读取批次失败：' + r.error); return; }
  const c = essayCounts(r.batch);
  if (!c.valid) { alert('这个批次还没有批改结果，无法导出学生报告。'); return; }
  const named = r.batch.essays.filter((e) => (e.identity || {}).name).length;
  const noname = r.batch.essays.length - named;
  let msg = '将导出 ' + c.valid + ' 名学生的报告，每人一页，可直接打印。\n\n';
  msg += '姓名：' + named + ' 篇有姓名（会自动印上），' + noname + ' 篇没有（留空供手写）。\n';
  if (c.missing) {
    msg += '\n注意：其中 ' + c.missing + ' 篇还没有范文，这些页会缺少范文部分，建议先点「生成范文」。\n';
  }
  msg += '\n报告含学生姓名（如有），请勿转发到外部平台。继续导出？';
  if (!confirm(msg)) return;
  window.location.href = '/api/report.docx?id=' + encodeURIComponent(id);
}

document.getElementById('btnReport').addEventListener('click', function () {
  exportStudentReport(S.current && S.current.id);
});
document.getElementById('btnReport2').addEventListener('click', function () {
  exportStudentReport(S.recordBatch || (S.current && S.current.id));
});

/* 批量重批所有未成功的作文 */
document.getElementById('btnRegrade').addEventListener('click', async function () {
  const b = S.current;
  if (!b) return;
  const list = b.essays.filter(needsRegrade);
  if (!list.length) { alert('没有需要重批的作文。'); return; }
  if (!S.settings.hasKey) { alert('请先到「设置」配置 AI 接口'); return; }
  if (!confirm('将重新批改 ' + list.length + ' 篇未成功的作文。\n过程中请勿关闭页面。是否继续？')) return;

  const pw = document.getElementById('progWrap'), pt = document.getElementById('progTxt');
  pw.style.display = 'block'; pt.style.display = 'flex';
  this.disabled = true;

  let okN = 0, badN = 0;
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    document.getElementById('progBar').style.width = Math.round((i / list.length) * 100) + '%';
    pt.innerHTML = '<span>正在重批第 ' + (i + 1) + ' / ' + list.length + ' 篇</span><span>' +
      Math.round((i / list.length) * 100) + '%</span>';

    await api('/api/essay/reset', { batchId: b.id, essayId: item.id });
    const idx = S.current.essays.findIndex((x) => x.id === item.id);
    if (idx > -1) S.current.essays[idx].status = 'grading';
    S.open.add(item.id);
    renderEssays();

    const res = await api('/api/grade', { batchId: b.id, essayId: item.id });
    if (res.essay) {
      const i2 = S.current.essays.findIndex((x) => x.id === item.id);
      if (i2 > -1) S.current.essays[i2] = res.essay;
    }
    if (res.ok) okN++; else badN++;
    renderEssays();
  }

  document.getElementById('progBar').style.width = '100%';
  pt.innerHTML = '<span>重批完成：成功 ' + okN + ' 篇' + (badN ? '，仍未成功 ' + badN + ' 篇' : '') + '</span><span>100%</span>';
  this.disabled = false;
  await refreshCurrent();
  renderWorkbench();
  await refreshSummaries();
  setTimeout(function () { pw.style.display = 'none'; pt.style.display = 'none'; }, 5000);
});

function essayCard(e) {
  const r = eff(e);
  const isOpen = S.open.has(e.id);
  const isEdit = S.editing === e.id;
  const sc = (r && r.score !== undefined && !isEmptyResult(r)) ? r.score : null;

  let head = '<div class="head" data-act="toggle" data-id="' + e.id + '">' +
    '<div class="no">' + e.no + '</div>' +
    '<img class="thumb" src="/uploads/' + esc(e.file) + '" data-act="img" data-id="' + e.id + '" alt="">' +
    '<div class="meta"><div class="t1">' + e.no + ' 号作文　' + statusBadge(e) +
    (sc !== null && r && r.tier ? '<span class="badge ' + tierClass(sc) + '">' + esc(r.tier) + '</span>' : '') +
    '</div><div class="t2">' + fmtDate(e.createdAt) +
    (r && r.wordCount ? '　·　识别词数 ' + r.wordCount : '') +
    (r && r.deductions && r.deductions.length ? '　·　扣分 ' + r.deductions.length + ' 项' : '') +
    '</div></div>' +
    '<div class="sc">' + (sc !== null ? '<b>' + sc + '<i>/25</i></b>' : '<b style="color:#94A3B8">—</b>') + '</div>' +
    '</div>';

  if (!isOpen) return '<div class="essay">' + head + '</div>';

  let body = '<div class="body">';

  if (e.status === 'error') {
    body += '<div class="err"><b>批改失败：</b>' + esc(e.aiError || '未知错误') +
      '<div style="margin-top:6px">点下方「重新批改」可再试一次。</div></div>';
    if (e.aiRaw) body += '<div class="blk"><h5>模型返回原文</h5><div class="ta mono">' + esc(e.aiRaw) + '</div></div>';
  } else if (e.status === 'pending') {
    body += '<div class="note">这篇还没有批改。点下方「立即批改」开始。</div>';
  } else if (e.status === 'grading') {
    body += '<div class="note">正在批改中，请稍候…</div>';
  } else if (isEmptyResult(e.ai)) {
    body += '<div class="err"><b>这篇的批改结果是空的，不能当成绩用。</b>' +
      '<div style="margin-top:6px">模型这次没有返回任何识别文本或评语（属于偶发故障），不是学生真的得 0 分。' +
      '点下方「重新批改」即可，或点上方「重批未成功的作文」一次性补完。</div></div>';
  }

  // 卷面学生信息与作文标识（仅教师内部核对用）
  body += identityBlock(e);

  if (r) {
    if (isEdit) {
      body += reviewForm(e, r);
    } else {      const d = r.dimensions || {};
      body += '<div class="dims">' +
        dimBox('内容', d.content, 10) + dimBox('语言', d.language, 10) +
        dimBox('结构', d.structure, 3) + dimBox('书写', d.handwriting, 2) +
        '</div>';
      if (r.pointsDetail && r.pointsDetail.length) {
        const miss = r.pointsDetail.filter((p) => !p.covered).length;
        body += '<div class="blk points ' + (miss ? 'warn' : '') + '"><h5>要点核对　' +
          (r.pointsDetail.length - miss) + ' / ' + r.pointsDetail.length + ' 已覆盖' +
          (miss ? '　缺 ' + miss + ' 个 → 已降档' : '　全部覆盖') + '</h5><ul>' +
          r.pointsDetail.map(function (p) {
            return '<li><span class="mk ' + (p.covered ? 'y' : 'n') + '">' + (p.covered ? '✓' : '✗') + '</span>' +
              '<span>' + esc(p.point) + (p.note ? '　<span class="nt">' + esc(p.note) + '</span>' : '') + '</span></li>';
          }).join('') + '</ul></div>';
      }
      if (r.deductions && r.deductions.length) {
        body += '<div class="blk warn"><h5>硬性扣分</h5><ul>' +
          r.deductions.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul></div>';
      }
      if (r.problems && r.problems.length) {
        body += '<div class="blk warn"><h5>核心问题</h5><ul>' +
          r.problems.map((x, i) => '<li>' + esc(x) + '</li>').join('') + '</ul></div>';
      }
      if (r.suggestions && r.suggestions.length) {
        body += '<div class="blk"><h5>改进建议</h5><ul>' +
          r.suggestions.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul></div>';
      }
      if (r.comment) body += '<div class="blk"><h5>综合评语</h5><div class="ta">' + esc(r.comment) + '</div></div>';

      const me = e.modelEssayRes || (r.modelEssay ? { text: r.modelEssay, notes: [], keyPhrases: [] } : null);
      if (me && me.text) {
        body += '<div class="blk"><h5>适配水平优化范文</h5><div class="ta">' + esc(me.text) + '</div>';
        if (me.notes && me.notes.length) {
          body += '<div style="margin-top:9px;font-size:12.5px;color:var(--ink2)"><b>为什么这样改：</b><ul style="margin:4px 0 0;padding-left:17px">' +
            me.notes.map((n) => '<li>' + esc(n) + '</li>').join('') + '</ul></div>';
        }
        if (me.keyPhrases && me.keyPhrases.length) {
          body += '<div style="margin-top:9px;font-size:12.5px;color:var(--blue)"><b>背下来能加分的好词好句：</b><ul style="margin:4px 0 0;padding-left:17px">' +
            me.keyPhrases.map((k) => '<li>' + esc(k) + '</li>').join('') + '</ul></div>';
        }
        body += '</div>';
      }

      if (r.transcription) body += '<div class="blk"><h5>识别原文</h5><div class="ta mono">' + esc(r.transcription) + '</div></div>';
    }
  }

  body += '<div class="btn-row" style="margin-top:16px">';
  if (isEdit) {
    body += '<button class="btn" data-act="save" data-id="' + e.id + '">保存复核结果</button>';
    body += '<button class="btn ghost" data-act="cancel" data-id="' + e.id + '">取消</button>';
    body += '<button class="btn ghost" data-act="restore" data-id="' + e.id + '">撤回为 AI 原评</button>';
  } else {
    if (e.status === 'done') body += '<button class="btn" data-act="review" data-id="' + e.id + '">教师复核 / 修改</button>';
    body += '<button class="btn ' + (e.status === 'done' ? 'ghost' : 'orange') + '" data-act="one" data-id="' + e.id + '">' +
      (e.status === 'done' ? '重新批改' : '立即批改') + '</button>';
    body += '<button class="btn ghost" data-act="del" data-id="' + e.id + '">删除</button>';
  }
  body += '</div></div>';

  return '<div class="essay open">' + head + body + '</div>';
}

function dimBox(name, v, max) {
  return '<div class="dim"><div class="t">' + name + '</div><div class="v">' +
    (v === undefined || v === null ? '—' : v) + '<i> / ' + max + '</i></div></div>';
}

/* 卷面学生信息 + 作文标识。识别不到就留空交给老师补，不猜。 */
function identityBlock(e) {
  const idt = e.identity || {};
  const idf = e.identifier || {};
  const src = idt.source === 'manual' ? '<b>教师填写</b>' : (idt.source === 'ai' ? '卷面识别' : '卷面未写姓名');
  let h = '<div class="blk"><h5>学生信息与作文标识　<span class="nt" style="font-weight:400">（仅内部登分核对，不进学生报告）</span></h5>';
  h += '<div class="row">' +
    '<div><label class="lb">姓名</label><input type="text" id="idn-' + e.id + '" value="' + esc(idt.name || '') + '" placeholder="卷面未写，可手填"></div>' +
    '<div><label class="lb">班级</label><input type="text" id="idc-' + e.id + '" value="' + esc(idt.className || '') + '" placeholder="—"></div>' +
    '<div><label class="lb">考号 / 学号</label><input type="text" id="ids-' + e.id + '" value="' + esc(idt.seatNo || '') + '" placeholder="—"></div>' +
    '<div style="flex:0 0 auto;min-width:0;display:flex;align-items:flex-end"><button class="btn sm ghost" data-act="saveid" data-id="' + e.id + '">保存</button></div>' +
    '</div>';
  h += '<div class="hint">当前来源：' + src + '　·　这些信息只存本机，导出学生报告时不带姓名</div>';
  if (idf.title || idf.firstSentence) {
    h += '<div style="margin-top:10px;padding:10px 12px;background:#F8FAFD;border:1px solid var(--line);border-radius:10px;font-size:13px">' +
      (idf.title ? '<div><b>自写标题：</b>' + esc(idf.title) + '</div>' : '<div><b>自写标题：</b>未写标题</div>') +
      (idf.firstSentence ? '<div style="margin-top:3px"><b>正文首句：</b>' + esc(idf.firstSentence) + '</div>' : '') +
      '</div>';
  }
  h += '</div>';
  return h;
}

function reviewForm(e, r) {
  const d = r.dimensions || {};
  const tiers = ['一档（优秀）', '二档（良好）', '三档（合格）', '四档（较差）', '五档（极差）'];
  return '<div class="tip">正在复核 <b>' + e.no + ' 号</b>。改完点「保存复核结果」，这份成绩就以此为准（导出也用它）。</div>' +
    '<div class="row" style="margin-top:14px">' +
    '<div><label class="lb">最终得分 / 25</label><input type="number" id="rv-score-' + e.id + '" min="0" max="25" step="1" value="' + (r.score || 0) + '"></div>' +
    '<div><label class="lb">档次</label><select id="rv-tier-' + e.id + '">' +
    tiers.map((t) => '<option' + (t === r.tier ? ' selected' : '') + '>' + t + '</option>').join('') + '</select></div>' +
    '</div>' +
    '<div class="row" style="margin-top:12px">' +
    '<div><label class="lb">内容 /10</label><input type="number" id="rv-c-' + e.id + '" min="0" max="10" step="0.5" value="' + (d.content || 0) + '"></div>' +
    '<div><label class="lb">语言 /10</label><input type="number" id="rv-l-' + e.id + '" min="0" max="10" step="0.5" value="' + (d.language || 0) + '"></div>' +
    '<div><label class="lb">结构 /3</label><input type="number" id="rv-s-' + e.id + '" min="0" max="3" step="1" value="' + (d.structure || 0) + '"></div>' +
    '<div><label class="lb">书写 /2</label><input type="number" id="rv-h-' + e.id + '" min="0" max="2" step="0.5" value="' + (d.handwriting || 0) + '"></div>' +
    '</div>' +
    '<div class="field" style="margin-top:12px"><label class="lb">硬性扣分 <small>每行一条</small></label>' +
    '<textarea id="rv-ded-' + e.id + '">' + esc((r.deductions || []).join('\n')) + '</textarea></div>' +
    '<div class="field"><label class="lb">核心问题 <small>每行一条</small></label>' +
    '<textarea id="rv-p-' + e.id + '">' + esc((r.problems || []).join('\n')) + '</textarea></div>' +
    '<div class="field"><label class="lb">改进建议 <small>每行一条</small></label>' +
    '<textarea id="rv-sg-' + e.id + '">' + esc((r.suggestions || []).join('\n')) + '</textarea></div>' +
    '<div class="field"><label class="lb">综合评语</label>' +
    '<textarea id="rv-cm-' + e.id + '">' + esc(r.comment || '') + '</textarea></div>' +
    '<div class="field"><label class="lb">适配水平优化范文 <small>可编辑，留空则不输出</small></label>' +
    '<textarea id="rv-me-' + e.id + '">' + esc(r.modelEssay || '') + '</textarea></div>';
}

const splitLines = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean);

/* ---------- 结果区交互 ---------- */
document.getElementById('essayList').addEventListener('click', async function (ev) {
  const t = ev.target.closest('[data-act]');
  if (!t) return;
  const act = t.dataset.act;
  const id = t.dataset.id;
  const b = S.current;
  if (!b || !id) return;
  const e = b.essays.find((x) => x.id === id);
  if (!e) return;

  if (act === 'img') { openImg(e); return; }
  if (act === 'toggle') {
    if (S.open.has(id)) S.open.delete(id); else S.open.add(id);
    renderEssays();
    return;
  }
  if (act === 'review') { S.editing = id; S.open.add(id); renderEssays(); return; }
  if (act === 'cancel') { S.editing = null; renderEssays(); return; }

  if (act === 'restore') {
    if (!confirm('撤回后这篇恢复为 AI 初评结果，你刚才的修改会丢失。确定吗？')) return;
    await api('/api/review', { batchId: b.id, essayId: id, review: null });
    S.editing = null;
    await refreshCurrent();
    renderEssays();
    return;
  }

  if (act === 'save') {
    const g = (p) => document.getElementById(p + '-' + id);
    if (!g('rv-score')) return;
    const review = {
      score: Number(g('rv-score').value) || 0,
      tier: g('rv-tier').value,
      dimensions: {
        content: Number(g('rv-c').value) || 0,
        language: Number(g('rv-l').value) || 0,
        structure: Number(g('rv-s').value) || 0,
        handwriting: Number(g('rv-h').value) || 0
      },
      wordCount: (e.ai && e.ai.wordCount) || 0,
      deductions: splitLines(g('rv-ded').value),
      problems: splitLines(g('rv-p').value),
      suggestions: splitLines(g('rv-sg').value),
      comment: g('rv-cm').value.trim(),
      modelEssay: g('rv-me') ? g('rv-me').value.trim() : ((e.ai && e.ai.modelEssay) || ''),
      pointsDetail: (e.ai && e.ai.pointsDetail) || [],
      transcription: (e.ai && e.ai.transcription) || '',
      confirmed: true,
      reviewedAt: new Date().toISOString()
    };
    const res = await api('/api/review', { batchId: b.id, essayId: id, review: review });
    if (!res.ok) { alert('保存失败：' + res.error); return; }
    S.editing = null;
    await refreshCurrent();
    renderWorkbench();
    await refreshSummaries();
    return;
  }

  if (act === 'one') {
    if (!S.settings.hasKey) { alert('请先到「设置」配置 AI 接口'); return; }
    if (e.status === 'error') await api('/api/essay/reset', { batchId: b.id, essayId: id });
    const idx = b.essays.findIndex((x) => x.id === id);
    b.essays[idx].status = 'grading';
    renderEssays();
    const res = await api('/api/grade', { batchId: b.id, essayId: id });
    if (res.essay) {
      const i2 = S.current.essays.findIndex((x) => x.id === id);
      if (i2 > -1) S.current.essays[i2] = res.essay;
    }
    if (!res.ok) alert('批改失败：' + (res.error || ''));
    renderEssays();
    await refreshSummaries();
    return;
  }

  if (act === 'saveid') {
    const gv = (p) => { const el = document.getElementById(p + '-' + id); return el ? el.value.trim() : ''; };
    const res = await api('/api/identity', {
      batchId: b.id,
      essayId: id,
      identity: { name: gv('idn'), className: gv('idc'), seatNo: gv('ids') }
    });
    if (!res.ok) { alert('保存失败：' + res.error); return; }
    const i3 = S.current.essays.findIndex((x) => x.id === id);
    if (i3 > -1) S.current.essays[i3] = res.essay;
    renderEssays();
    renderRecords();
    return;
  }

  if (act === 'del') {
    if (!confirm('删除 ' + e.no + ' 号作文及其照片？此操作不可恢复。')) return;
    const r = await api('/api/essay/delete', { batchId: b.id, essayId: id });
    warnCleanup(r);
    S.current.essays = S.current.essays.filter((x) => x.id !== id);
    renderWorkbench();
    await refreshSummaries();
    return;
  }
});

/* ---------- 图片预览 ---------- */
function openImg(e) {
  document.getElementById('modalImg').src = '/uploads/' + e.file;
  document.getElementById('modalCap').textContent = e.no + ' 号作文原图';
  document.getElementById('modal').classList.add('on');
}
document.getElementById('modalClose').addEventListener('click', function () {
  document.getElementById('modal').classList.remove('on');
});
document.getElementById('modal').addEventListener('click', function (ev) {
  if (ev.target === this) this.classList.remove('on');
});

/* ==================================================================
   记录与统计
   ================================================================== */
function renderBatchList() {
  const box = document.getElementById('batchList');
  if (!S.batches.length) {
    box.innerHTML = '<div class="empty"><div class="ic">📚</div>还没有历史批次</div>';
    return;
  }
  box.innerHTML = S.batches.map(function (b) {
    return '<div class="batchrow' + (S.recordBatch === b.id ? ' on' : '') + '" data-bid="' + b.id + '">' +
      '<div class="info"><b>' + esc(b.title) + '</b>' +
      '<span>' + fmtDate(b.createdAt) + (b.className ? '　·　' + esc(b.className) : '') + '</span></div>' +
      '<span class="pill">已批改 ' + b.done + ' / ' + b.count + '</span>' +
      '</div>';
  }).join('');
}

document.getElementById('batchList').addEventListener('click', function (ev) {
  const row = ev.target.closest('[data-bid]');
  if (!row) return;
  S.recordBatch = row.dataset.bid;
  renderBatchList();
  renderRecords();
});

async function renderRecords() {
  const id = S.recordBatch || (S.current ? S.current.id : (S.batches[0] && S.batches[0].id));
  if (!id) {
    document.getElementById('statCard').style.display = 'none';
    document.getElementById('tableCard').style.display = 'none';
    return;
  }
  const r = await api('/api/batch/get', { id: id });
  if (!r.ok) return;
  const b = r.batch;
  S.recordBatch = id;
  S.recordData = b;

  const scored = b.essays.map((e) => ({ e: e, r: eff(e) }))
    .filter((x) => x.r && x.r.score !== undefined && !isEmptyResult(x.r));
  const nums = scored.map((x) => Number(x.r.score));
  const avg = nums.length ? (nums.reduce((a, c) => a + c, 0) / nums.length) : 0;
  const max = nums.length ? Math.max.apply(null, nums) : 0;
  const min = nums.length ? Math.min.apply(null, nums) : 0;
  const rev = b.essays.filter((e) => e.reviewed).length;

  document.getElementById('statCard').style.display = 'block';
  document.getElementById('statSub').textContent = b.title + (b.className ? ' · ' + b.className : '');
  document.getElementById('stats').innerHTML =
    statBox('已批改', scored.length, '/ ' + b.essays.length + ' 篇') +
    statBox('班级平均', nums.length ? avg.toFixed(1) : '—', '/ 25') +
    statBox('最高分', nums.length ? max : '—', '/ 25') +
    statBox('教师已复核', rev, '/ ' + b.essays.length + ' 篇');

  const buckets = [0, 0, 0, 0, 0];
  nums.forEach(function (n) {
    if (n >= 21) buckets[0]++; else if (n >= 16) buckets[1]++;
    else if (n >= 11) buckets[2]++; else if (n >= 6) buckets[3]++; else buckets[4]++;
  });
  const names = ['一档 优秀', '二档 良好', '三档 合格', '四档 较差', '五档 极差'];
  const colors = ['#059669', '#2563EB', '#D97706', '#EA580C', '#DC2626'];
  const totalN = nums.length || 1;
  document.getElementById('dist').innerHTML = '<div style="font-size:13px;font-weight:700;margin:6px 0 10px">档次分布</div>' +
    names.map(function (n, i) {
      const pct = Math.round((buckets[i] / totalN) * 100);
      return '<div class="r"><span class="nm">' + n + '</span><span class="bar"><i style="width:' + pct + '%;background:' + colors[i] + '"></i></span>' +
        '<span class="ct">' + buckets[i] + ' 人</span></div>';
    }).join('');

  document.getElementById('tableCard').style.display = 'block';
  const head = ['编号', '得分', '档次', '内容', '语言', '结构', '书写', '词数', '状态', '核心问题'];
  let html = '<thead><tr>' + head.map((h) => '<th>' + h + '</th>').join('') + '</tr></thead><tbody>';
  b.essays.forEach(function (e) {
    const r2 = eff(e);
    const empty = isEmptyResult(r2);
    const d = (r2 && r2.dimensions) || {};
    const sc = (r2 && r2.score !== undefined && !empty) ? r2.score : null;
    html += '<tr><td><b>' + e.no + ' 号</b></td>' +
      '<td><b>' + (sc !== null ? sc : '—') + '</b></td>' +
      '<td>' + (sc !== null && r2.tier ? '<span class="badge ' + tierClass(sc) + '">' + esc(r2.tier) + '</span>' : '—') + '</td>' +
      '<td>' + (!empty && d.content !== undefined ? d.content : '—') + '</td>' +
      '<td>' + (!empty && d.language !== undefined ? d.language : '—') + '</td>' +
      '<td>' + (!empty && d.structure !== undefined ? d.structure : '—') + '</td>' +
      '<td>' + (!empty && d.handwriting !== undefined ? d.handwriting : '—') + '</td>' +
      '<td>' + (!empty && r2 && r2.wordCount ? r2.wordCount : '—') + '</td>' +
      '<td>' + (e.reviewed ? '<span class="badge bg-rev">已复核</span>'
        : (empty ? '<span class="badge bg-err">空结果</span>'
          : (e.status === 'done' ? '<span class="badge bg-done">AI 初评</span>'
            : (e.status === 'error' ? '<span class="badge bg-err">失败</span>' : '<span class="badge bg-pend">未批改</span>')))) + '</td>' +
      '<td class="wrapcell">' + esc((!empty && r2 && r2.problems ? r2.problems.join('；') : '') || '—') + '</td></tr>';
  });
  html += '</tbody>';
  document.getElementById('scoreTable').innerHTML = html;
  backfillIdentifiers(id).then(function (n) {
    if (n) {
      api('/api/batch/get', { id: id }).then(function (r2) {
        if (r2.ok) { S.recordData = r2.batch; renderRoster(r2.batch); }
      });
    }
  });
  renderRoster(b);
}

/* 旧数据没有作文标识时，本地从识别原文补出标题与首句（不调 AI，零成本），每批次只跑一次 */
const backfilled = new Set();
async function backfillIdentifiers(batchId) {
  if (backfilled.has(batchId)) return 0;
  backfilled.add(batchId);
  try {
    const r = await api('/api/backfill', { batchId: batchId });
    return r.ok ? (r.filled || 0) : 0;
  } catch (e) { return 0; }
}

/* 登分表：编号 + 姓名/考号 + 标题 + 首句 + 得分。姓名等可直接在表里输入。 */
function renderRoster(b) {
  const card = document.getElementById('rosterCard');
  if (!b.essays.length) { card.style.display = 'none'; return; }
  card.style.display = 'block';

  const head = ['编号', '姓名', '班级', '考号', '作文标题', '正文首句', '得分', '档次', '状态'];
  let html = '<thead><tr>' + head.map((h) => '<th>' + h + '</th>').join('') + '</tr></thead><tbody>';
  b.essays.forEach(function (e) {
    const r = hasResult(e) ? eff(e) : null;
    const idt = e.identity || {};
    const idf = e.identifier || {};
    const src = idt.source === 'manual' ? '教师填写' : (idt.source === 'ai' ? '卷面识别' : '');
    const box = (f, val, ph, w) => '<input type="text" class="rin' + (val ? ' filled' : '') +
      '" data-rf="' + f + '" data-re="' + e.id + '" value="' + esc(val || '') +
      '" placeholder="' + ph + '"' + (w ? ' style="min-width:' + w + '"' : '') + '>';

    html += '<tr data-row="' + e.id + '"><td><b>' + e.no + ' 号</b></td>' +
      '<td>' + box('name', idt.name, '点这里填') +
        '<span class="saved" data-sv="' + e.id + '">已存</span>' +
        (src ? '<div style="font-size:11px;color:var(--ink3);padding-left:7px">' + src + '</div>' : '') + '</td>' +
      '<td>' + box('className', idt.className, b.className || '—', '90px') + '</td>' +
      '<td>' + box('seatNo', idt.seatNo, '—', '80px') + '</td>' +
      '<td class="wrapcell">' + esc(idf.title || '未写标题') + '</td>' +
      '<td class="wrapcell" style="color:var(--ink2)">' + esc((idf.firstSentence || '—').slice(0, 60)) + '</td>' +
      '<td><b>' + (r && r.score !== undefined ? r.score : '—') + '</b></td>' +
      '<td>' + (r && r.tier ? '<span class="badge ' + tierClass(r.score) + '">' + esc(r.tier) + '</span>' : '—') + '</td>' +
      '<td>' + (e.reviewed ? '<span class="badge bg-rev">已复核</span>'
        : (r ? '<span class="badge bg-done">AI 初评</span>' : '<span class="badge bg-pend">未批改</span>')) + '</td></tr>';
  });
  html += '</tbody>';
  document.getElementById('rosterTable').innerHTML = html;
}

/* 保存登分表某一行（三个字段一起提交，因为接口是整体覆盖） */
async function saveRosterRow(essayId) {
  const row = document.querySelector('#rosterTable tr[data-row="' + essayId + '"]');
  if (!row) return;
  const val = (f) => { const el = row.querySelector('[data-rf="' + f + '"]'); return el ? el.value.trim() : ''; };
  const identity = { name: val('name'), className: val('className'), seatNo: val('seatNo') };
  const batchId = S.recordBatch || (S.current && S.current.id);
  if (!batchId) return;
  const res = await api('/api/identity', { batchId: batchId, essayId: essayId, identity: identity });
  if (!res.ok) { alert('保存失败：' + res.error); return; }

  // 本地同步，避免重新渲染导致输入框失焦
  const apply = (batch) => {
    if (!batch) return;
    const i = batch.essays.findIndex((x) => x.id === essayId);
    if (i > -1) batch.essays[i] = res.essay;
  };
  apply(S.recordData);
  apply(S.current);

  row.querySelectorAll('.rin').forEach(function (el) {
    if (el.value.trim()) el.classList.add('filled'); else el.classList.remove('filled');
  });
  const tag = row.querySelector('[data-sv]');
  if (tag) { tag.classList.add('on'); setTimeout(function () { tag.classList.remove('on'); }, 1500); }
}

/* 姓名栏回车 → 跳到下一行的姓名栏，方便连续录入 */
document.getElementById('rosterTable').addEventListener('keydown', function (ev) {
  const el = ev.target;
  if (!el.classList || !el.classList.contains('rin')) return;
  if (ev.key === 'Enter') {
    ev.preventDefault();
    el.blur();
    const rows = Array.prototype.slice.call(document.querySelectorAll('#rosterTable tbody tr'));
    const idx = rows.indexOf(el.closest('tr'));
    const next = rows[idx + 1];
    if (next) {
      const n = next.querySelector('[data-rf="name"]');
      if (n) n.focus();
    }
  } else if (ev.key === 'Escape') {
    el.blur();
  }
});

document.getElementById('rosterTable').addEventListener('focusout', function (ev) {
  const el = ev.target;
  if (!el.classList || !el.classList.contains('rin')) return;
  const row = el.closest('tr');
  const id = row && row.getAttribute('data-row');
  if (!id) return;
  // 与已存值比较，没变就不发请求
  const same = Array.prototype.every.call(row.querySelectorAll('.rin'), function (x) {
    const cur = (S.recordData ? (S.recordData.essays.find((e) => e.id === id) || {}).identity || {} : {})[x.getAttribute('data-rf')] || '';
    return x.value.trim() === String(cur).trim();
  });
  if (same) return;
  saveRosterRow(id);
});

function rosterTsv(b) {
  const rows = [['编号', '姓名', '班级', '考号', '作文标题', '正文首句', '得分', '档次'].join('\t')];
  b.essays.forEach(function (e) {
    const r = hasResult(e) ? eff(e) : null;
    const idt = e.identity || {};
    const idf = e.identifier || {};
    rows.push([
      e.no + ' 号', idt.name || '', idt.className || b.className || '', idt.seatNo || '',
      idf.title || '', idf.firstSentence || '',
      r && r.score !== undefined ? r.score : '', r && r.tier ? r.tier : ''
    ].join('\t'));
  });
  return rows.join('\n');
}

document.getElementById('btnRoster').addEventListener('click', function () {
  const id = S.recordBatch || (S.current && S.current.id);
  if (!id) { alert('请先选择一个批次'); return; }
  if (!confirm('这份表包含学生姓名，仅供你内部登分使用。\n文件已标注「仅内部使用」，请勿转发或上传。\n\n继续导出？')) return;
  window.location.href = '/api/roster.csv?id=' + encodeURIComponent(id);
});

document.getElementById('btnCopyRoster').addEventListener('click', async function () {
  const id = S.recordBatch || (S.current && S.current.id);
  if (!id) { alert('请先选择一个批次'); return; }
  const r = await api('/api/batch/get', { id: id });
  if (!r.ok) { alert('读取失败：' + r.error); return; }
  const txt = rosterTsv(r.batch);
  const btn = this, old = btn.textContent;
  const done = function () { btn.textContent = '已复制 ✓'; setTimeout(function () { btn.textContent = old; }, 1600); };
  const fallback = function () {
    const ta = document.createElement('textarea');
    ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { btn.textContent = '请手动复制'; }
    document.body.removeChild(ta);
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(txt).then(done, fallback);
  } else { fallback(); }
});

function statBox(t, v, suf) {
  return '<div class="stat"><div class="t">' + t + '</div><div class="v">' + v + '<i> ' + suf + '</i></div></div>';
}

document.getElementById('btnExport').addEventListener('click', function () {
  const id = S.recordBatch || (S.current && S.current.id);
  if (!id) { alert('先选一个批次'); return; }
  window.location.href = '/api/export?id=' + encodeURIComponent(id);
});

/* ==================================================================
   学生档案：跨批次查看各班各生的多次作文成绩
   ================================================================== */
async function renderArchive() {
  const r = await api('/api/archive');
  if (!r.ok) { alert('读取档案失败：' + (r.error || '')); return; }
  S.archive = r;
  if (S.archClass === undefined) S.archClass = '';
  renderClassList();
  renderStudentList();

  const note = document.getElementById('unnamedNote');
  if (r.unlinked) {
    note.style.display = 'block';
    note.textContent = '还有 ' + r.unlinked + ' 篇作文有姓名但没能归档，通常是姓名或班级写法特殊。到「记录与统计」检查一下这些篇目的学生信息即可。';
  } else {
    note.style.display = 'none';
  }
}

function renderClassList() {
  const r = S.archive;
  if (!r) return;
  const all = document.getElementById('classList');
  let html = '<div class="chips">';
  html += '<div class="chip' + (S.archClass === '' ? ' on' : '') + '" data-cls="">' +
    '<b>全部班级</b><span>' + r.students.length + ' 名学生 · ' +
    r.classes.reduce(function (a, c) { return a + c.essays; }, 0) + ' 篇作文</span></div>';
  r.classes.forEach(function (c) {
    html += '<div class="chip' + (S.archClass === c.className ? ' on' : '') + '" data-cls="' + esc(c.className) + '">' +
      '<b>' + esc(c.className) + '</b>' +
      '<span>' + c.students + ' 名学生 · ' + c.essays + ' 篇</span>' +
      '<span>平均 ' + (c.avg === null ? '—' : c.avg + ' 分') +
      (c.unnamed ? '　·　' + c.unnamed + ' 篇未归名' : '') + '</span></div>';
  });
  html += '</div>';
  all.innerHTML = html;
}

function filteredStudents() {
  const r = S.archive;
  if (!r) return [];
  return r.students.filter(function (s) {
    return !S.archClass || s.className === S.archClass;
  });
}

function renderStudentList() {
  const box = document.getElementById('stuList');
  const list = filteredStudents();
  document.getElementById('stuSub').textContent = list.length + ' 名学生' +
    (S.archClass ? ' · ' + S.archClass : '');

  if (!list.length) {
    box.innerHTML = '<div class="empty"><div class="ic">👤</div>还没有归档的学生<br>批改时若识别到卷面姓名，或你在登分表里填了姓名，这里就会自动建立档案</div>';
    return;
  }

  let html = '<div class="tbl-wrap"><table>' +
    '<thead><tr><th>姓名</th><th>班级</th><th>学号</th><th>作文次数</th><th>平均分</th><th>最高</th><th>最低</th><th>最近一次</th><th>较上次</th></tr></thead><tbody>';
  list.forEach(function (s) {
    let d = '<span class="delta flat">—</span>';
    if (s.delta !== null && s.delta !== undefined) {
      if (s.delta > 0) d = '<span class="delta up">↑ ' + s.delta + '</span>';
      else if (s.delta < 0) d = '<span class="delta down">↓ ' + Math.abs(s.delta) + '</span>';
      else d = '<span class="delta flat">持平</span>';
    }
    const last = s.last;
    html += '<tr data-stu="' + s.id + '" style="cursor:pointer">' +
      '<td><b>' + esc(s.name) + '</b></td>' +
      '<td>' + esc(s.className || '—') + '</td>' +
      '<td>' + esc(s.seatNo || '—') + '</td>' +
      '<td>' + s.records.length + ' 次</td>' +
      '<td><b>' + (s.avg === null ? '—' : s.avg) + '</b></td>' +
      '<td>' + (s.best === null ? '—' : s.best) + '</td>' +
      '<td>' + (s.worst === null ? '—' : s.worst) + '</td>' +
      '<td class="wrapcell">' + (last
        ? esc((last.batchTitle || '').slice(0, 14)) + '　' + (last.score === null ? '未批改' : last.score + ' 分')
        : '—') + '</td>' +
      '<td>' + d + '</td></tr>';
  });
  html += '</tbody></table></div>';
  box.innerHTML = html;
}

async function renderStudentDetail(id) {
  const box = document.getElementById('stuDetail');
  const r = await api('/api/student', { id: id });
  if (!r.ok) { alert('读取失败：' + r.error); return; }
  const s = r.student;
  const recs = r.records || [];

  let h = '<div class="card-h"><span class="dot">◍</span>' + esc(s.name) +
    '<span class="sub">' + esc(s.className || '未填班级') + (s.seatNo ? ' · 学号 ' + esc(s.seatNo) : '') +
    ' · 共 ' + recs.length + ' 次作文</span></div>';

  // 修改档案
  h += '<div class="row" style="align-items:flex-end">' +
    '<div><label class="lb">姓名</label><input type="text" id="stName" value="' + esc(s.name) + '"></div>' +
    '<div><label class="lb">班级</label><input type="text" id="stClass" value="' + esc(s.className || '') + '"></div>' +
    '<div><label class="lb">学号</label><input type="text" id="stNo" value="' + esc(s.seatNo || '') + '"></div>' +
    '<div style="flex:0 0 auto;min-width:0"><button class="btn sm" id="btnSaveStu" data-sid="' + s.id + '">保存并同步到所有作文</button></div>' +
    '</div>';
  h += '<div class="hint">改名或改班级后，这名学生已有的 ' + recs.length + ' 次记录会一起更新。若改名后与另一位学生重名同班，两人会被合并。</div>';

  // 成绩走势
  const scored = recs.filter(function (x) { return x.score !== null; });
  if (scored.length) {
    h += '<div class="blk" style="margin-top:16px"><h5>成绩走势</h5><div class="bars">';
    scored.forEach(function (x, i) {
      const pct = Math.max(6, Math.round((x.score / 25) * 68));
      const d = new Date(x.date);
      h += '<div class="b" title="' + esc(x.batchTitle) + '：' + x.score + ' 分">' +
        '<span class="val">' + x.score + '</span>' +
        '<div class="bar" style="height:' + pct + '%"></div>' +
        '<span class="lbl">第 ' + (i + 1) + ' 次</span></div>';
    });
    h += '</div>';
    if (r.classAvg !== null) {
      h += '<div class="avgline">该生平均 <b>' +
        (Math.round((scored.reduce(function (a, c) { return a + c.score; }, 0) / scored.length) * 10) / 10) +
        '</b> 分　·　同班其他同学平均 <b>' + r.classAvg + '</b> 分（' + r.classSample + ' 份样本）</div>';
    }
    h += '</div>';
  }

  // 历次明细
  h += '<div class="blk"><h5>历次作文明细</h5><div class="tbl-wrap"><table>' +
    '<thead><tr><th>次序</th><th>日期</th><th>作文题目</th><th>本批编号</th><th>得分</th><th>档次</th><th>状态</th></tr></thead><tbody>';
  recs.forEach(function (x, i) {
    const d = new Date(x.date);
    const p = (n) => String(n).padStart(2, '0');
    h += '<tr><td>第 ' + (i + 1) + ' 次</td>' +
      '<td>' + d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '</td>' +
      '<td class="wrapcell">' + esc(x.batchTitle || '') + '</td>' +
      '<td>' + x.no + ' 号</td>' +
      '<td><b>' + (x.score === null ? '—' : x.score) + '</b></td>' +
      '<td>' + (x.tier ? '<span class="badge ' + tierClass(x.score) + '">' + esc(x.tier) + '</span>' : '—') + '</td>' +
      '<td>' + (x.reviewed ? '<span class="badge bg-rev">已复核</span>' : '<span class="badge bg-done">AI 初评</span>') + '</td></tr>';
  });
  h += '</tbody></table></div></div>';

  box.innerHTML = h;
  box.style.display = 'block';
  if (box.scrollIntoView) box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

document.getElementById('classList').addEventListener('click', function (ev) {
  const c = ev.target.closest('[data-cls]');
  if (!c) return;
  S.archClass = c.dataset.cls;
  document.getElementById('stuDetail').style.display = 'none';
  renderClassList();
  renderStudentList();
});

document.getElementById('stuList').addEventListener('click', function (ev) {
  const tr = ev.target.closest('[data-stu]');
  if (!tr) return;
  renderStudentDetail(tr.dataset.stu);
});

document.getElementById('stuDetail').addEventListener('click', async function (ev) {
  const btn = ev.target.closest('#btnSaveStu');
  if (!btn) return;
  const g = (id) => document.getElementById(id).value.trim();
  if (!g('stName')) { alert('姓名不能为空'); return; }
  btn.disabled = true;
  const r = await api('/api/student/update', {
    id: btn.dataset.sid,
    student: { name: g('stName'), className: g('stClass'), seatNo: g('stNo') }
  });
  btn.disabled = false;
  if (!r.ok) { alert('保存失败：' + r.error); return; }
  await renderArchive();
  renderStudentDetail(btn.dataset.sid);
});

document.getElementById('btnArchiveCsv').addEventListener('click', function () {
  if (!confirm('将导出所有班级学生的跨批次成绩归档表（含姓名，仅内部使用）。\n\n继续导出？')) return;
  window.location.href = '/api/archive.csv';
});

/* ==================================================================
   设置
   ================================================================== */
function renderPresets() {
  const sel = document.getElementById('presetSel');
  sel.innerHTML = '<option value="">— 选择服务商预设（可选）—</option>' +
    S.presets.map((p, i) => '<option value="' + i + '">' + esc(p.name) + '</option>').join('');
}

function presetNote(i) {
  const p = S.presets[i];
  document.getElementById('presetNote').textContent = p ? p.note : '';
  if (p && p.baseUrl) {
    document.getElementById('sBaseUrl').value = p.baseUrl;
    document.getElementById('sModel').value = p.model;
    // 思考模式只对 DeepSeek 生效
    document.getElementById('thinkingField').style.display = /deepseek\.com/i.test(p.baseUrl) ? 'block' : 'none';
    checkModel();
  }
}

document.getElementById('presetSel').addEventListener('change', function () {
  if (this.value !== '') presetNote(Number(this.value));
});

function fillSettings() {
  document.getElementById('sBaseUrl').value = S.settings.baseUrl || '';
  document.getElementById('sModel').value = S.settings.model || '';
  document.getElementById('sTemp').value = S.settings.temperature !== undefined ? S.settings.temperature : 0.2;
  document.getElementById('sMaxTokens').value = S.settings.maxTokens || 8192;
  document.getElementById('sTimeout').value = S.settings.timeout || 300;
  document.getElementById('sThinking').value = S.settings.thinking === 'on' ? 'on' : 'off';
  document.getElementById('thinkingField').style.display = S.settings.isDeepSeek ? 'block' : 'none';
  document.getElementById('sModelEssay').checked = !!S.settings.modelEssay;
  document.getElementById('sForceJson').checked = !!S.settings.forceJson;
  document.getElementById('keyHint').textContent = S.settings.hasKey
    ? '已保存 Key（' + S.settings.keyTail + '）。要更换请直接粘贴新的，不改就留空。'
    : '还没有保存 Key。';
  document.getElementById('sKey').value = '';
  checkModel();
}

/* 模型名检查：纯文本模型传图会被接口拒绝，提前拦住 */
const DS_VISION_OK = ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'];
function checkModel() {
  const el = document.getElementById('sModel');
  const w = document.getElementById('modelWarn');
  const m = (el.value || '').trim().toLowerCase();
  if (!m) { w.textContent = ''; return; }
  const isDS = m.indexOf('deepseek') === 0;
  const looksVision = /(vl|vision|4v|omni|gpt-4o|gemini|claude|glm-4v)/.test(m);
  if (isDS && DS_VISION_OK.indexOf(m) === -1) {
    w.style.color = '#DC2626';
    w.textContent = '⚠ ' + el.value + ' 不支持图片输入。DeepSeek 请填 deepseek-flash（旧名 deepseek-v4-flash 也可用）。';
  } else if (!isDS && !looksVision) {
    w.style.color = '#D97706';
    w.textContent = '提示：请确认这个模型支持图片输入（名称通常含 vl / vision / 4v）。';
  } else {
    w.style.color = '#059669';
    w.textContent = '✓ 这个模型支持图片输入。';
  }
}
document.getElementById('sModel').addEventListener('input', checkModel);

async function saveSettings() {
  const body = {
    baseUrl: document.getElementById('sBaseUrl').value.trim(),
    model: document.getElementById('sModel').value.trim(),
    temperature: Number(document.getElementById('sTemp').value),
    maxTokens: Number(document.getElementById('sMaxTokens').value),
    thinking: document.getElementById('sThinking').value,
    modelEssay: document.getElementById('sModelEssay').checked,
    timeout: Number(document.getElementById('sTimeout').value),
    forceJson: document.getElementById('sForceJson').checked
  };
  const k = document.getElementById('sKey').value.trim();
  if (k) body.apiKey = k;
  const r = await api('/api/settings', body);
  if (r.ok) {
    document.getElementById('saveHint').textContent = '已保存 ✓';
    document.getElementById('sKey').value = '';
    await loadState();
  } else {
    document.getElementById('saveHint').textContent = '保存失败：' + r.error;
  }
  setTimeout(function () { document.getElementById('saveHint').textContent = ''; }, 2500);
}

document.getElementById('btnSaveSettings').addEventListener('click', saveSettings);

document.getElementById('btnClearKey').addEventListener('click', async function () {
  if (!confirm('清除本机保存的 API Key？清除后需要重新粘贴才能批改。')) return;
  const r = await api('/api/settings', { apiKey: '__CLEAR__' });
  if (r.ok) { await loadState(); alert('已清除。'); }
});

document.getElementById('btnTestApi').addEventListener('click', async function () {
  await saveSettings();
  const btn = this, old = btn.textContent;
  btn.disabled = true; btn.textContent = '测试中…';
  const r = await api('/api/test', {});
  btn.disabled = false; btn.textContent = old;
  alert(r.ok ? '连接正常 ✓\n\n模型回复：' + (r.reply || '（空）') : '连接失败：\n\n' + (r.error || '未知错误'));
});

document.getElementById('btnSavePrompt').addEventListener('click', async function () {
  const r = await api('/api/settings', { prompt: document.getElementById('promptBox').value });
  document.getElementById('promptHint').textContent = r.ok ? '已保存 ✓' : '保存失败：' + r.error;
  setTimeout(function () { document.getElementById('promptHint').textContent = ''; }, 2500);
});

document.getElementById('btnResetPrompt').addEventListener('click', async function () {
  if (!confirm('恢复为内置的苏州中考 25 分制标准提示词？你的修改会丢失。')) return;
  const r = await api('/api/settings', { prompt: '__DEFAULT__' });
  if (r.ok) { await loadState(); document.getElementById('promptHint').textContent = '已恢复内置默认 ✓'; }
  setTimeout(function () { document.getElementById('promptHint').textContent = ''; }, 2500);
});

/* ==================================================================
   启动
   ================================================================== */
loadState().catch(function (e) {
  document.getElementById('essayList').innerHTML = '<div class="err">初始化失败：' + esc(e.message) + '</div>';
});
