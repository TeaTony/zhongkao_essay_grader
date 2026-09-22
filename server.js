#!/usr/bin/env node
/**
 * 苏州中考英语作文批改平台 · 本地服务
 * 零外部依赖，仅使用 Node 内置模块。
 * 数据全部保存在本机 ./data 目录，不上传任何第三方平台（调用 AI 时除外）。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { exec } = require('child_process');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const STUDENTS_FILE = path.join(DATA_DIR, 'students.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const PROMPT_FILE = path.join(DATA_DIR, 'prompt.txt');

let PORT = Number(process.env.PORT || 8787);
const HOST = '127.0.0.1';

/* ------------------------------------------------------------------ */
/* 默认配置与提示词                                                     */
/* ------------------------------------------------------------------ */

const VISION_PRESETS = [
  { name: 'DeepSeek（推荐 · 当前使用）', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', note: 'deepseek-flash 即 DeepSeek-V4.1-Flash，原生支持图片输入；deepseek-v4-flash 是仍可用的旧名，同样可用。deepseek-v4-pro 不支持图片。' },
  { name: '通义千问（阿里云百炼）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3-vl-plus', note: '国内直连快，中文手写识别强，适合字迹潦草的卷面' },
  { name: '智谱 GLM-4V', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4v-plus', note: '图片理解稳定，有免费档 glm-4v-flash' },
  { name: 'Kimi（月之暗面）', baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-latest', note: '接口地址如有变动请以官网为准' },
  { name: '豆包（火山方舟）', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seed-1-6-vision', note: '模型名需填方舟控制台的接入点名称' },
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', note: '需自备网络条件' },
  { name: '自定义', baseUrl: '', model: '', note: '任何兼容 OpenAI 格式的服务' }
];

const DEFAULT_SETTINGS = {
  baseUrl: VISION_PRESETS[0].baseUrl,
  apiKey: '',
  model: VISION_PRESETS[0].model,
  temperature: 0.2,
  maxTokens: 8192,
  thinking: 'off',
  modelEssay: false,
  forceJson: true,
  timeout: 300,
  prompt: ''
};

/* baseUrl 是否指向 DeepSeek 官方（只有它支持 thinking / reasoning_effort 扩展参数） */
function isDeepSeek(baseUrl) {
  return /(^|\.)deepseek\.com/i.test(String(baseUrl || ''));
}

const DEFAULT_PROMPT = `你是拥有 15 年苏州高新区初三英语教学及中考阅卷经验的资深阅卷老师，精通 2025 苏州中考英语作文 25 分制评分规则、命题趋势与实战扣分逻辑。现在你把阅卷经验用于批改单篇学生手写作文照片。

【阅卷总则】
先定档、后给分；要点第一、语言第二、结构第三、书写加分。一档从严准入，漏要点重扣、跑题必降档、绝不放水、无人情分。同等漏点、同等偏题、同等水平，打分完全一致。
优先级：要点完整度 ＞ 语言表达 ＞ 结构逻辑 ＞ 卷面书写。

【必须遵守】
1. 只依据图片中真实可见的内容评分，不得编造、不得虚构学生原文。识别不出的字词用【?】标注，并对该篇从严扣分。
2. 写作要点以本条消息中教师给出的「核心要点清单」为准，逐条核对是否覆盖，不得自行增删要点。
3. 先定档、后给分：先按要点完整度与偏题程度确定档次，再在档内按语言、结构、书写微调具体得分。
4. 一档（21–25 分）准入从严：未达「全要点 ＋ 标准三段式 ＋ 语法几乎无误」者，一律不划入一档。
5. 缺 1 个核心要点 → 降一档（约扣 4–5 分）；缺 2 个要点或明显偏题 → 判入第四档；完全跑题 → 第五档。
6. 语言功底与卷面再好，只要缺核心要点或明显偏题，一律降档，不提档加分。
7. 能识别涂改杂乱、字迹潦草、画面模糊、斜角度拍摄的照片；实在辨认不清的位置必须标注说明，不随意估分、不人情送分。

【满分 25 分 · 四大维度】
- 内容 10 分：要点完整、切题、有细节
- 语言 10 分：语法准确、词汇丰富、句式多样
- 结构 3 分：分段清晰、过渡自然、逻辑连贯
- 书写 2 分：工整整洁、大小写与标点规范

【词数与要点】
- 词数要求 80–120 词，最佳 100 词左右
- 核心要点通常 3–4 个，必须全覆盖

【五档详细评分细则】

第一档 优秀 21–25 分
- 内容 9–10：全部要点齐全，紧扣主题，有合理拓展与细节，逻辑严密
- 语言 9–10：语法几乎无误；词汇准确丰富；句式多样（简单句＋复合句＋非谓语）；偶有小错不影响理解
- 结构 3：标准三段式（开头—主体—结尾）；过渡词（firstly / besides / therefore / however）丰富自然
- 书写 2：衡水体、无涂改、大小写与标点规范

第二档 良好 16–20 分
- 内容 7–8：全部要点齐全，主题明确，有少量细节，表达合理
- 语言 7–8：少量语法错误（3 处以内）；词汇够用；以简单句为主，少量复合句
- 结构 2：分段清晰；有基本过渡词，行文较连贯
- 书写 1–2：工整，少量涂改，不影响阅读

第三档 合格 11–15 分
- 内容 5–6：缺 1 个核心要点，或部分偏离主题；内容单薄、细节少
- 语言 5–6：语法错误较多（4–6 处）；词汇有限；句式单一，影响部分理解
- 结构 1：分段基本合理；过渡词少，逻辑一般
- 书写 1：较潦草，涂改较多，阅读稍费力

第四档 较差 6–10 分
- 内容 3–4：缺 2 个要点，或明显偏题；内容空洞、逻辑混乱
- 语言 3–4：大量语法错误；词汇贫乏；句子破碎，理解困难
- 结构 0：不分段、无过渡；结构混乱
- 书写 0：潦草难辨，涂改严重

第五档 极差 0–5 分
- 内容 0–2：完全跑题 / 无关内容；或只写个别单词
- 语言 0–2：无完整句子；错误连篇
- 结构 0：无结构
- 书写 0：空白、全中文、抄袭阅读原文、无法辨认 → 直接 0 分

【硬性扣分】累计不超过 5 分
1. 词数少于 80 词 → 扣 2 分；明显超出 120 词 → 酌情扣分
2. 缺 1 个核心要点 → 降一档（约扣 4–5 分）
3. 语法大错（时态 / 主谓一致 / 句型结构，影响理解）→ 每处扣 1 分
4. 拼写、标点小错 → 每处扣 0.5 分，不重复扣
5. 书信 / 邮件格式错误 → 扣 1–2 分
6. 照抄试卷语篇原文 → 该部分不得分；文中出现真实姓名、校名 → 扣分并降档

【重点关注】
- 要点全 ＝ 保底 16 分；要点缺 ＝ 直接掉档
- 三段式 ＋ 高级过渡词（however / therefore / as far as I'm concerned）→ 直接拉高 1–2 分
- 衡水体 ＋ 无涂改 → 印象分拉满，同水平多 1–2 分
- 高分公式：全要点 ＋ 三段式 ＋ 少量高级词/句式 ＋ 工整书写 ＝ 20 分以上
- 时态是阅卷侧重：叙事用一般过去时，议论感悟用一般现在时，混用即判大错
- 命题抵制空洞模板，青睐贴合自身生活的真实细节描写，常与阅读材料呼应

【点评用语要求】
- 通俗易懂，避开晦涩专业语法术语，适配初三学生理解
- 禁止贬低学生写作水平，不推荐任何教辅机构，不泄露内部阅卷私密信息
- 问题与建议要指向可操作的改法，优先标注漏要点、语法大错、格式错误、书写潦草

【卷面学生信息与作文标识】
- 如实提取作文纸 / 卷面上学生自己写出的信息：姓名、班级、考号或学号。**没写就返回空字符串，绝对不要猜测、不要编造、不要根据字迹推断。**
- 这些信息仅供教师内部登分核对使用，**严禁写入 comment、problems、suggestions 等任何面向学生的文字里**，也不要在评语里称呼学生姓名。
- 另外单独提取两个标识，方便教师核对是哪一篇作文：
  - essayTitle：学生自己写的作文标题（通常在正文第一行）。没写标题就返回空字符串，不要拿题目要求或正文首句冒充标题。
  - firstSentence：正文的第一句话（不含标题），尽量完整照抄原文，用于教师快速辨认。

【输出要求】
只输出一个 JSON 对象，不要任何解释文字，不要 markdown 代码块包裹。字段如下：
{
  "transcription": "识别出的学生作文原文，无法辨认处写【?】",
  "wordCount": 识别出的词数（数字）,
  "studentInfo": {
    "name": "卷面上写出的学生姓名，没有就空字符串",
    "className": "卷面上写出的班级，没有就空字符串",
    "seatNo": "卷面上写出的考号或学号，没有就空字符串"
  },
  "essayTitle": "学生自己写的作文标题，没写就空字符串",
  "firstSentence": "正文第一句话，没识别到就空字符串",
  "score": 0 到 25 的整数,
  "tier": "一档（优秀）或 二档（良好）或 三档（合格）或 四档（较差）或 五档（极差）",
  "dimensions": { "content": 0-10, "language": 0-10, "structure": 0-3, "handwriting": 0-2 },
  "pointsDetail": [
    { "point": "要点原文", "covered": true 或 false, "note": "覆盖情况说明，如：写了名称但没写来历" }
  ],
  "deductions": ["硬性扣分项，如：词数 76 词 −2 分"],
  "problems": ["2–4 条核心问题，优先标注漏要点、语法大错、格式错误"],
  "suggestions": ["2–4 条针对性改进建议"],
  "comment": "面向学生的综合评语，120 字以内，通俗易懂"
}

【撰写范文的要求】（仅当用户要求增加 modelEssay 字段时）
贴合学生现有能力撰写全文范文，符合中考词数、要点、三段式要求，词汇句式贴合译林版教材及 2022 版课标，不使用超纲词汇句式，不编写远超学生能力的满分范文。`;

/* 题目识别用的提示词（与阅卷提示词分开，互不影响） */
const QUESTION_PROMPT = `你是协助初三英语教师录入备课资料的助手。老师会给你一张试卷上「书面表达 / 作文题」部分的照片，你需要把题目信息准确提取出来，用于建立作文批改任务。

【提取要求】
1. 完整识别题目原文，不要改写、不要翻译成中文后替换原文。
2. 找出本题的**写作要点**（通常是 3 个，也可能 2 个或 4 个）。要点是题目明确要求学生写的内容条目，常见形式：
   - 表格或分栏里列出的条目
   - 连词连接的要求，如 "① name and origin ② reasons and ways ③ feelings"
   - 中文提示的「请介绍……」「请说明……」「请谈谈……」等分句
   请**逐条列出**，保留题目原本的表述（英文就用英文，中文就用中文，中英混合照原样）。
3. 判断词数要求（如「100 词左右」「不少于 80 词」）、文体（记叙文 / 发言稿 / 读后感 / 书信 / 邮件等）。
4. 如果图片模糊、遮挡或根本不是作文题，points 返回空数组，并在 raw 里说明识别到什么。

【输出要求】
只输出一个 JSON 对象，不要任何解释文字，不要 markdown 代码块包裹。字段如下：
{
  "title": "作文题目原文，例如 Give new life to old things",
  "titleCn": "题目的中文含义或中文题干（如果有）",
  "points": ["要点1原文", "要点2原文", "要点3原文"],
  "wordLimit": "词数要求，如 100 词左右；没写就留空字符串",
  "format": "文体，如 记叙文 / 发言稿 / 读后感 / 书信；判断不出就留空字符串",
  "raw": "图片中作文题部分的完整文字内容"
}`;

/* 为学生单独生成「适配水平优化范文」（用于打印后发给学生的报告） */
const ESSAY_PROMPT = `你是拥有 15 年苏州高新区初三英语教学及中考阅卷经验的资深教师。现在你要为一名初三学生改写一篇「适配他现有水平」的优化范文，用于学生对照学习、课后背诵模仿。

【写作要求】
1. 覆盖本条消息中列出的全部核心要点，一个都不能少。
2. 采用标准三段式（开头—主体—结尾），使用自然过渡词（First / Besides / However / Finally / As a result 等）。
3. 词数控制在 80–120 词，以 100 词左右为最佳。
4. 词汇与句式必须贴合译林版初中英语教材及《义务教育英语课程标准（2022 年版）》，不得使用超纲词汇或复杂长句。难度只需略高于该生现有水平，绝不要写成远超其能力的满分范文。
5. 尽量保留学生原文中真实可用的细节（具体物件、真实感受、真实场景），让范文读起来像这个学生自己写得出来的，而不是通用模板。
6. 不要出现任何真实姓名、校名；需要称呼时用 Li Hua 或 I。
7. 语气积极，不贬低学生。

【输出要求】
只输出一个 JSON 对象，不要任何解释文字，不要 markdown 代码块包裹。字段如下：
{
  "modelEssay": "优化范文全文（英文，纯文本，段落之间用一个换行分隔）",
  "notes": ["2–3 条修改说明，例如：补全了第三个要点「感受或收获」；把混用的时态统一为一般过去时"],
  "keyPhrases": ["3–5 个可迁移背诵的好词好句，中英对照，例如：give new life to 赋予新生命"]
}`;

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

let writeQueue = Promise.resolve();
function writeJson(file, obj) {
  writeQueue = writeQueue.then(() =>
    fsp.writeFile(file, JSON.stringify(obj, null, 2), 'utf8')
  );
  return writeQueue;
}

const uid = (p) => p + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);

async function loadDb() {
  const db = await readJson(DB_FILE, { batches: [] });
  if (!Array.isArray(db.batches)) db.batches = [];
  return db;
}

function findBatch(db, id) {
  return db.batches.find((b) => b.id === id);
}

/* ------------------------------------------------------------------ */
/* 学生档案：跨批次把同一个学生的多次作文归到一起                        */
/* ------------------------------------------------------------------ */

async function loadStudents() {
  const s = await readJson(STUDENTS_FILE, { students: [] });
  if (!Array.isArray(s.students)) s.students = [];
  return s;
}

/* 归一化：全角转半角、去掉括号与空格、统一大小写。
   让「九(8)班」和「九8班」、「Li Si」和「lisi 」能认出是同一个人 */
function normKey(s) {
  return String(s || '')
    .replace(/[\uFF01-\uFF5E]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
    .replace(/[\s()（）\[\]【】.、,，]/g, '')
    .toLowerCase();
}

/* 学生匹配键：班级 + 姓名。没有姓名就无法归档 */
function studentKey(className, name) {
  const n = normKey(name);
  if (!n) return '';
  return normKey(className) + '|' + n;
}

/* 找出或建立该篇作文对应的学生档案，返回学生 id（无姓名时返回 ''） */
async function resolveStudent(batch, identity) {
  const name = (identity && identity.name) || '';
  if (!name.trim()) return '';
  const className = ((identity && identity.className) || batch.className || '').trim();
  const key = studentKey(className, name);

  const store = await loadStudents();
  let hit = store.students.find((s) => s.key === key);
  if (!hit) {
    hit = {
      id: uid('s_'),
      key: key,
      name: name.trim(),
      className: className,
      seatNo: ((identity && identity.seatNo) || '').trim(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    store.students.push(hit);
  } else {
    hit.updatedAt = new Date().toISOString();
    if (!hit.name) hit.name = name.trim();
    if (!hit.className && className) hit.className = className;
    if (!hit.seatNo && identity && identity.seatNo) hit.seatNo = String(identity.seatNo).trim();
  }
  await writeJson(STUDENTS_FILE, store);
  return hit.id;
}

/* 全量重建学生档案索引。
   关键点：档案的匹配键由「姓名 + 班级」重新算出，不能用档案里存的旧 key，
   否则改名 / 改班之后旧键会残留在档案里，越改越多重复。 */
async function rebuildStudents() {
  const db = await loadDb();
  const store = await loadStudents();

  // 先统计每个档案当前挂着多少篇作文，用于同名冲突时保留有作文的那条
  const held = {};
  db.batches.forEach(function (b) {
    b.essays.forEach(function (e) {
      if (e.studentId) held[e.studentId] = (held[e.studentId] || 0) + 1;
    });
  });

  const byKey = {};
  store.students.forEach(function (s) {
    const k = studentKey(s.className, s.name);
    if (!k) return;
    const cur = byKey[k];
    if (!cur) { byKey[k] = s; return; }
    // 同一个键下有多条（改名撞车）时，保留有作文的那条
    if ((held[s.id] || 0) > (held[cur.id] || 0)) byKey[k] = s;
  });

  const used = {};
  let linked = 0;
  db.batches.forEach(function (b) {
    b.essays.forEach(function (e) {
      const idt = e.identity || {};
      const name = (idt.name || '').trim();
      if (!name) { e.studentId = ''; return; }
      const className = (idt.className || b.className || '').trim();
      const key = studentKey(className, name);
      let s = byKey[key];
      if (!s) {
        s = {
          id: uid('s_'), key: key, name: name, className: className,
          seatNo: (idt.seatNo || '').trim(),
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
        };
        byKey[key] = s;
      }
      s.key = key;                                   // 键随姓名/班级同步更新
      if (!s.name) s.name = name;
      if (!s.className && className) s.className = className;
      if (!s.seatNo && idt.seatNo) s.seatNo = String(idt.seatNo).trim();
      s.updatedAt = new Date().toISOString();
      e.studentId = s.id;
      used[s.id] = true;
      linked++;
    });
  });

  // 丢弃已经没有作文的残留档案
  const list = Object.keys(byKey).map(function (k) { return byKey[k]; })
    .filter(function (s) { return used[s.id]; });
  list.sort(function (a, b2) {
    const c = String(a.className).localeCompare(String(b2.className), 'zh');
    return c !== 0 ? c : String(a.name).localeCompare(String(b2.name), 'zh');
  });
  await writeJson(STUDENTS_FILE, { students: list });
  await writeJson(DB_FILE, db);
  return { students: list.length, linked: linked };
}

async function init() {
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) await fsp.writeFile(DB_FILE, JSON.stringify({ batches: [] }, null, 2), 'utf8');
  if (!fs.existsSync(SETTINGS_FILE)) {
    const s = Object.assign({}, DEFAULT_SETTINGS, { prompt: DEFAULT_PROMPT });
    await fsp.writeFile(SETTINGS_FILE, JSON.stringify(s, null, 2), 'utf8');
  }
  if (!fs.existsSync(PROMPT_FILE)) await fsp.writeFile(PROMPT_FILE, DEFAULT_PROMPT, 'utf8');
  if (!fs.existsSync(STUDENTS_FILE)) await fsp.writeFile(STUDENTS_FILE, JSON.stringify({ students: [] }, null, 2), 'utf8');

  // 真正写一次，确认目录可写。
  // 只看文件存不存在是不够的：文件都在、目录只读时，服务能正常启动，
  // 但之后每一次批改、复核、导出都会失败，用户看到的只是「莫名其妙存不了」。
  // 注意：只以「能否写入」为准。清不掉这个探针文件不算问题 ——
  // 某些系统（以及受管环境）会拦删除操作，但只要能写，平台就能正常用。
  const probe = path.join(DATA_DIR, '.write_probe');
  try {
    await fsp.writeFile(probe, 'ok', 'utf8');
  } catch (e) {
    const err = new Error('数据目录不可写：' + DATA_DIR);
    err.code = e.code || 'EACCES';
    throw err;
  }
  try { await fsp.unlink(probe); } catch (_) { /* 清不掉无所谓 */ }
}

/* 班名归一化显示：同一个班的不同写法（九(8)班 / 九8班）只显示一种。
   优先级：教师建批次时填的班级 > 出现次数最多的写法 */
function classDisplayMap(db, store) {
  const vote = {};
  const addVote = function (cls, weight) {
    const k = normKey(cls);
    if (!k) return;
    if (!vote[k]) vote[k] = {};
    const raw = String(cls).trim();
    vote[k][raw] = (vote[k][raw] || 0) + weight;
  };
  db.batches.forEach(function (b) { addVote(b.className, 3); });
  store.students.forEach(function (s) { addVote(s.className, 1); });

  const canon = {};
  Object.keys(vote).forEach(function (k) {
    let best = '', bestN = -1;
    Object.keys(vote[k]).sort(function (a, c) { return c.length - a.length; }).forEach(function (sp) {
      if (vote[k][sp] > bestN) { bestN = vote[k][sp]; best = sp; }
    });
    canon[k] = best;
  });

  return function displayOf(cls) {
    const k = normKey(cls);
    if (!k) return '（未填班级）';
    return canon[k] || String(cls).trim();
  };
}

/* 作文里的姓名与学生档案不一致时，自动重建一次索引（自愈，代价很小） */
async function ensureLinked() {
  const db = await loadDb();
  let need = false;
  for (const b of db.batches) {
    for (const e of b.essays) {
      const hasName = !!((e.identity || {}).name);
      if (hasName !== !!e.studentId) { need = true; break; }
    }
    if (need) break;
  }
  if (need) await rebuildStudents();
}

/* ------------------------------------------------------------------ */
/* AI 批改                                                             */
/* ------------------------------------------------------------------ */

function buildUserText(batch, essay) {
  const pts = (batch.points || []).filter(Boolean);
  let t = '';
  t += '作文题目：' + (batch.title || '（未填写）') + '\n';
  if (pts.length) {
    t += '本题必写核心要点（共 ' + pts.length + ' 个，必须逐一核对是否覆盖）：\n';
    pts.forEach((p, i) => { t += (i + 1) + '. ' + p + '\n'; });
  }
  if (batch.className) t += '班级：' + batch.className + '（仅用于教师内部核对）\n';
  t += '作文编号：' + essay.no + ' 号\n\n';
  t += '请严格按照评分标准批改这篇学生手写英语作文，只返回 JSON。';
  return t;
}

function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a === -1 || b === -1 || b < a) return null;
  const raw = s.slice(a, b + 1);
  try { return JSON.parse(raw); } catch (e) { /* 尝试修复常见问题 */ }
  try { return JSON.parse(raw.replace(/,\s*([}\]])/g, '$1')); } catch (e) { return null; }
}

function normalizeResult(r) {
  const num = (v, min, max, d) => {
    const n = Number(v);
    if (!isFinite(n)) return d;
    return Math.max(min, Math.min(max, n));
  };
  const arr = (v) => {
    if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean);
    if (typeof v === 'string' && v.trim()) return v.split('\n').map((x) => x.replace(/^[①②③④⑤\d.\s、-]+/, '').trim()).filter(Boolean);
    return [];
  };
  const d = r && r.dimensions ? r.dimensions : {};
  const out = {
    transcription: String((r && r.transcription) || ''),
    wordCount: num(r && r.wordCount, 0, 2000, 0),
    score: Math.round(num(r && r.score, 0, 25, 0)),
    tier: String((r && r.tier) || ''),
    dimensions: {
      content: num(d.content, 0, 10, 0),
      language: num(d.language, 0, 10, 0),
      structure: num(d.structure, 0, 3, 0),
      handwriting: num(d.handwriting, 0, 2, 0)
    },
    deductions: arr(r && r.deductions),
    problems: arr(r && r.problems),
    suggestions: arr(r && r.suggestions),
    comment: String((r && r.comment) || '')
  };

  // 要点覆盖明细 —— 支撑「要点第一」的判定透明度
  const rawPts = r && r.pointsDetail;
  out.pointsDetail = (Array.isArray(rawPts) ? rawPts : []).map(function (p) {
    if (typeof p === 'string') return { point: p, covered: true, note: '' };
    const c = p && p.covered;
    return {
      point: String((p && (p.point || p.name || p.text)) || '').trim(),
      covered: c === true || c === 'true' || c === 'yes' || c === '已覆盖' || c === '是',
      note: String((p && (p.note || p.detail || p.desc)) || '').trim()
    };
  }).filter(function (p) { return p.point; });

  // 优化范文（仅在开启该选项时请求，返回了才存）
  out.modelEssay = String((r && (r.modelEssay || r.model_essay)) || '').trim();

  // 卷面学生信息（仅内部登分核对用，不进入任何面向学生的文字）
  const si = (r && r.studentInfo) || {};
  out.studentInfo = {
    name: String((si.name || si.studentName || '')).trim(),
    className: String((si.className || si.class || '')).trim(),
    seatNo: String((si.seatNo || si.studentNo || si.no || '')).trim()
  };

  // 作文标识：标题 + 正文首句，用于教师快速认出是哪一篇
  const ident = deriveIdentifier(out.transcription);
  out.essayTitle = String((r && (r.essayTitle || r.title)) || '').trim() || ident.title;
  out.firstSentence = String((r && (r.firstSentence || r.first_sentence)) || '').trim() || ident.firstSentence;

  if (!out.tier) out.tier = tierName(out.score);
  return out;
}

/* 从识别原文里兜底提取标题与首句（模型没给时用） */
function deriveIdentifier(transcription) {
  const res = { title: '', firstSentence: '' };
  const lines = String(transcription || '').split('\n').map((x) => x.trim()).filter(Boolean);
  if (!lines.length) return res;

  // 中英文句末标点都算句子结束
  const isSentenceEnd = (s) => /[.!?。！？]["'”’)\]]?$/.test(s);

  let start = 0;
  const first = lines[0].replace(/^["'“”]+|["'“”]+$/g, '').trim();
  // 首行短、不以句末标点结尾、且后面还有正文时，视为学生自写的标题（中英文标题都适用）
  if (lines.length > 1 && first.length > 0 && first.length <= 40 && !isSentenceEnd(first)) {
    res.title = first;
    start = 1;
  }
  // 取正文第一句话
  for (let i = start; i < lines.length; i++) {
    const seg = lines[i].replace(/^["'“”]+/, '');
    if (!seg) continue;
    const m = seg.match(/^[^.!?。！？]*[.!?。！？]+["'”’)\]]?/);
    res.firstSentence = (m ? m[0] : seg).trim();
    break;
  }
  return res;
}

function tierName(s) {
  if (s >= 21) return '一档（优秀）';
  if (s >= 16) return '二档（良好）';
  if (s >= 11) return '三档（合格）';
  if (s >= 6) return '四档（较差）';
  return '五档（极差）';
}

async function requestOnce(settings, systemPrompt, userText, buf, mime, useJson) {
  const b64 = buf.toString('base64');

  const body = {
    model: settings.model,
    max_tokens: Number(settings.maxTokens) > 0 ? Number(settings.maxTokens) : 8192,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          { type: 'text', text: userText },
          { type: 'image_url', image_url: { url: 'data:' + (mime || 'image/jpeg') + ';base64,' + b64 } }
        ]
      }
    ]
  };

  const ds = isDeepSeek(settings.baseUrl);
  const thinkingOn = ds && settings.thinking === 'on';
  if (ds) {
    // DeepSeek 思考模式默认开启；显式传 disabled 才能真正关掉
    body.thinking = { type: thinkingOn ? 'enabled' : 'disabled' };
  }
  // 思考模式不支持 temperature（官方说明：不报错但不生效），因此开启时不传
  if (!thinkingOn) {
    body.temperature = typeof settings.temperature === 'number' ? settings.temperature : 0.2;
  }
  if (useJson) body.response_format = { type: 'json_object' };

  const endpoint = String(settings.baseUrl || '').replace(/\/+$/, '') + '/chat/completions';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), (settings.timeout || 180) * 1000);

  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + (settings.apiKey || '')
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (e) {
    clearTimeout(timer);
    throw new Error('网络请求失败：' + (e && e.message ? e.message : e) + '（请检查接口地址与网络）');
  }
  clearTimeout(timer);

  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text).error?.message || text; } catch (e) { /* ignore */ }
    const m = String(msg);
    if (/does not support image|not support image/i.test(m)) {
      throw new Error('当前模型不支持图片输入。你填的模型是「' + settings.model +
        '」，这是纯文本模型。DeepSeek 请改用 deepseek-flash；通义千问请用 qwen3-vl-plus；智谱请用 glm-4v-plus。改完到「设置」保存再重试。');
    }
    if (/model_not_found|does not exist|invalid model|模型不存在/i.test(m)) {
      throw new Error('模型名「' + settings.model + '」不被该接口识别，请对着服务商文档核对模型名称。原始信息：' + m.slice(0, 200));
    }
    throw new Error('接口返回 ' + res.status + '：' + m.slice(0, 300));
  }

  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error('接口返回内容无法解析为 JSON'); }
  const content = data?.choices?.[0]?.message?.content;
  const flat = Array.isArray(content)
    ? content.map((c) => (typeof c === 'string' ? c : c.text || '')).join('')
    : content;

  const finish = data?.choices?.[0]?.finish_reason;
  return { parsed: extractJson(flat), raw: String(flat || ''), finish: finish };
}

/* 带自动重试的图片问答：第一次按 forceJson 设置，失败后换一种模式重试一次。
   validate 用于判断「解析成功但内容无效」的情况（模型返回空模板），这类也算失败。 */
async function askWithImage(settings, systemPrompt, userText, buf, mime, validate) {
  const ok = validate || function () { return true; };
  let r = await requestOnce(settings, systemPrompt, userText, buf, mime, !!settings.forceJson);
  if (r.parsed && ok(r.parsed)) return { ok: true, data: r.parsed };

  const firstRaw = r.raw;
  const firstFinish = r.finish;
  const firstParsed = r.parsed;

  try {
    const r2 = await requestOnce(settings, systemPrompt, userText, buf, mime, !settings.forceJson);
    if (r2.parsed && ok(r2.parsed)) return { ok: true, data: r2.parsed };
    r = r2;
  } catch (e) {
    // 第二次失败时保留第一次的信息
  }

  let reason = 'AI 未返回标准 JSON';
  if (firstParsed && !ok(firstParsed)) reason = '模型返回了空结果（没有任何识别文本或评语）';
  else if (!firstRaw.trim()) reason = '模型返回了空内容';
  if (firstFinish === 'length') {
    reason = '输出被长度限制截断。' + (settings.thinking === 'on'
      ? '当前开启了思考模式，思维链会占用输出额度，建议把 max_tokens 调到 16384 以上，或把思考模式改为「关闭」'
      : '可到「设置」把 max_tokens 调大');
  }
  return {
    ok: false,
    reason: reason + '（已自动重试 1 次）',
    raw: String(r.raw || firstRaw || '').slice(0, 3000)
  };
}

/* 一次有效的作文批改，至少要给出识别文本或评语，否则视为失败而不是 0 分 */
function isEmptyResult(r) {
  if (!r) return false;
  const text = String(r.transcription || '') + String(r.comment || '');
  const hasList = (Array.isArray(r.problems) && r.problems.length) ||
    (Array.isArray(r.suggestions) && r.suggestions.length) ||
    (Array.isArray(r.deductions) && r.deductions.length) ||
    (Array.isArray(r.pointsDetail) && r.pointsDetail.length);
  return !text.trim() && !hasList;
}

function isValidGrading(g) {
  if (!g) return false;
  const text = String(g.transcription || '') + String(g.comment || '');
  const hasList = (Array.isArray(g.problems) && g.problems.length) ||
    (Array.isArray(g.suggestions) && g.suggestions.length) ||
    (Array.isArray(g.deductions) && g.deductions.length);
  return !!(text.trim() || hasList);
}

async function callModel(settings, prompt, batch, essay) {
  const buf = await fsp.readFile(path.join(UPLOAD_DIR, essay.file));
  let userText = buildUserText(batch, essay);
  if (settings.modelEssay) {
    userText += '\n\n另外请在 JSON 中增加 modelEssay 字段，给出适配该生水平的优化范文（纯文本，不要 markdown 标记）。';
  }
  const r = await askWithImage(settings, prompt, userText, buf, essay.mime, isValidGrading);
  if (!r.ok) return r;
  return { ok: true, result: normalizeResult(r.data) };
}

/* 从试卷照片里识别作文题目与写作要点 */
function normalizeQuestion(q) {
  const str = (v) => String(v === undefined || v === null ? '' : v).trim();
  const arr = (v) => {
    if (Array.isArray(v)) return v.map((x) => str(typeof x === 'object' ? (x.text || x.point || '') : x)).filter(Boolean);
    if (typeof v === 'string' && v.trim()) return v.split('\n').map((x) => x.replace(/^[①②③④⑤\d.\s、\-—]+/, '').trim()).filter(Boolean);
    return [];
  };
  return {
    title: str(q && (q.title || q.topic || q.titleEn)),
    titleCn: str(q && (q.titleCn || q.title_cn)),
    points: arr(q && (q.points || q.requirements || q.pointList)),
    wordLimit: str(q && (q.wordLimit || q.words || q.word_count)),
    format: str(q && (q.format || q.genre || q.type)),
    raw: str(q && (q.raw || q.transcription || q.text))
  };
}

async function callModelForQuestion(settings, buf, mime) {
  const valid = function (q) {
    return !!(q && ((q.title && String(q.title).trim()) ||
      (Array.isArray(q.points) && q.points.length) ||
      (q.raw && String(q.raw).trim())));
  };
  const r = await askWithImage(settings, QUESTION_PROMPT,
    '请识别这张图片中的英语作文题目与写作要点，只返回 JSON。', buf, mime, valid);
  if (!r.ok) return r;
  return { ok: true, result: normalizeQuestion(r.data) };
}

/* ---------------- 学生优化范文 ---------------- */

function toStrArr(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string' && v.trim()) {
    return v.split('\n').map((x) => x.replace(/^[①②③④⑤\d.\s、\-—]+/, '').trim()).filter(Boolean);
  }
  return [];
}

function buildEssayUserText(batch, essay, r) {
  const pts = (batch.points || []).filter(Boolean);
  let t = '作文题目：' + (batch.title || '（未填写）') + '\n';
  if (pts.length) {
    t += '本题核心要点（范文必须全部覆盖）：\n';
    pts.forEach((p, i) => { t += (i + 1) + '. ' + p + '\n'; });
  }
  if (r) {
    t += '\n该篇得分：' + (r.score !== undefined ? r.score : '?') + '/25（' + (r.tier || '') + '）\n';
    const dim = r.dimensions || {};
    t += '维度得分：内容 ' + (dim.content ?? '-') + '/10，语言 ' + (dim.language ?? '-') + '/10，结构 ' +
      (dim.structure ?? '-') + '/3，书写 ' + (dim.handwriting ?? '-') + '/2\n';
    if (r.problems && r.problems.length) {
      t += '该篇主要问题：\n';
      r.problems.forEach((p) => { t += '- ' + p + '\n'; });
    }
    if (r.transcription) t += '\n学生原文（供你参考细节，可保留其中真实可用的内容）：\n' + r.transcription + '\n';
  }
  t += '\n请针对这名学生的水平写一篇优化范文，只返回 JSON。';
  return t;
}

async function callModelForEssay(settings, batch, essay, r) {
  const valid = function (d) {
    return !!(d && d.modelEssay && String(d.modelEssay).trim().length > 20);
  };
  const buf = await fsp.readFile(path.join(UPLOAD_DIR, essay.file));
  const res = await askWithImage(settings, ESSAY_PROMPT, buildEssayUserText(batch, essay, r), buf, essay.mime, valid);
  if (!res.ok) return res;
  const d = res.data;
  return {
    ok: true,
    result: {
      text: String(d.modelEssay || '').trim(),
      notes: toStrArr(d.notes),
      keyPhrases: toStrArr(d.keyPhrases)
    }
  };
}

/* ---------------- DOCX 生成（零依赖） ---------------- */

const CRC_TABLE = (function () {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0 ^ (-1);
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xFF];
  return (c ^ (-1)) >>> 0;
}

/* 把若干 {name, data} 打包成 ZIP（docx 的容器格式） */
function zipSync(entries) {
  const zlib = require('zlib');
  const parts = [];
  const central = [];
  let offset = 0;
  entries.forEach(function (e) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const crc = crc32(data);
    const comp = zlib.deflateRawSync(data, { level: 9 });

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);          // UTF-8 文件名
    lh.writeUInt16LE(8, 8);               // deflate
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0x2821, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    parts.push(lh, nameBuf, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x2821, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + comp.length;
  });

  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([Buffer.concat(parts), cd, end]);
}

function xmlEsc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

/* 宋体/黑体 + Times New Roman，Windows 与 macOS 都能正常显示 */
const F_BODY = { ascii: 'Times New Roman', east: '宋体' };
const F_HEAD = { ascii: 'Arial', east: '黑体' };

function wRun(text, o) {
  o = o || {};
  const f = o.head ? F_HEAD : F_BODY;
  const size = o.size || 20;
  let rpr = '<w:rFonts w:ascii="' + f.ascii + '" w:hAnsi="' + f.ascii + '" w:eastAsia="' + f.east + '"/>';
  if (o.bold) rpr += '<w:b/><w:bCs/>';
  if (o.color) rpr += '<w:color w:val="' + o.color + '"/>';
  if (o.underline) rpr += '<w:u w:val="single"/>';
  rpr += '<w:sz w:val="' + size + '"/><w:szCs w:val="' + size + '"/>';
  let s = '<w:r><w:rPr>' + rpr + '</w:rPr>';
  if (o.brk) s += '<w:br/>';
  if (text !== undefined && text !== null) s += '<w:t xml:space="preserve">' + xmlEsc(text) + '</w:t>';
  s += '</w:r>';
  return s;
}

function wPara(runs, o) {
  o = o || {};
  let ppr = '';
  if (o.align || o.before !== undefined || o.after !== undefined || o.line || o.shade || o.indent) {
    ppr += '<w:pPr>';
    if (o.shade) ppr += '<w:shd w:val="clear" w:color="auto" w:fill="' + o.shade + '"/>';
    if (o.border) ppr += '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="2" w:color="' + o.border + '"/></w:pBdr>';
    let sp = [];
    if (o.before !== undefined) sp.push('w:before="' + o.before + '"');
    if (o.after !== undefined) sp.push('w:after="' + o.after + '"');
    if (o.line) sp.push('w:line="' + o.line + '" w:lineRule="auto"');
    if (sp.length) ppr += '<w:spacing ' + sp.join(' ') + '/>';
    if (o.indent) ppr += '<w:ind w:left="' + o.indent + '"/>';
    if (o.align) ppr += '<w:jc w:val="' + o.align + '"/>';
    ppr += '</w:pPr>';
  }
  return '<w:p>' + ppr + (runs || '') + '</w:p>';
}

function pageBreak() {
  return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
}

function buildDocx(bodyXml) {
  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>';

  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';

  const doc = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:body>' + bodyXml +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="1021" w:right="1021" w:bottom="1021" w:left="1021" w:header="709" w:footer="709" w:gutter="0"/>' +
    '</w:sectPr></w:body></w:document>';

  return zipSync([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'word/document.xml', data: doc }
  ]);
}

/* 单个学生一页的报告 */
const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

function buildStudentPage(batch, essay, r, essayRes, index) {
  const d = (r && r.dimensions) || {};
  const valid = r && !isEmptyResult(r);
  const score = valid ? (r.score !== undefined ? r.score : '—') : '—';
  const tier = valid && r.tier ? r.tier : '未批改';
  const pts = (valid && r.pointsDetail) || [];

  let x = '';
  let sec = 0;                    // 章节号动态递增，避免出现「二、」却找不到「一、」
  const nextSec = function () { return CN_NUM[sec++] + '、'; };

  // 页眉（有姓名就打印姓名，没有就留空供手写）
  const who = (essay.identity && essay.identity.name) || '';
  x += wPara(
    wRun('英语作文批改报告', { head: true, bold: true, size: 24 }) +
    wRun('　　　　编号：' + essay.no + ' 号　　姓名：', { size: 19 }) +
    (who ? wRun(who, { size: 19, bold: true }) : wRun('　　　　　', { size: 19, underline: true })),
    { align: 'center', after: 40 }
  );
  x += wPara(wRun('', {}), { border: '2563EB', after: 120 });

  // 题目
  x += wPara(
    wRun('作文题目：', { head: true, bold: true, size: 20 }) + wRun(batch.title || '—', { size: 20 }),
    { after: 60 }
  );

  // 得分
  x += wPara(
    wRun('得分：', { head: true, bold: true, size: 20 }) +
    wRun(String(score), { head: true, bold: true, size: 32, color: '2563EB' }) +
    wRun(' / 25　　', { size: 20 }) +
    wRun('档次：' + tier, { head: true, bold: true, size: 22, color: 'F97316' }),
    { after: 80 }
  );

  // 四维度
  if (valid) {
    x += wPara(
      wRun('内容 ' + (d.content ?? '—') + '/10　　语言 ' + (d.language ?? '—') + '/10　　结构 ' +
        (d.structure ?? '—') + '/3　　书写 ' + (d.handwriting ?? '—') + '/2' +
        (r.wordCount ? '　　词数 ' + r.wordCount : ''), { size: 19, color: '475569' }),
      { after: 110 }
    );
  }

  // 要点核对
  if (pts.length) {
    x += wPara(wRun(nextSec() + '写作要点核对', { head: true, bold: true, size: 20 }), { after: 30 });
    pts.forEach(function (p) {
      x += wPara(
        wRun(p.covered ? '【已写】' : '【漏写】', { size: 19, bold: !p.covered, color: p.covered ? '059669' : 'DC2626' }) +
        wRun(' ' + p.point + (p.note ? '　—— ' + p.note : ''), { size: 19 }),
        { after: 20, indent: 200 }
      );
    });
    x += wPara(wRun('', {}), { after: 50 });
  }

  // 需要改进的地方
  if (valid && r.problems && r.problems.length) {
    x += wPara(wRun(nextSec() + '需要改进的地方', { head: true, bold: true, size: 20 }), { after: 30 });
    r.problems.slice(0, 3).forEach(function (p, i) {
      x += wPara(wRun((i + 1) + '. ' + p, { size: 19 }), { after: 20, indent: 200 });
    });
    x += wPara(wRun('', {}), { after: 50 });
  }

  // 怎么提高
  if (valid && r.suggestions && r.suggestions.length) {
    x += wPara(wRun(nextSec() + '怎么提高', { head: true, bold: true, size: 20 }), { after: 30 });
    r.suggestions.slice(0, 3).forEach(function (s, i) {
      x += wPara(wRun((i + 1) + '. ' + s, { size: 19 }), { after: 20, indent: 200 });
    });
    x += wPara(wRun('', {}), { after: 50 });
  }

  // 评语
  if (valid && r.comment) {
    x += wPara(wRun(nextSec() + '老师评语', { head: true, bold: true, size: 20 }), { after: 30 });
    x += wPara(wRun(r.comment, { size: 19 }), { after: 100, indent: 200, shade: 'F3F7FF' });
  }

  // 范文
  const modelText = (essayRes && essayRes.text) || (valid && r.modelEssay) || '';
  x += wPara(wRun(nextSec() + '为你改写的范文（照着读三遍，把好句子抄下来）', { head: true, bold: true, size: 20 }), { after: 30 });
  if (modelText) {
    modelText.split(/\n+/).forEach(function (seg) {
      if (seg.trim()) x += wPara(wRun(seg.trim(), { size: 20 }), { after: 40, indent: 200 });
    });
    if (essayRes && essayRes.notes && essayRes.notes.length) {
      x += wPara(wRun('为什么这样改：', { head: true, bold: true, size: 19 }), { after: 20 });
      essayRes.notes.slice(0, 2).forEach(function (n, i) {
        x += wPara(wRun((i + 1) + '. ' + n, { size: 18, color: '475569' }), { after: 18, indent: 200 });
      });
    }
    if (essayRes && essayRes.keyPhrases && essayRes.keyPhrases.length) {
      x += wPara(wRun('背下来能加分的好词好句：', { head: true, bold: true, size: 19 }), { after: 20 });
      essayRes.keyPhrases.slice(0, 4).forEach(function (k) {
        x += wPara(wRun('· ' + k, { size: 18, color: '1D4ED8' }), { after: 18, indent: 200 });
      });
    }
  } else {
    x += wPara(wRun('（本篇尚未生成范文。请在平台里点「生成范文」，然后重新导出。）', { size: 18, color: '94A3B8' }),
      { after: 100, indent: 200 });
  }

  return x;
}

function buildReportDocx(batch, essays, essayMap) {
  let body = '';
  essays.forEach(function (e, i) {
    const r = eff(e);
    if (i > 0) body += pageBreak();
    body += buildStudentPage(batch, e, r, essayMap[e.id], i);
  });
  if (!essays.length) body = wPara(wRun('本批次没有可导出的作文。', { size: 22 }));
  return buildDocx(body);
}

/* 取有效成绩：教师复核优先 */
function eff(e) {
  if (e.review && e.review.confirmed) return e.review;
  return e.ai || null;
}

/* 是否有可用的批改结果（既要有结果，又不能是空模板） */
function hasResult(e) {
  const r = eff(e);
  return !!(r && !isEmptyResult(r));
}

/* ------------------------------------------------------------------ */
/* HTTP 处理                                                           */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 30 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return '"' + s.replace(/"/g, '""').replace(/\r?\n/g, ' ') + '"';
}

async function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const full = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
  try {
    const data = await fsp.readFile(full);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

async function serveUpload(req, res, pathname) {
  const name = path.basename(decodeURIComponent(pathname));
  const full = path.join(UPLOAD_DIR, name);
  if (!full.startsWith(UPLOAD_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
  try {
    const data = await fsp.readFile(full);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'private, max-age=86400'
    });
    res.end(data);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

/* 删除照片文件；返回删除失败的个数（已经不存在的不算失败） */
async function removeFiles(essays) {
  let failed = 0;
  for (const e of essays) {
    try {
      await fsp.unlink(path.join(UPLOAD_DIR, e.file));
    } catch (err) {
      if (err.code !== 'ENOENT') failed++;
    }
  }
  return failed;
}

async function handleApi(req, res, pathname, query) {
  /* ---- 读取配置（API Key 脱敏） ---- */
  if (pathname === '/api/state') {
    const settings = Object.assign({}, DEFAULT_SETTINGS, await readJson(SETTINGS_FILE, {}));
    const promptText = await fsp.readFile(PROMPT_FILE, 'utf8').catch(() => DEFAULT_PROMPT);
    const db = await loadDb();
    const batches = db.batches.map((b) => ({
      id: b.id, title: b.title, className: b.className, points: b.points,
      createdAt: b.createdAt,
      count: b.essays.length,
      done: b.essays.filter((e) => e.status === 'done').length
    }));
    return sendJson(res, 200, {
      ok: true,
      presets: VISION_PRESETS,
      settings: {
        baseUrl: settings.baseUrl,
        model: settings.model,
        temperature: settings.temperature,
        maxTokens: settings.maxTokens,
        thinking: settings.thinking,
        modelEssay: !!settings.modelEssay,
        forceJson: settings.forceJson,
        timeout: settings.timeout,
        isDeepSeek: isDeepSeek(settings.baseUrl),
        hasKey: !!(settings.apiKey && settings.apiKey.trim()),
        keyTail: settings.apiKey ? '****' + settings.apiKey.slice(-4) : ''
      },
      prompt: promptText,
      isDefaultPrompt: promptText.trim() === DEFAULT_PROMPT.trim(),
      batches
    });
  }

  const body = req.method === 'POST' ? await readBody(req) : {};

  /* ---- 保存配置 ---- */
  if (pathname === '/api/settings') {
    const cur = Object.assign({}, DEFAULT_SETTINGS, await readJson(SETTINGS_FILE, {}));
    const next = {
      baseUrl: body.baseUrl !== undefined ? String(body.baseUrl).trim() : cur.baseUrl,
      model: body.model !== undefined ? String(body.model).trim() : cur.model,
      temperature: body.temperature !== undefined ? Number(body.temperature) : cur.temperature,
      forceJson: body.forceJson !== undefined ? !!body.forceJson : cur.forceJson,
      maxTokens: body.maxTokens !== undefined ? Number(body.maxTokens) : cur.maxTokens,
      thinking: body.thinking !== undefined ? String(body.thinking) : cur.thinking,
      modelEssay: body.modelEssay !== undefined ? !!body.modelEssay : !!cur.modelEssay,
      timeout: body.timeout !== undefined ? Number(body.timeout) : cur.timeout,
      apiKey: (function () {
        if (body.apiKey === undefined) return cur.apiKey;
        const k = String(body.apiKey).trim();
        if (k === '__CLEAR__') return '';
        return k !== '' ? k : cur.apiKey;
      })()
    };
    await writeJson(SETTINGS_FILE, next);
    if (typeof body.prompt === 'string' && body.prompt.trim()) {
      const text = body.prompt.trim() === '__DEFAULT__' ? DEFAULT_PROMPT : body.prompt;
      await fsp.writeFile(PROMPT_FILE, text, 'utf8');
    }
    return sendJson(res, 200, { ok: true });
  }

  /* ---- 测试接口连通性 ---- */
  if (pathname === '/api/test') {
    const settings = Object.assign({}, DEFAULT_SETTINGS, await readJson(SETTINGS_FILE, {}));
    if (!settings.apiKey || !settings.baseUrl || !settings.model) {
      return sendJson(res, 200, { ok: false, error: '请先填写并保存接口地址、模型名称与 API Key' });
    }
    const endpoint = String(settings.baseUrl).replace(/\/+$/, '') + '/chat/completions';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    const testBody = {
      model: settings.model,
      messages: [{ role: 'user', content: '回复两个字：正常' }],
      max_tokens: 64
    };
    // 测试连接时强制关闭思考模式，否则思维链会吃掉 20 个 token 导致回复为空
    if (isDeepSeek(settings.baseUrl)) testBody.thinking = { type: 'disabled' };
    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + settings.apiKey },
        body: JSON.stringify(testBody),        signal: controller.signal
      });
      clearTimeout(timer);
      const text = await r.text();
      if (!r.ok) {
        let msg = text;
        try { msg = JSON.parse(text).error?.message || text; } catch (e) { /* ignore */ }
        return sendJson(res, 200, { ok: false, error: 'HTTP ' + r.status + '：' + String(msg).slice(0, 300) });
      }
      let data = {};
      try { data = JSON.parse(text); } catch (e) { /* ignore */ }
      const c = data?.choices?.[0]?.message?.content;
      const reply = Array.isArray(c) ? c.map((x) => (typeof x === 'string' ? x : x.text || '')).join('') : (c || '');
      return sendJson(res, 200, { ok: true, reply: String(reply).slice(0, 100) });
    } catch (e) {
      clearTimeout(timer);
      return sendJson(res, 200, { ok: false, error: '请求失败：' + (e && e.message ? e.message : e) });
    }
  }

  /* ---- 拍照识别作文题目与要点 ---- */
  if (pathname === '/api/parse-question') {
    const settings = Object.assign({}, DEFAULT_SETTINGS, await readJson(SETTINGS_FILE, {}));
    if (!settings.apiKey || !settings.apiKey.trim()) {
      return sendJson(res, 200, { ok: false, error: '尚未配置 API Key，请到「设置」填写后再使用拍照识别' });
    }
    const m = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/s.exec(String(body.dataUrl || ''));
    if (!m) return sendJson(res, 200, { ok: false, error: '图片格式不正确' });
    try {
      const r = await callModelForQuestion(settings, Buffer.from(m[2], 'base64'), m[1]);
      if (!r.ok) return sendJson(res, 200, { ok: false, error: r.reason, raw: r.raw });
      return sendJson(res, 200, { ok: true, question: r.result });
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: String(err.message || err) });
    }
  }

  /* ---- 新建批次 ---- */
  if (pathname === '/api/batch/create') {
    const db = await loadDb();
    const b = {
      id: uid('b_'),
      title: String(body.title || '').trim() || '未命名作文题',
      className: String(body.className || '').trim(),
      points: (Array.isArray(body.points) ? body.points : []).map((s) => String(s).trim()).filter(Boolean),
      createdAt: new Date().toISOString(),
      essays: []
    };
    db.batches.unshift(b);
    await writeJson(DB_FILE, db);
    return sendJson(res, 200, { ok: true, batch: b });
  }

  /* ---- 读取批次详情 ---- */
  if (pathname === '/api/batch/get') {
    const db = await loadDb();
    const b = findBatch(db, body.id || query.get('id'));
    if (!b) return sendJson(res, 404, { ok: false, error: '批次不存在' });
    return sendJson(res, 200, { ok: true, batch: b });
  }

  /* ---- 删除批次 ---- */
  if (pathname === '/api/batch/delete') {
    const db = await loadDb();
    const i = db.batches.findIndex((b) => b.id === body.id);
    if (i === -1) return sendJson(res, 404, { ok: false, error: '批次不存在' });
    const failed = await removeFiles(db.batches[i].essays);
    db.batches.splice(i, 1);
    await writeJson(DB_FILE, db);
    return sendJson(res, 200, { ok: true, cleanupFailed: failed, uploadDir: UPLOAD_DIR });
  }

  /* ---- 上传照片（base64） ---- */
  if (pathname === '/api/upload') {
    const db = await loadDb();
    const b = findBatch(db, body.batchId);
    if (!b) return sendJson(res, 404, { ok: false, error: '批次不存在' });
    const m = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/s.exec(String(body.dataUrl || ''));
    if (!m) return sendJson(res, 400, { ok: false, error: '图片格式不正确' });
    const ext = m[1] === 'image/png' ? '.png' : (m[1] === 'image/webp' ? '.webp' : '.jpg');
    const id = uid('e_');
    const file = id + ext;
    await fsp.writeFile(path.join(UPLOAD_DIR, file), Buffer.from(m[2], 'base64'));
    const essay = {
      id,
      no: b.essays.length + 1,
      file,
      mime: m[1],
      originalName: String(body.name || ''),
      createdAt: new Date().toISOString(),
      status: 'pending',
      ai: null,
      aiRaw: '',
      aiError: '',
      review: null,
      reviewed: false
    };
    b.essays.push(essay);
    await writeJson(DB_FILE, db);
    return sendJson(res, 200, { ok: true, essay });
  }

  /* ---- 批改一篇 ---- */
  if (pathname === '/api/grade') {
    const settings = Object.assign({}, DEFAULT_SETTINGS, await readJson(SETTINGS_FILE, {}));
    if (!settings.apiKey || !settings.apiKey.trim()) return sendJson(res, 400, { ok: false, error: '尚未配置 API Key，请到「设置」填写' });
    if (!settings.baseUrl || !settings.model) return sendJson(res, 400, { ok: false, error: '尚未配置接口地址或模型名称' });
    const prompt = await fsp.readFile(PROMPT_FILE, 'utf8').catch(() => DEFAULT_PROMPT);

    const db = await loadDb();
    const b = findBatch(db, body.batchId);
    if (!b) return sendJson(res, 404, { ok: false, error: '批次不存在' });
    const e = b.essays.find((x) => x.id === body.essayId);
    if (!e) return sendJson(res, 404, { ok: false, error: '作文记录不存在' });

    e.status = 'grading';
    await writeJson(DB_FILE, db);

    try {
      const r = await callModel(settings, prompt, b, e);
      const db2 = await loadDb();
      const b2 = findBatch(db2, body.batchId);
      const e2 = b2.essays.find((x) => x.id === body.essayId);
      if (r.ok) {
        e2.ai = r.result;
        e2.aiRaw = '';
        e2.aiError = '';
        e2.status = 'done';

        // 卷面识别到的学生信息：教师手工填过的就不覆盖
        const si = r.result.studentInfo || {};
        const manual = e2.identity && e2.identity.source === 'manual';
        if (!manual) {
          const any = si.name || si.className || si.seatNo;
          e2.identity = {
            name: si.name || '',
            className: si.className || '',
            seatNo: si.seatNo || '',
            source: any ? 'ai' : 'none',
            updatedAt: new Date().toISOString()
          };
        }
        // 作文标识（标题 + 正文首句），每次批改刷新
        e2.identifier = {
          title: r.result.essayTitle || '',
          firstSentence: r.result.firstSentence || ''
        };
        // 归入学生档案（有姓名才归）
        e2.studentId = (e2.identity && e2.identity.name) ? await resolveStudent(b2, e2.identity) : '';
      } else {
        e2.status = 'error';
        e2.aiError = r.reason || '解析失败';
        e2.aiRaw = r.raw || '';
      }
      await writeJson(DB_FILE, db2);
      return sendJson(res, 200, { ok: true, essay: e2 });
    } catch (err) {
      const db2 = await loadDb();
      const b2 = findBatch(db2, body.batchId);
      const e2 = b2.essays.find((x) => x.id === body.essayId);
      if (e2) { e2.status = 'error'; e2.aiError = String(err.message || err); }
      await writeJson(DB_FILE, db2);
      return sendJson(res, 200, { ok: false, error: String(err.message || err), essay: e2 });
    }
  }

  /* ---- 教师复核保存 ---- */
  if (pathname === '/api/review') {
    const db = await loadDb();
    const b = findBatch(db, body.batchId);
    if (!b) return sendJson(res, 404, { ok: false, error: '批次不存在' });
    const e = b.essays.find((x) => x.id === body.essayId);
    if (!e) return sendJson(res, 404, { ok: false, error: '作文记录不存在' });
    e.review = body.review || null;
    e.reviewed = !!(body.review && body.review.confirmed);
    await writeJson(DB_FILE, db);
    return sendJson(res, 200, { ok: true, essay: e });
  }

  /* ---- 删除单篇 ---- */
  if (pathname === '/api/essay/delete') {
    const db = await loadDb();
    const b = findBatch(db, body.batchId);
    if (!b) return sendJson(res, 404, { ok: false, error: '批次不存在' });
    const i = b.essays.findIndex((x) => x.id === body.essayId);
    let failed = 0;
    if (i > -1) {
      failed = await removeFiles([b.essays[i]]);
      b.essays.splice(i, 1);
    }
    await writeJson(DB_FILE, db);
    return sendJson(res, 200, { ok: true, cleanupFailed: failed, uploadDir: UPLOAD_DIR });
  }

  /* ---- 为某一篇生成优化范文 ---- */
  if (pathname === '/api/essay/model') {
    const settings = Object.assign({}, DEFAULT_SETTINGS, await readJson(SETTINGS_FILE, {}));
    if (!settings.apiKey || !settings.apiKey.trim()) {
      return sendJson(res, 200, { ok: false, error: '尚未配置 API Key，请到「设置」填写' });
    }
    const db = await loadDb();
    const b = findBatch(db, body.batchId);
    if (!b) return sendJson(res, 404, { ok: false, error: '批次不存在' });
    const e = b.essays.find((x) => x.id === body.essayId);
    if (!e) return sendJson(res, 404, { ok: false, error: '作文记录不存在' });

    try {
      const r = await callModelForEssay(settings, b, e, eff(e));
      if (!r.ok) return sendJson(res, 200, { ok: false, error: r.reason, raw: r.raw });
      const db2 = await loadDb();
      const b2 = findBatch(db2, body.batchId);
      const e2 = b2.essays.find((x) => x.id === body.essayId);
      e2.modelEssayRes = Object.assign({}, r.result, { createdAt: new Date().toISOString() });
      await writeJson(DB_FILE, db2);
      return sendJson(res, 200, { ok: true, essay: e2 });
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: String(err.message || err) });
    }
  }

  /* ---- 本地补录作文标识（不调 AI，零成本） ---- */
  if (pathname === '/api/backfill') {
    const db = await loadDb();
    const b = findBatch(db, body.batchId);
    if (!b) return sendJson(res, 404, { ok: false, error: '批次不存在' });
    let filled = 0;
    b.essays.forEach(function (e) {
      const r = e.ai || {};
      const idf = e.identifier || {};
      if ((idf.title || idf.firstSentence) || !r.transcription) return;
      const d = deriveIdentifier(r.transcription);
      if (d.title || d.firstSentence) {
        e.identifier = { title: d.title, firstSentence: d.firstSentence, source: 'derive' };
        filled++;
      }
    });
    // 顺便补全 identity 占位，让前台区分「从未识别」和「识别了但没写」
    b.essays.forEach(function (e) {
      if (!e.identity && (e.ai || e.review)) e.identity = { name: '', className: '', seatNo: '', source: 'none' };
    });
    if (filled) await writeJson(DB_FILE, db);
    const rebuilt = await rebuildStudents();
    return sendJson(res, 200, { ok: true, filled: filled, students: rebuilt.students, linked: rebuilt.linked });
  }

  /* ---- 教师订正卷面学生信息 ---- */
  if (pathname === '/api/identity') {
    const db = await loadDb();
    const b = findBatch(db, body.batchId);
    if (!b) return sendJson(res, 404, { ok: false, error: '批次不存在' });
    const e = b.essays.find((x) => x.id === body.essayId);
    if (!e) return sendJson(res, 404, { ok: false, error: '作文记录不存在' });
    const src = body.identity || {};
    const name = String(src.name || '').trim();
    const className = String(src.className || '').trim();
    const seatNo = String(src.seatNo || '').trim();
    const any = name || className || seatNo;
    e.identity = {
      name: name,
      className: className,
      seatNo: seatNo,
      source: any ? 'manual' : 'none',
      updatedAt: new Date().toISOString()
    };
    // 同步进学生档案（跨批次归并）
    e.studentId = name ? await resolveStudent(b, e.identity) : '';
    await writeJson(DB_FILE, db);
    return sendJson(res, 200, { ok: true, essay: e });
  }

  /* ---- 学生档案总览 ---- */
  if (pathname === '/api/archive') {
    await ensureLinked();
    const db = await loadDb();
    const store = await loadStudents();
    const byId = {};
    store.students.forEach(function (s) {
      byId[s.id] = {
        id: s.id, name: s.name, className: s.className, seatNo: s.seatNo,
        records: []
      };
    });

    let unlinked = 0;
    db.batches.forEach(function (b) {
      b.essays.forEach(function (e) {
        const s = byId[e.studentId];
        if (!s) { if ((e.identity || {}).name) unlinked++; return; }
        const r = hasResult(e) ? eff(e) : null;
        s.records.push({
          batchId: b.id,
          batchTitle: b.title,
          batchClass: b.className || '',
          date: b.createdAt,
          no: e.no,
          score: r && r.score !== undefined ? r.score : null,
          tier: (r && r.tier) || '',
          reviewed: !!e.reviewed,
          title: (e.identifier || {}).title || '',
          firstSentence: (e.identifier || {}).firstSentence || ''
        });
      });
    });

    const students = Object.keys(byId).map(function (k) {
      const s = byId[k];
      s.records.sort(function (a, c) { return String(a.date).localeCompare(String(c.date)); });
      const scores = s.records.map(function (r) { return r.score; }).filter(function (v) { return v !== null; });
      s.count = s.records.length;
      s.scored = scores.length;
      s.avg = scores.length ? Math.round((scores.reduce(function (a, c) { return a + c; }, 0) / scores.length) * 10) / 10 : null;
      s.best = scores.length ? Math.max.apply(null, scores) : null;
      s.worst = scores.length ? Math.min.apply(null, scores) : null;
      if (scores.length >= 2) {
        s.delta = Math.round((scores[scores.length - 1] - scores[scores.length - 2]) * 10) / 10;
      } else {
        s.delta = null;
      }
      s.last = s.records.length ? s.records[s.records.length - 1] : null;
      return s;
    });

    /* 班名归一化显示：同一个班的不同写法（九(8)班 / 九8班）只显示一种 */
    const displayOf = classDisplayMap(db, store);

    // 学生行的班级统一成规范写法，保证与班级概览一致
    students.forEach(function (s) { s.className = displayOf(s.className); });

    // 班级汇总
    const cls = {};
    students.forEach(function (s) {
      const k = s.className;
      if (!cls[k]) cls[k] = { className: k, students: 0, essays: 0, scores: [], unnamed: 0 };
      cls[k].students++;
      cls[k].essays += s.records.length;
      s.records.forEach(function (r) { if (r.score !== null) cls[k].scores.push(r.score); });
    });
    db.batches.forEach(function (b) {
      const k = displayOf(b.className);
      if (!cls[k]) cls[k] = { className: k, students: 0, essays: 0, scores: [], unnamed: 0 };
      b.essays.forEach(function (e) {
        if (!(e.identity || {}).name) cls[k].unnamed++;
      });
    });
    const classes = Object.keys(cls).map(function (k) {
      const c = cls[k];
      return {
        className: c.className,
        students: c.students,
        essays: c.essays,
        unnamed: c.unnamed,
        avg: c.scores.length ? Math.round((c.scores.reduce(function (a, x) { return a + x; }, 0) / c.scores.length) * 10) / 10 : null
      };
    });

    students.sort(function (a, b) {
      const c = String(a.className).localeCompare(String(b.className), 'zh');
      return c !== 0 ? c : String(a.name).localeCompare(String(b.name), 'zh');
    });

    return sendJson(res, 200, { ok: true, classes: classes, students: students, unlinked: unlinked });
  }

  /* ---- 单个学生的全部作文 ---- */
  if (pathname === '/api/student') {
    await ensureLinked();
    const db = await loadDb();
    const store = await loadStudents();
    const wantId = query.get('id') || body.id;
    const s = store.students.find(function (x) { return x.id === wantId; });
    if (!s) return sendJson(res, 404, { ok: false, error: '学生档案不存在' });

    const records = [];
    db.batches.forEach(function (b) {
      b.essays.forEach(function (e) {
        if (e.studentId !== s.id) return;
        const r = hasResult(e) ? eff(e) : null;
        records.push({
          batchId: b.id, batchTitle: b.title, batchClass: b.className || '',
          date: b.createdAt, no: e.no,
          score: r && r.score !== undefined ? r.score : null,
          tier: (r && r.tier) || '', reviewed: !!e.reviewed,
          title: (e.identifier || {}).title || '',
          firstSentence: (e.identifier || {}).firstSentence || '',
          comment: (r && r.comment) || '',
          problems: (r && r.problems) || [],
          dimensions: (r && r.dimensions) || {}
        });
      });
    });
    records.sort(function (a, b2) { return String(a.date).localeCompare(String(b2.date)); });

    // 同班平均分，便于对照
    const clsScores = [];
    const cls = normKey(s.className);
    db.batches.forEach(function (b) {
      b.essays.forEach(function (e) {
        if (!e.studentId || e.studentId === s.id) return;
        const other = store.students.find(function (x) { return x.id === e.studentId; });
        if (!other || normKey(other.className) !== cls) return;
        const r = hasResult(e) ? eff(e) : null;
        if (r && r.score !== undefined) clsScores.push(r.score);
      });
    });

    return sendJson(res, 200, {
      ok: true,
      student: Object.assign({}, s, { className: classDisplayMap(db, store)(s.className) }),
      records: records,
      classAvg: clsScores.length
        ? Math.round((clsScores.reduce(function (a, c) { return a + c; }, 0) / clsScores.length) * 10) / 10
        : null,
      classSample: clsScores.length
    });
  }

  /* ---- 修改学生档案（姓名/班级/学号），并同步到所有关联作文 ---- */
  if (pathname === '/api/student/update') {
    const store = await loadStudents();
    const s = store.students.find(function (x) { return x.id === body.id; });
    if (!s) return sendJson(res, 404, { ok: false, error: '学生档案不存在' });

    const src = body.student || {};
    const name = String(src.name === undefined ? s.name : src.name).trim();
    const className = String(src.className === undefined ? s.className : src.className).trim();
    const seatNo = String(src.seatNo === undefined ? s.seatNo : src.seatNo).trim();
    if (!name) return sendJson(res, 200, { ok: false, error: '姓名不能为空（没有姓名就无法归档）' });

    s.name = name;
    s.className = className;
    s.seatNo = seatNo;

    // 同步写回所有关联作文，然后整体重建索引（处理改名/改班导致的归并）
    const db = await loadDb();
    let touched = 0;
    db.batches.forEach(function (b) {
      b.essays.forEach(function (e) {
        if (e.studentId !== s.id) return;
        e.identity = Object.assign({}, e.identity, {
          name: name, className: className, seatNo: seatNo,
          source: (e.identity && e.identity.source === 'ai') ? 'ai' : 'manual',
          updatedAt: new Date().toISOString()
        });
        touched++;
      });
    });
    await writeJson(DB_FILE, db);
    await writeJson(STUDENTS_FILE, store);
    const rebuilt = await rebuildStudents();
    return sendJson(res, 200, { ok: true, updated: touched, rebuilt: rebuilt });
  }

  /* ---- 导出跨批次成绩矩阵（学生 × 各次作文） ---- */
  if (pathname === '/api/archive.csv') {
    await ensureLinked();
    const db = await loadDb();
    const store = await loadStudents();

    const batchCols = db.batches.filter(function (b) {
      return b.essays.some(function (e) { return e.studentId; });
    }).slice().reverse();   // 按时间正序

    const head = ['姓名', '班级', '学号']
      .concat(batchCols.map(function (b) {
        const d = new Date(b.createdAt);
        const p = (n) => String(n).padStart(2, '0');
        return b.title + '（' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '）';
      }))
      .concat(['作文次数', '平均分', '最高', '最低']);

    const rows = [head.map(csvCell).join(',')];
    const displayOf = classDisplayMap(db, store);
    store.students.slice().sort(function (a, b) {
      const c = String(displayOf(a.className)).localeCompare(String(displayOf(b.className)), 'zh');
      return c !== 0 ? c : String(a.name).localeCompare(String(b.name), 'zh');
    }).forEach(function (s) {
      const scores = [];
      const cells = batchCols.map(function (b) {
        const hit = b.essays.filter(function (e) { return e.studentId === s.id; });
        if (!hit.length) return '';
        const vals = hit.map(function (e) {
          const r = hasResult(e) ? eff(e) : null;
          return r && r.score !== undefined ? r.score : null;
        }).filter(function (v) { return v !== null; });
        vals.forEach(function (v) { scores.push(v); });
        return vals.length ? vals.join(' / ') : '';
      });
      const avg = scores.length
        ? Math.round((scores.reduce(function (a, c) { return a + c; }, 0) / scores.length) * 10) / 10 : '';
      rows.push([s.name, displayOf(s.className), s.seatNo].concat(cells)
        .concat([scores.length, avg, scores.length ? Math.max.apply(null, scores) : '',
          scores.length ? Math.min.apply(null, scores) : ''])
        .map(csvCell).join(','));
    });

    const csv = '\uFEFF' + rows.join('\r\n');
    const name = encodeURIComponent('学生作文成绩归档表_含姓名_仅内部使用.csv');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': "attachment; filename*=UTF-8''" + name
    });
    return res.end(csv);
  }

  /* ---- 导出登分表（含姓名，仅教师内部使用） ---- */
  if (pathname === '/api/roster.csv') {
    const db = await loadDb();
    const b = findBatch(db, query.get('id') || body.id);
    if (!b) return sendJson(res, 404, { ok: false, error: '批次不存在' });

    const head = ['编号', '姓名', '班级', '考号/学号', '姓名来源', '作文标题', '正文首句', '得分', '档次', '复核状态'];
    const rows = [head.map(csvCell).join(',')];
    b.essays.forEach(function (e) {
      const r = hasResult(e) ? eff(e) : null;
      const idt = e.identity || {};
      const idf = e.identifier || {};
      const srcTxt = idt.source === 'manual' ? '教师填写' : (idt.source === 'ai' ? '卷面识别' : '未识别');
      rows.push([
        e.no + ' 号',
        idt.name || '',
        idt.className || b.className || '',
        idt.seatNo || '',
        srcTxt,
        idf.title || '',
        idf.firstSentence || '',
        r ? r.score : '',
        r ? r.tier : '',
        e.reviewed ? '教师已复核' : (r ? '待复核' : '未批改')
      ].map(csvCell).join(','));
    });
    const csv = '\uFEFF' + rows.join('\r\n');
    const base = (b.title || '作文批改') + '_' + (b.className || '') + '_登分表_含姓名_仅内部使用';
    const name = encodeURIComponent(base + '.csv');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': "attachment; filename*=UTF-8''" + name
    });
    return res.end(csv);
  }

  /* ---- 导出学生报告 docx（每人一页） ---- */
  if (pathname === '/api/report.docx') {
    const db = await loadDb();
    const b = findBatch(db, query.get('id') || body.id);
    if (!b) return sendJson(res, 404, { ok: false, error: '批次不存在' });

    const onlyWithResult = query.get('all') !== '1';
    let list = b.essays.slice();
    if (onlyWithResult) list = list.filter(hasResult);
    if (query.get('from')) {
      const f = Number(query.get('from'));
      if (f > 0) list = list.filter((e) => e.no >= f);
    }
    if (query.get('to')) {
      const t = Number(query.get('to'));
      if (t > 0) list = list.filter((e) => e.no <= t);
    }
    if (!list.length) return sendJson(res, 200, { ok: false, error: '没有可导出的作文（可能都还没有批改结果）' });

    const essayMap = {};
    list.forEach((e) => { essayMap[e.id] = e.modelEssayRes || null; });

    const buf = buildReportDocx(b, list, essayMap);
    const base = (b.title || '作文批改') + '_' + (b.className || '未填班级') + '_学生报告';
    const name = encodeURIComponent(base + '.docx');
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Length': buf.length,
      'Content-Disposition': "attachment; filename*=UTF-8''" + name
    });
    return res.end(buf);
  }

  /* ---- 重置单篇（重新批改） ---- */
  if (pathname === '/api/essay/reset') {
    const db = await loadDb();
    const b = findBatch(db, body.batchId);
    if (!b) return sendJson(res, 404, { ok: false, error: '批次不存在' });
    const e = b.essays.find((x) => x.id === body.essayId);
    if (e) { e.status = 'pending'; e.aiError = ''; e.aiRaw = ''; }
    await writeJson(DB_FILE, db);
    return sendJson(res, 200, { ok: true });
  }

  /* ---- 导出 CSV ---- */
  if (pathname === '/api/export') {
    const db = await loadDb();
    const b = findBatch(db, body.id || query.get('id'));
    if (!b) return sendJson(res, 404, { ok: false, error: '批次不存在' });
    const head = ['编号', '姓名', '最终得分', '档次', '内容', '语言', '结构', '书写', '词数', '硬性扣分', '核心问题', '改进建议', '复核状态'];
    const rows = [head.map(csvCell).join(',')];
    b.essays.forEach((e) => {
      const r = e.review && e.review.confirmed ? e.review : e.ai;
      const empty = isEmptyResult(r);
      const sc = (r && r.score !== undefined && !empty) ? r.score : '';
      const dim = (r && !empty && r.dimensions) || {};
      const idt = e.identity || {};
      rows.push([
        e.no + ' 号',
        idt.name || '',
        sc,
        (!empty && r && r.tier) || '',
        dim.content !== undefined ? dim.content : '',
        dim.language !== undefined ? dim.language : '',
        dim.structure !== undefined ? dim.structure : '',
        dim.handwriting !== undefined ? dim.handwriting : '',
        (!empty && r && r.wordCount) || '',
        (!empty && r && r.deductions ? r.deductions.join('；') : ''),
        (!empty && r && r.problems ? r.problems.join('；') : ''),
        (!empty && r && r.suggestions ? r.suggestions.join('；') : ''),
        e.reviewed ? '教师已复核' : (empty ? '批改结果为空，需重批'
          : (e.status === 'done' ? '待复核' : (e.status === 'error' ? '批改失败' : '未批改')))
      ].map(csvCell).join(','));
    });
    const csv = '\uFEFF' + rows.join('\r\n');
    const name = encodeURIComponent((b.title || '作文批改') + '_' + (b.className || '') + '_成绩表.csv');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': "attachment; filename*=UTF-8''" + name
    });
    return res.end(csv);
  }

  return sendJson(res, 404, { ok: false, error: '未知接口 ' + pathname });
}

/* 自动打开浏览器：按系统选择命令，换电脑也能用 */
function openBrowser(url) {
  let cmd = '';
  if (process.platform === 'darwin') cmd = 'open "' + url + '"';
  else if (process.platform === 'win32') cmd = 'cmd /c start "" "' + url + '"';
  else cmd = 'xdg-open "' + url + '"';
  exec(cmd, function () { /* 打不开也不影响，手动访问即可 */ });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://' + HOST + ':' + PORT);
  try {
    if (u.pathname.startsWith('/api/')) {
      await handleApi(req, res, u.pathname, u.searchParams);
    } else if (u.pathname.startsWith('/uploads/')) {
      await serveUpload(req, res, u.pathname);
    } else {
      await serveStatic(req, res, u.pathname);
    }
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(err.message || err) });
    else res.end();
  }
});

function start() {
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.log('\n  端口 ' + PORT + ' 已被占用，尝试 ' + (PORT + 1) + ' …\n');
      PORT += 1;
      setTimeout(() => server.listen(PORT, HOST), 200);
    } else {
      console.error(e);
      process.exit(1);
    }
  });
  server.listen(PORT, HOST, async () => {
    console.log('\n  ┌───────────────────────────────────────────────┐');
    console.log('  │   苏州中考英语作文批改平台 · 本地服务已启动     │');
    console.log('  └───────────────────────────────────────────────┘');
    console.log('\n   访问地址： http://' + HOST + ':' + PORT);
    console.log('   数据目录： ' + DATA_DIR);
    console.log('   停止服务： 在本窗口按 Ctrl + C\n');
    if (process.argv.indexOf('--no-open') === -1) {
      openBrowser('http://' + HOST + ':' + PORT);
    }
  });
}

init().then(start).catch((e) => {
  const code = (e && e.code) || '';
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    console.error('');
    console.error('  ✗ 无法读写数据目录 —— 这是系统权限问题，不是程序出错。');
    console.error('');
    console.error('    数据目录：' + DATA_DIR);
    console.error('');
    console.error('    解决办法（任选一种）：');
    console.error('      1. 把整个「作文批改平台（Teacher_Tony）」文件夹移到个人文件夹下，再重新启动');
    console.error('         （访达 › 前往 › 个人）');
    console.error('      2. macOS：系统设置 › 隐私与安全性 › 文件与文件夹 › 终端，勾上「桌面」');
    console.error('      3. 确认文件夹不是只读：右键 › 显示简介 › 共享与权限，自己的账号要能「读与写」');
    console.error('');
  } else if (e instanceof SyntaxError) {
    console.error('');
    console.error('  ✗ 数据文件损坏，无法解析。');
    console.error('');
    console.error('    位置：' + DATA_DIR);
    console.error('    处理：把 data 目录先改名备份（例如改成 data_bak），重新启动会生成一份空数据，');
    console.error('          再从备份里把 db.json / students.json 手动恢复。');
    console.error('');
  } else {
    console.error('初始化失败：', e);
  }
  process.exit(1);
});
