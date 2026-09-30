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
/* 数据快照目录：db.json / students.json 的定时与关键操作前备份 */
const BACKUP_DIR = path.join(DATA_DIR, 'backup');
const KEEP_BACKUPS = 10;

let PORT = Number(process.env.PORT || 8787);
const HOST = '127.0.0.1';

/* 本次运行中发生过的数据自愈（供前端提示教师，不写入任何数据文件） */
const recoveryLog = [];

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

【先定位作文，再批改】
- 照片往往是一整张答题卡：上面有听力、单选、完形、阅读等题目，作文（书面表达）通常在最后一页的大片空白区，带有题目 / 要点说明，学生写在说明下方。
- 先找到「书面表达 / Writing / 作文」这一部分，只批改这部分里学生自己写的内容。阅读文章、题干、其它题目的答案都不是学生作文，不要转录、也不要当成作文来评分。
- 转录（transcription）只录学生作文正文，不含题目、要点说明等印刷文字；找不到作文内容就如实说明，不要拿其它题目答案充数。

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

【得分口径 · 必须自洽】
- 最终得分只有唯一来源：四维得分之和，即 score ＝ 内容 ＋ 语言 ＋ 结构 ＋ 书写。
- 所有扣分都落进相应维度里扣，不要先算四维之和、再从总分上单独减一次。
- 降档也落到维度分上：例如缺 1 个核心要点降一档，就把内容分（必要时连带语言分）降到对应档位区间。
- 交卷前自检一遍：四个维度相加，必须正好等于你给出的 score。不相等就改到相等为止。

【词数与要点】
- 词数要求 80–120 词，最佳 100 词左右
- 核心要点数量不固定，必须全覆盖

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

【抄袭与照抄】
- 照抄「作文题目 / 题干 / 要点说明」里的句子 → 该部分**不得分**，plagiarism.verdict 标 copied（kind = 抄题目）。
- 照抄试卷阅读语篇或其他题目原文 → 该部分**不得分**；整篇照抄直接按最低档处理，plagiarism.verdict 标 copied（kind = 抄阅读原文）。
- 与阅读语篇、题干大段雷同，或明显是背诵模板、与参考范文高度重合，但**不能百分百确定**是照抄 → 不要直接清零，plagiarism.verdict 标 suspect，写一句 note 说明疑点，交给教师人工判断。
- 没有抄袭迹象 → plagiarism.verdict 标 clean。
- 抄袭结论只用于评分和供教师核对，**严禁写进 comment / problems / suggestions 等任何面向学生的文字里**，也不要在评语里提「抄袭」二字。

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

【逐句纠错】
- 每条单独列一项：text 原文错误片段（尽量照抄原文，找不到完整短语就写那个词）、fix 正确写法（没有改动就留空）、type 错误类型（语法 / 时态 / 主谓一致 / 冠词 / 介词 / 拼写 / 标点 / 大小写 / 书信格式）、note 一句面向学生的简短说明。
- 只标真实存在的错误，原文里没有的不要凭空加；同一处错误只标一次，不重复。
- **三档及以上（≥ 11 分）**：把作文里所有语言错误逐条标注出来，一条都不能漏。
- **四档及以下（< 11 分）**：只做「部分标注」——挑最典型、最影响理解、最能代表这篇水平的 3–5 处大错来标（优先语法大错、时态、主谓一致），不要面面俱到、不要逐字逐句。

【卷面学生信息与作文标识】
- 学生信息不一定在卷首：有的答题卡横排在卷首的「姓名 / 班级 / 考号」栏里，有的则整行旋转 90°、竖排印在**左侧装订线、页边或页脚**，标注为「班级 / 姓名 / 考场 / 座次 / 座位号」。请把四条边都扫一遍，遇到旋转的文字在脑中把它转正再读；找不到就留空。
- 如实提取卷面上学生自己写出的信息：姓名、班级、考号 / 学号 / 座位号（seatNo 填这三者中卷面写了的那一个；只写了「考场」的，seatNo 留空）。**没写就返回空字符串，绝对不要猜测、不要编造、不要根据字迹推断；识别不清的位置宁可留空，也不要填错。**
- 本条消息里教师提供的班级等信息属于后台资料，**不是卷面内容，不得填进 studentInfo**。
- 作文正文里出现的名字不要当学生信息。
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
  "score": 与四维之和完全相等的整数（0 到 25）,
  "tier": "一档（优秀）或 二档（良好）或 三档（合格）或 四档（较差）或 五档（极差）",
  "dimensions": { "content": 0-10, "language": 0-10, "structure": 0-3, "handwriting": 0-2 },
  "pointsDetail": [
    { "point": "要点原文", "covered": true 或 false, "note": "覆盖情况说明，如：写了名称但没写来历" }
  ],
  "deductions": ["硬性扣分项，如：词数 76 词 −2 分"],
  "problems": ["2–4 条核心问题，优先标注漏要点、语法大错、格式错误"],
  "suggestions": ["2–4 条针对性改进建议"],
  "errors": [
    { "text": "原文错误片段", "fix": "正确写法", "type": "错误类型", "note": "一句话说明" }
  ],
  "plagiarism": {
    "verdict": "clean / copied / suspect",
    "kind": "抄题目 / 抄阅读原文 / 模板背诵 / 与范文雷同 / 空字符串",
    "note": "一句说明（供教师判断），无则空字符串"
  },
  "comment": "面向学生的综合评语，120 字以内，通俗易懂"
}

【撰写范文的要求】（仅当用户要求增加 modelEssay 字段时）
贴合学生现有能力撰写全文范文，符合中考词数、要点、三段式要求，词汇句式贴合译林版教材及 2022 版课标，不使用超纲词汇句式，不编写远超学生能力的满分范文。`;

/* 题目识别用的提示词（与阅卷提示词分开，互不影响） */
const QUESTION_PROMPT = `你是协助初三英语教师录入备课资料的助手。老师会给你一张试卷上「书面表达 / 作文题」部分的照片，你需要把题目信息准确提取出来，用于建立作文批改任务。
照片可能是一整页甚至整张试卷：请先定位「书面表达 / Writing / 作文」部分，只提取这部分；听力、单选、完形、阅读等其它题目和语篇都不属于作文题，不要误当成题目或要点。

【提取要求】
1. 完整识别题目原文，不要改写、不要翻译成中文后替换原文。
2. 找出本题的**写作要点**。要点是题目明确要求学生写的内容条目，常见形式：
   - 表格或分栏里列出的条目
   - 连词连接的要求，如 "① name and origin ② reasons and ways ③ feelings"
   - 中文提示的「请介绍……」「请说明……」「请谈谈……」等分句
   要点数量不固定（常见 2–5 个，也可能更多），**有几个就列几个**：不要为了凑 3 个而合并或漏掉，也不要把题干里不属于写作要求的内容当要点。
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

/* 卷首学生信息专用提示词：只认「学生自己写在卷面上」的姓名 / 班级 / 考号。
   和阅卷提示词分开、单独一次请求，好处是：
     ① 这一趟只干一件事，模型注意力全在小字上，比顺带识别准；
     ② 可以在前端把卷首裁出来放大后再送进来（模型看不了「局部放大」，只能我们自己裁）；
     ③ 认错名字的代价很大（会把 A 的成绩记到 B 头上），所以这里要「给候选」而不是硬猜一个。 */
const IDENTITY_PROMPT = `你要从一张初三英语作文卷面的照片里，抄录学生自己写在卷面上的身份信息：姓名、班级、考号 / 学号 / 座号。这些信息供教师在登分表里核对，抄错会把成绩记到别的学生头上，必须谨慎。

【优先看哪里】
- 最常见：卷首左上角或右上角，紧挨着作文标题上方或标题同一行，例如「九(2) 李小明 24」「九（8）班 李四 35」。姓名通常夹在班级和数字之间，或紧跟在数字前面。
- 其次是左侧装订线、右侧页边、页脚：整行旋转 90° 竖排的小字，常标注「班级 / 姓名 / 考场 / 座次 / 座位号」。遇到旋转的文字，先在脑子里转正再读。
- 四条边都扫一遍。这一趟只找身份信息，不要去读作文正文（正文里出现的 Li Hua 之类的名字不是学生信息）。

【认手写姓名的办法】
- 手写汉字连笔、潦草是常态。按「整体字形 + 偏旁轮廓 + 常见姓氏用字」判断，不要死抠每一笔。
- 姓名一般是 2–4 个汉字，第一个字多为常见姓氏（王李张刘陈杨赵黄周吴徐孙胡朱高林何郭马罗梁宋郑谢韩唐冯于董萧程曹袁邓许傅沈曾彭吕苏卢蒋蔡贾丁魏薛叶阎余潘杜戴夏钟汪田任姜范方石姚谭廖邹熊金陆郝孔白崔康毛邱秦江史顾侯邵孟万段钱汤尹黎易常武乔贺赖龚文）。
- 不确定时不要留空：把你认为最可能的写法填进 name，并把其它可能的读法按可能性排序放进 candidates（2–3 个）。宁可给出候选让老师点一下，也不要什么都不给。
- 只标了姓氏、名字实在认不出时，name 里写「李」这样的单字也可以，并在 evidence 里说明「只认出姓」。
- 反过来，卷面上确实没有姓名就留空，不要从作文正文或题目里凑一个名字出来。

【数字与班级】
- 考号 / 学号 / 座号是阿拉伯数字，通常比汉字好认，务必抄准；遇到 4 / 9、1 / 7、6 / 8 这类连笔，把你犹豫的其它读法写进 evidence。
- 有座位号就填在 seatNo；卷面只写「考场 xx」的，seatNo 留空。
- 班级照抄卷面写法（如「九(2)」「九二班」「92」「9A 2 班」），不要自己换算成别的格式。

【图片说明】
- 这条消息里可能有两张图：第 1 张是这份卷子的「卷首 + 左右边缘」放大拼图，第 2 张是整页照片；也可能只有其中一张。
- 拼图上部和下面两条都来自同一份卷子，只是被切开放大，别当成几份不同的卷子。左右两条是竖排的边缘区域，已经旋转过 90°，可能需要你在脑中转正再读。
- 只认学生自己手写的内容；老师打印的批改说明、标题、页码等印刷体不是学生信息。

【输出要求】
只输出一个 JSON 对象，不要任何解释文字，不要 markdown 代码块包裹。字段如下：
{
  "name": "卷面上学生自己写的姓名，认不出或确实没写就留空字符串",
  "className": "卷面上写的班级，没写就留空字符串",
  "seatNo": "卷面上写的考号 / 学号 / 座号（只要数字），没写就留空字符串",
  "candidates": ["其它可能的姓名读法，按可能性排序，最多 3 个；没有就空数组"],
  "evidence": "一句话说明你从哪里看到的，例如：卷首左上角、作文标题上方，姓名紧跟在「九(2)」和「24」之间",
  "found": true 或 false（是否在卷面上找到了学生自己写的身份信息）
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

/* 班级共性分析 + 下一阶段教学建议（纯文本，不传图片，成本很低） */
const CLASS_PROMPT = `你是拥有 15 年苏州高新区初三英语教学及中考阅卷经验的资深教师。下面给你一个班级某次英语作文（苏州中考 25 分制）的统计概况，你要据此写出「面向教师」的共性分析与下一阶段教学建议。

【要求】
1. 从数据里提炼全班共性问题，不要只复述数字；要指出「为什么失分」「根子在哪里」。
2. 教学建议要可落地、可执行，落到具体课型或训练方式（例如：就某类语法做 5 分钟随堂改错、就某个要点做范文拆解），不要空话。
3. 语言凝练，教师视角，不写给学生看的内容。
4. 数据里没有体现的不要编造。

【输出要求】
只输出一个 JSON 对象，不要任何解释文字，不要 markdown 代码块包裹。字段如下：
{
  "commonStrengths": ["全班做得好的地方，1–2 条，没有就空数组"],
  "commonProblems": ["全班共性问题，2–4 条，每条都要点出具体表现"],
  "guidance": ["下一阶段教学建议，3–5 条，可落地"]
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

/* 严格读：文件不存在返回 fallback；文件在、但解析不了就抛 CORRUPT_DATA。
   这条区分很重要 —— 把「文件损坏」当成「空数据」会让下一次写入把好数据彻底覆盖掉。 */
async function readJsonStrict(file, fallback) {
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    const err = new Error('数据文件已损坏：' + path.basename(file));
    err.code = 'CORRUPT_DATA';
    err.file = file;
    throw err;
  }
}

let writeQueue = Promise.resolve();

/* 原子写入：先写同目录临时文件 → fsync → rename 覆盖。
   rename 在同一分区上是原子的，所以 db.json 在任何时刻要么是旧的完整内容、
   要么是新的完整内容，不会出现写了一半的半个 JSON。
   （原来的 writeFile 直接覆盖是先清空再写：进程在写入途中被 Ctrl+C / 断电 = 整份记录全丢。） */
async function writeAtomic(file, text) {
  const tmp = file + '.tmp';
  try {
    const fh = await fsp.open(tmp, 'w');
    try {
      await fh.writeFile(text, 'utf8');
      try { await fh.sync(); } catch (_) { /* 个别文件系统不支持，不影响原子性 */ }
    } finally {
      await fh.close();
    }
    await fsp.rename(tmp, file);
  } catch (e) {
    try { await fsp.unlink(tmp); } catch (_) { /* 临时文件可能还没建起来 */ }
    throw e;
  }
}

function writeJson(file, obj) {
  const task = writeQueue.then(() => writeAtomic(file, JSON.stringify(obj, null, 2)));
  // 队列自身始终保持在 resolved 状态：一次写入失败不能把后续所有写入连带卡死
  writeQueue = task.catch(() => {});
  return task;
}

/* 全局数据事务锁：把「读数据文件 → 修改 → 写回」的整个段落串行化。
   只靠 writeJson 的写队列不够 —— 两个并发请求（双开标签页、批改进行中又点了别处）
   各自拿着各自读到的旧数据整体写回，后写的会把先写的改动覆盖掉（丢更新）。
   注意：锁不可重入，锁内不要再进 withData；AI 请求等慢操作必须放在锁外，
   只把落库前后的短段落关进锁里。 */
let dataLock = Promise.resolve();
function withData(fn) {
  const run = dataLock.then(fn);
  dataLock = run.then(() => {}, () => {});
  return run;
}

const uid = (p) => p + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);

/* ------------------------------------------------------------------ */
/* 数据快照与损坏自愈                                                   */
/* ------------------------------------------------------------------ */

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
    '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

async function listSnapshots(prefix) {
  try {
    const names = await fsp.readdir(BACKUP_DIR);
    return names.filter((n) => n.startsWith(prefix + '-') && n.endsWith('.json')).sort().reverse();
  } catch (e) {
    return [];
  }
}

/* 存一份快照。文件本身已损坏就不存（交给自愈流程）。
   daily=true 时当天已有快照就跳过，避免反复启动堆文件。 */
async function snapshot(file, prefix, opts) {
  let raw;
  try { raw = await fsp.readFile(file, 'utf8'); } catch (e) { return null; }
  try { JSON.parse(raw); } catch (e) { return null; }
  await fsp.mkdir(BACKUP_DIR, { recursive: true });
  const now = new Date();
  if (opts && opts.daily) {
    const day = stamp(now).slice(0, 8);
    const names = await listSnapshots(prefix);
    if (names.some((n) => n.startsWith(prefix + '-' + day))) return null;
  }
  // 文件名带序号：同一秒内连留两份（例如刚启动就删批次）也不会互相覆盖，
  // 序号补零是让「按文件名倒序」= 「按时间倒序」，恢复时取到的就是最新的那份。
  const base = prefix + '-' + stamp(now);
  let name = base + '-01.json';
  for (let n = 2; fs.existsSync(path.join(BACKUP_DIR, name)); n++) {
    name = base + '-' + String(n).padStart(2, '0') + '.json';
  }
  await fsp.writeFile(path.join(BACKUP_DIR, name), raw, 'utf8');
  const all = await listSnapshots(prefix);
  for (const old of all.slice(KEEP_BACKUPS)) {
    try { await fsp.unlink(path.join(BACKUP_DIR, old)); } catch (_) { /* 忽略 */ }
  }
  return name;
}

/* 快照是保险，不该成为阻碍：留不成也照常往下走，只在终端提一句 */
async function safeSnapshot(file, prefix, opts) {
  try {
    return await snapshot(file, prefix, opts);
  } catch (e) {
    console.warn('  快照未能写入（不影响继续使用）：' + (e && e.message ? e.message : e));
    return null;
  }
}

/* 从最近的快照恢复损坏的数据文件；坏文件留档为 xxx.corrupt-时间.json 备查 */
async function restoreFromSnapshot(file, prefix) {
  for (const name of await listSnapshots(prefix)) {
    let obj;
    try { obj = JSON.parse(await fsp.readFile(path.join(BACKUP_DIR, name), 'utf8')); }
    catch (e) { continue; }
    const bad = file + '.corrupt-' + stamp(new Date()) + '.json';
    try { await fsp.rename(file, bad); } catch (e) { /* 挪不动也继续恢复 */ }
    await writeJson(file, obj);
    return { file: path.basename(file), from: name, corrupt: path.basename(bad), at: new Date().toISOString() };
  }
  return null;
}

/* 读数据文件；损坏就自动回退快照，没有可用快照就明确报错，绝不当空数据往下跑 */
async function loadHealed(file, prefix, fallback) {
  try {
    return await readJsonStrict(file, fallback);
  } catch (e) {
    if (e.code !== 'CORRUPT_DATA') throw e;
    const rec = await restoreFromSnapshot(file, prefix);
    if (!rec) throw e;
    recoveryLog.push(rec);
    return await readJsonStrict(file, fallback);
  }
}

async function loadDb() {
  const db = await loadHealed(DB_FILE, 'db', { batches: [] });
  if (!db || typeof db !== 'object' || Array.isArray(db)) return { batches: [] };
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
  const s = await loadHealed(STUDENTS_FILE, 'students', { students: [] });
  if (!s || typeof s !== 'object' || Array.isArray(s)) return { students: [] };
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

/* 从上传文件名里取姓名：老师一般把答题卡按「编号_姓名.jpg」命名（如 01_李小明.jpg）。
   这是教师自己排好的名单，比让模型去认卷面上旋转的小字可靠，所以拿它当姓名的兜底。
   只认「文件名结尾是 2–4 个汉字」的情况，其它命名（IMG_1234.jpg、扫描件001.jpg）一律忽略。 */
const NOT_A_NAME = /答题卡|扫描|扫描件|试卷|作文|原卷|原件|副本|学生|练习|模拟|英语|答案/;
function nameFromFileName(name) {
  const base = String(name || '').replace(/\.[A-Za-z0-9]+$/, '').trim();
  // 前缀只允许「字母数字 + 分隔符」或什么都不写，避免把「李小明」这种纯姓名截成「小明」
  const m = base.match(/^(?:[0-9A-Za-z]+[_\-\s]*)?([\u4e00-\u9fa5]{2,4})$/);
  if (!m) return '';
  const cand = m[1];
  if (NOT_A_NAME.test(cand)) return '';
  return cand;
}

/* 找出或建立该篇作文对应的学生档案，返回学生 id（无姓名时返回 ''） */
async function resolveStudent(batch, identity) {
  const name = (identity && identity.name) || '';
  if (!name.trim()) return '';
  // 班级只认这一篇自己记着的（卷面识别 / 教师填写），不拿批次默认班级顶替：
  // 一个批次里混了几个班的卷子时，批次班级不代表这个学生。
  const className = ((identity && identity.className) || '').trim();
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
      const className = (idt.className || '').trim();   // 同 resolveStudent：不拿批次班级顶替
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
  await fsp.mkdir(BACKUP_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) await fsp.writeFile(DB_FILE, JSON.stringify({ batches: [] }, null, 2), 'utf8');
  if (!fs.existsSync(SETTINGS_FILE)) {
    const s = Object.assign({}, DEFAULT_SETTINGS, { prompt: DEFAULT_PROMPT });
    await fsp.writeFile(SETTINGS_FILE, JSON.stringify(s, null, 2), 'utf8');
  }
  if (!fs.existsSync(PROMPT_FILE)) await fsp.writeFile(PROMPT_FILE, DEFAULT_PROMPT, 'utf8');
  if (!fs.existsSync(STUDENTS_FILE)) await fsp.writeFile(STUDENTS_FILE, JSON.stringify({ students: [] }, null, 2), 'utf8');

  // 数据体检：损坏就从最近快照自动恢复（没有快照会在这里明确报错，不会当成空数据往下跑）。
  // 体检通过后再留一份当天快照，作为下一次损坏的恢复点。
  await loadDb();
  await loadStudents();
  await safeSnapshot(ROSTERS_FILE, 'rosters', { daily: true });
  await safeSnapshot(DB_FILE, 'db', { daily: true });
  await safeSnapshot(STUDENTS_FILE, 'students', { daily: true });

  // 上次运行中途断电 / 强退时，可能有作文永远停在「批改中」——前端会一直转圈，
  // 「重批未成功的作文」也不收这种状态。启动时统一复位成失败，让老师能一键重批。
  const stuck = await withData(async function () {
    const db = await loadDb();
    let n = 0;
    db.batches.forEach(function (b) {
      b.essays.forEach(function (e) {
        if (e.status === 'grading') {
          e.status = 'error';
          e.aiError = '上次批改被中断（服务中途停止），请重新批改这一篇。';
          n++;
        }
      });
    });
    if (n) await writeJson(DB_FILE, db);
    return n;
  });
  if (stuck) console.warn('  已把 ' + stuck + ' 篇中断在「批改中」的作文复位为待重批状态');

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
  await withData(async function () {
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
  });
}

/* ------------------------------------------------------------------ */
/* 班级名单：用来核定卷面上那行潦草的小字                                */
/* ------------------------------------------------------------------ */
/* 为什么需要名单：学生手写的姓名常常连笔，模型认不准、甚至干脆不敢认；
   但紧挨着的考号 / 学号是阿拉伯数字，好认得多。认到数字 + 同班名单，
   姓名就唯一确定了 —— 这是手写姓名最可靠的一条路。 */

const ROSTERS_FILE = path.join(DATA_DIR, 'rosters.json');

/* 班级的宽松归一：九(2)班 / 九2班 / 92 / 九二班 都算同一个班 */
const CN_DIGIT = { '一': '1', '二': '2', '三': '3', '四': '4', '五': '5', '六': '6', '七': '7', '八': '8', '九': '9', '零': '0' };
function classKey(s) {
  return normKey(s)
    .replace(/[一二三四五六七八九零]/g, function (c) { return CN_DIGIT[c]; })
    .replace(/[班别]/g, '');
}

async function loadRosters() {
  /* 与 db / students 一样严格读取：文件损坏时从快照恢复并留档坏文件，
     而不是当成「还没有名单」—— 那样下一次保存会把坏文件覆盖掉，名单就真丢了 */
  const r = await loadHealed(ROSTERS_FILE, 'rosters', { classes: [] });
  if (!r || typeof r !== 'object' || Array.isArray(r) || !Array.isArray(r.classes)) return { classes: [] };
  r.classes.forEach(function (c) {
    if (!Array.isArray(c.students)) c.students = [];
  });
  return r;
}

/* 把教师粘贴的名单解析成 [{ seatNo, name }]。容错各种贴法：
     「24 李小明」「李小明 24」「24,李小明」「李小明」
     「| 12 | 24 | 李小明 | 334.0 | 89.0 |」（直接从成绩表里复制一整行）
   规则：行里最后一个 2–4 字的汉字段当姓名，离它最近的那个数字当考号 / 学号。 */
function parseRosterText(text) {
  const out = [];
  const byName = {};
  /* 一个词是不是「考号 / 学号」：纯数字（可带「号」字）才算；分数 334.0 这种带小数的不算。
     顺便标出「像座位号」的（1–60），用来在「序号 学号 姓名 总分」这种多列表格里挑对那一列。 */
  const asSeat = function (v) {
    const m = /^(\d{1,4})号?$/.exec(String(v || '').trim());
    if (!m) return null;
    const n = Number(m[1]);
    return { seat: m[1], plausible: n >= 1 && n <= 60 };
  };
  String(text || '').split(/\r?\n/).forEach(function (line) {
    const s = String(line).replace(/[|｜*]/g, ' ').replace(/\.\s/g, '. ').trim();
    if (!s) return;
    const tokens = s.split(/[\s,，、;；\t]+/).filter(Boolean);
    let nameIdx = -1;
    // 只在前 3 列里找姓名：贴过来的多半是「学号 姓名」「序号 学号 姓名」「姓名 学号」，
    // 姓名总在前几列；这样右边的备注（「物理偏弱」「总分垫底」）就不会被当成名字。
    for (let i = 0; i < tokens.length && i < 3; i++) {
      const t = tokens[i];
      if (!/^[\u4e00-\u9fa5·]{2,4}$/.test(t)) continue;
      if (NOT_A_NAME.test(t)) continue;
      if (/^(姓名|学号|考号|班级|座号|座位|序号|总分|性别)$/.test(t)) continue;
      nameIdx = i;
    }
    if (nameIdx < 0) return;
    const name = tokens[nameIdx];
    let seat = '', fallback = '';
    for (let d = 1; d <= 2 && !seat; d++) {
      // 同一个距离上先看右边再看左边：「李小明 24」和「24 李小明」两种写法都要认；
      // 成绩表里右边常跟着分数（334.0 或 > 60），会被 plausible 挡掉，于是落到左边的 24。
      [tokens[nameIdx + d], tokens[nameIdx - d]].forEach(function (tk) {
        const p = asSeat(tk);
        if (!p) return;
        if (p.plausible && !seat) seat = p.seat;
        else if (!fallback && !p.plausible) fallback = p.seat;
      });
    }
    if (!seat) seat = fallback;
    // 同一个人被贴了两遍只留一条；带考号的那条优先（「李小明 24」比光一个姓名有用）
    const exist = byName[name];
    if (exist) {
      if (!exist.seatNo && seat) exist.seatNo = seat;
      return;
    }
    const item = { seatNo: seat, name: name };
    byName[name] = item;
    out.push(item);
  });
  return out;
}

function digitsOf(v) { return String(v === undefined || v === null ? '' : v).replace(/[^\d]/g, ''); }

function rosterOf(store, className) {
  const k = classKey(className);
  if (!k) return null;
  return store.classes.find(function (c) { return classKey(c.className) === k; }) || null;
}

/* 两个姓名的相似度：最长公共子序列 ÷ 较长名字长度。
   「李小明 / 李小华」这类只错一两个字的，得分落在 0.3–0.7 之间，正好用来排序候选。 */
function nameSimilarity(a, b) {
  a = String(a || '').trim();
  b = String(b || '').trim();
  if (!a || !b) return 0;
  if (a === b) return 1;
  const m = a.length, n = b.length;
  const dp = [];
  for (let i = 0; i <= m; i++) dp.push(new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n] / Math.max(m, n);
}

function normalizeIdentity(d) {
  const str = function (v) { return String(v === undefined || v === null ? '' : v).trim(); };
  const cands = [];
  const push = function (v) {
    const s = str(v).replace(/[()（）]/g, '');
    if (s && /^[\u4e00-\u9fa5·]{1,5}$/.test(s) && cands.indexOf(s) === -1) cands.push(s);
  };
  if (Array.isArray(d && d.candidates)) (d.candidates || []).forEach(push);
  else push(d && d.candidates);
  return {
    name: str(d && (d.name || d.studentName || d.student)).replace(/[()（）]/g, ''),
    className: str(d && (d.className || d.class || d.gradeClass || d.classRoom)),
    seatNo: digitsOf(d && (d.seatNo || d.seat || d.examNo || d.studentNo || d.number)).slice(0, 8),
    candidates: cands.slice(0, 3),
    evidence: str(d && (d.evidence || d.note || d.where)),
    found: !!(d && d.found)
  };
}

/* 拿名单核对识别结果，返回 { name, className, seatNo, matchedBy, rosterName, candidates, note }
   matchedBy: seat = 考号命中（最可靠）；name = 姓名与名单高度相似；conflict = 考号与姓名互相矛盾，请老师点 */
function reconcileWithRoster(store, className, read) {
  const seat = digitsOf(read.seatNo);
  const name = String(read.name || '').trim();
  const res = {
    name: name,
    className: String(read.className || '').trim(),
    seatNo: seat,
    matchedBy: '',
    rosterName: '',
    candidates: [],
    note: '',
    evidence: String(read.evidence || '').trim()
  };
  const pushCand = function (nm, st, from, score) {
    nm = String(nm || '').trim();
    if (!nm) return;
    if (res.candidates.some(function (c) { return c.name === nm; })) return;
    res.candidates.push({ name: nm, seatNo: String(st || ''), from: from, score: score });
  };

  let cls = rosterOf(store, res.className || className);
  if (!cls && seat) {
    // 班级没认出来时，用考号跨班找，全班只命中一个才敢用
    const hits = store.classes.filter(function (c) {
      return c.students.some(function (s) { return digitsOf(s.seatNo) === seat; });
    });
    if (hits.length === 1) cls = hits[0];
  }

  if (cls) {
    if (!res.className) res.className = cls.className;
    const bySeat = seat ? cls.students.find(function (s) { return digitsOf(s.seatNo) === seat; }) : null;
    let rival = null, rivalScore = 0;
    if (name) {
      cls.students.forEach(function (s) {
        const sc = nameSimilarity(s.name, name);
        if (sc > rivalScore) { rivalScore = sc; rival = s; }
      });
    }
    if (bySeat) {
      // 考号指向 A，但认出来的字更像 B —— 两边都摆出来让老师点一下，别自作主张
      if (rival && rival.name !== bySeat.name && rivalScore >= 0.66) {
        res.matchedBy = 'conflict';
        res.rosterName = bySeat.name;
        res.note = '考号 ' + seat + ' 号在名单里是「' + bySeat.name + '」，但认出的字更像「' + rival.name + '」，请核对';
        pushCand(bySeat.name, bySeat.seatNo, 'roster', 1);
        pushCand(rival.name, rival.seatNo, 'roster', Math.round(rivalScore * 100) / 100);
      } else {
        res.matchedBy = 'seat';
        res.rosterName = bySeat.name;
      }
    } else if (seat) {
      res.note = '班级名单里没有 ' + seat + ' 号 —— 名单可能是别的班的，或者这个学生换了学号';
    }
    if (!res.rosterName && rival && rivalScore >= 0.66) {
      res.matchedBy = 'name';
      res.rosterName = rival.name;
    }
    if (name) {
      cls.students
        .map(function (s) { return { s: s, sc: nameSimilarity(s.name, name) }; })
        .filter(function (x) { return x.sc >= 0.32; })
        .sort(function (a, b) { return b.sc - a.sc; })
        .slice(0, 3)
        .forEach(function (x) { pushCand(x.s.name, x.s.seatNo, 'roster', Math.round(x.sc * 100) / 100); });
    }
  } else if (seat || name) {
    res.note = '还没有「' + (res.className || className || '这个班') + '」的名单，识别结果没有名单可核对';
  }

  (read.candidates || []).forEach(function (c) { pushCand(c, '', 'ai', 0); });
  res.candidates = res.candidates.slice(0, 4);
  return res;
}

/* 把识别/核对结果并进作文记录。
   cur.source === 'manual'（教师手填过）时一律不动，除非教师自己点了「识别姓名」重跑（force）。 */
function mergeIdentityPatch(cur, patch, force) {
  cur = cur || {};
  const has = function (v) { return !!String(v === undefined || v === null ? '' : v).trim(); };
  if (cur.source === 'manual' && !force) return null;
  // 名单核定的姓名优先（考号/学号是数字，最不容易认错）；冲突时也先按考号定，把另一种读法留作候选并给出提示
  const rosterName = patch.matchedBy && has(patch.rosterName) ? patch.rosterName : '';
  let name;
  if (force) name = has(rosterName) ? rosterName : (has(patch.name) ? patch.name : cur.name);
  else if (has(rosterName)) name = rosterName;
  else name = has(cur.name) ? cur.name : patch.name;
  const nameOut = String(name || '');
  const classOut = String((force ? (has(patch.className) ? patch.className : cur.className)
    : (has(cur.className) ? cur.className : patch.className)) || '');
  const seatOut = String((force ? (has(patch.seatNo) ? patch.seatNo : cur.seatNo)
    : (has(cur.seatNo) ? cur.seatNo : patch.seatNo)) || '');
  let source = cur.source || 'none';
  if (has(rosterName) && nameOut === rosterName) source = 'roster';
  else if (!has(cur.name) && has(nameOut)) source = 'ai';
  const identity = {
    name: nameOut, className: classOut, seatNo: seatOut, source: source,
    updatedAt: new Date().toISOString()
  };
  const changed = nameOut !== String(cur.name || '') || classOut !== String(cur.className || '') ||
    seatOut !== String(cur.seatNo || '') || source !== (cur.source || 'none');
  return { identity: identity, changed: changed };
}

/* 读图 → 认身份 → 名单核对，返回 { ok, read, merged }。不写盘，由调用方决定怎么落库。 */
async function readEssayIdentity(settings, batch, essay) {
  const images = [];
  const add = async function (file, mime) {
    if (!file) return;
    try {
      images.push({ buf: await fsp.readFile(path.join(UPLOAD_DIR, file)), mime: mime || 'image/jpeg' });
    } catch (e) { /* 文件不在就当没有 */ }
  };
  // 优先用上传时裁好的「卷首 + 边缘放大图」：同样一次请求，小字看得清得多
  if (essay.identityShot) await add(essay.identityShot, 'image/jpeg');
  await add(essay.file, essay.mime);
  if (!images.length) return { ok: false, error: '找不到这一篇的作文照片，无法识别姓名' };

  const r = await askWithImages(settings, IDENTITY_PROMPT,
    '请识别图片上学生自己写的身份信息（姓名 / 班级 / 考号），只返回 JSON。',
    images,
    function (d) {
      return !!(d && typeof d === 'object' &&
        (d.name || d.className || d.seatNo || d.found !== undefined ||
          (Array.isArray(d.candidates) && d.candidates.length)));
    });
  if (!r.ok) return { ok: false, error: r.reason, raw: r.raw };

  const read = normalizeIdentity(r.data);
  const store = await loadRosters();
  const cur = essay.identity || {};
  const merged = reconcileWithRoster(store, read.className || cur.className || (batch && batch.className) || '', read);
  return { ok: true, read: read, merged: merged, hadShot: !!essay.identityShot };
}

/* 把一次识别结果落到作文记录上，返回可给前端展示的说明 */
function applyIdentityScan(essay, merged, read, force) {
  const patch = mergeIdentityPatch(essay.identity, merged, force);
  if (patch) essay.identity = patch.identity;
  const idt = essay.identity || {};
  const finalName = String(idt.name || '').trim();
  const cands = (merged.candidates || []).filter(function (c) { return c.name !== finalName; });
  essay.nameCandidates = cands;
  essay.idScan = {
    at: new Date().toISOString(),
    read: { name: read.name, className: read.className, seatNo: read.seatNo },
    matchedBy: merged.matchedBy || '',
    note: merged.note || '',
    evidence: merged.evidence || ''
  };
  return { identity: idt, candidates: cands, scan: essay.idScan };
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
  // 这一行是教师后台填的班级，不是卷面上写的内容。
  // 必须写明「不得回填」，否则模型会把它当成「卷面识别到的班级」原样塞进 studentInfo。
  if (batch.className) {
    t += '本批次班级（教师后台填写，仅供你了解背景；这不是卷面内容，绝对不要填进 studentInfo）：' + batch.className + '\n';
  }
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

/* 归一化「逐句纠错」：模型返回的 errors 数组里每个元素是 {text,fix,type,note}，
   也可能是简单字符串。这里把各种写法都收拢成统一结构。 */
function normalizeErrors(v) {
  if (!Array.isArray(v)) return [];
  return v.map(function (e) {
    if (typeof e === 'string') {
      const s = String(e).trim();
      return s ? { text: s, fix: '', type: '', note: '' } : null;
    }
    const text = String((e && (e.text || e.original || e.wrong || e.src)) || '').trim();
    if (!text) return null;
    return {
      text: text,
      fix: String((e && (e.fix || e.correct || e.right)) || '').trim(),
      type: String((e && e.type) || '').trim(),
      note: String((e && (e.note || e.explain || e.detail)) || '').trim()
    };
  }).filter(Boolean);
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

  // 逐句纠错：三档及以上全标；四档及以下只保留最典型的几处（部分标注，最多 5 条兜底）
  const rawErrors = normalizeErrors(r && r.errors);
  out.errors = out.score >= 11 ? rawErrors : rawErrors.slice(0, 5);

  // 抄袭判定：只供教师核对，不进任何面向学生的文字
  const pl = (r && r.plagiarism) || {};
  const verdict = String(pl.verdict || '').trim() || 'clean';
  out.plagiarism = {
    verdict: ['clean', 'copied', 'suspect'].indexOf(verdict) !== -1 ? verdict : 'clean',
    kind: String(pl.kind || '').trim(),
    note: String(pl.note || '').trim()
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

/* 得分口径自洽：四维之和应当等于总分。
   实测模型偶尔先算四维之和、再把硬性扣分从总分里减一次，
   于是出现「内容6＋语言5＋结构1＋书写1＝13，总分却写 12」这种学生一眼能看出的矛盾。
   平台不擅自改分（成绩以教师复核为准），只把差额算出来显式标给教师看。 */
const DIM_KEYS = ['content', 'language', 'structure', 'handwriting'];

function dimensionTotal(r) {
  const d = (r && r.dimensions) || {};
  let sum = 0, has = false;
  DIM_KEYS.forEach(function (k) {
    const v = Number(d[k]);
    if (isFinite(v)) { sum += v; has = true; }
  });
  return has ? Math.round(sum * 10) / 10 : null;
}

/* 总分 − 四维合计；等于 0 表示口径自洽 */
function scoreGapOf(r) {
  const total = dimensionTotal(r);
  if (total === null || !r || r.score === undefined || r.score === null) return 0;
  return Math.round((Number(r.score) - total) * 10) / 10;
}

/* images：[{ buf, mime }] 或单个 Buffer。可以是多张图（同一份卷子的卷首 / 边缘局部），
   要求接口按顺序把它们都放进同一条 user 消息，提示词里按「第 1 张、第 2 张」指代。 */
async function requestOnce(settings, systemPrompt, userText, images, useJson) {
  const list = (Array.isArray(images) ? images : [images]).filter(function (im) { return im && im.buf; });
  const parts = [{ type: 'text', text: userText }];
  list.forEach(function (im) {
    parts.push({
      type: 'image_url',
      image_url: { url: 'data:' + (im.mime || 'image/jpeg') + ';base64,' + im.buf.toString('base64') }
    });
  });
  const body = {
    model: settings.model,
    max_tokens: Number(settings.maxTokens) > 0 ? Number(settings.maxTokens) : 8192,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: parts }
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
  const timeoutSec = Number(settings.timeout) > 0 ? Number(settings.timeout) : 180;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);

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
    // 超时中断在 fetch 里只是一个含糊的 AbortError，必须单独点明是超时，
    // 否则老师会照着「检查接口地址与网络」去排查一个根本不存在的问题
    if (e && e.name === 'AbortError') {
      const err = new Error('请求超时：模型在 ' + timeoutSec + ' 秒内没有返回。可到「设置」把「超时（秒）」调大，或换一个更快的模型后重试');
      err.isTimeout = true;
      throw err;
    }
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
   validate 用于判断「解析成功但内容无效」的情况（模型返回空模板），这类也算失败。
   images 可以是 [{ buf, mime }] 多张图，也可以是单个 Buffer + mime。 */
async function askWithImages(settings, systemPrompt, userText, images, validate) {
  const ok = validate || function () { return true; };
  let r;
  let firstError = null;
  try {
    r = await requestOnce(settings, systemPrompt, userText, images, !!settings.forceJson);
  } catch (e) {
    // 第一次就网络失败 / 超时：记下来继续走重试。
    // 批量批改几十篇时，瞬时网络抖动是最常见的失败，不重试等于整篇白跑一趟。
    firstError = e;
    r = { parsed: null, raw: '', finish: '' };
  }
  if (r.parsed && ok(r.parsed)) return { ok: true, data: r.parsed };

  const firstRaw = r.raw;
  const firstFinish = r.finish;
  const firstParsed = r.parsed;

  let retried = false;
  if (!firstError || !firstError.isTimeout) {
    // 超时不重试：同一张图再等一轮超时，只会把整批的时间拖长一倍
    try {
      const r2 = await requestOnce(settings, systemPrompt, userText, images, !settings.forceJson);
      retried = true;
      if (r2.parsed && ok(r2.parsed)) return { ok: true, data: r2.parsed };
      r = r2;
    } catch (e) {
      // 第二次失败时保留第一次的信息
    }
  }

  let reason = 'AI 未返回标准 JSON';
  if (firstError) reason = String(firstError.message || firstError);
  else if (firstParsed && !ok(firstParsed)) reason = '模型返回了空结果（没有任何识别文本或评语）';
  else if (!firstRaw.trim()) reason = '模型返回了空内容';
  if (firstFinish === 'length') {
    reason = '输出被长度限制截断。' + (settings.thinking === 'on'
      ? '当前开启了思考模式，思维链会占用输出额度，建议把 max_tokens 调到 16384 以上，或把思考模式改为「关闭」'
      : '可到「设置」把 max_tokens 调大');
  }
  return {
    ok: false,
    reason: reason + (retried ? '（已自动重试 1 次）' : ''),
    raw: String(r.raw || firstRaw || '').slice(0, 3000)
  };
}

async function askWithImage(settings, systemPrompt, userText, buf, mime, validate) {
  return askWithImages(settings, systemPrompt, userText, [{ buf: buf, mime: mime }], validate);
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

/* ---------------- 班级共性分析（纯文本，成本低） ---------------- */

function buildClassUserText(batch) {
  const scored = (batch.essays || []).map(function (e) { return { e: e, r: eff(e) }; })
    .filter(function (x) { return x.r && x.r.score !== undefined && !isEmptyResult(x.r); });
  const n = scored.length;
  let t = '作文题目：' + (batch.title || '（未填写）') + '\n';
  const pts = (batch.points || []).filter(Boolean);
  if (pts.length) {
    t += '核心要点：\n';
    pts.forEach(function (p, i) { t += (i + 1) + '. ' + p + '\n'; });
  }
  if (!n) { t += '\n全班概况：还没有批改结果。\n'; return t; }

  const scores = scored.map(function (x) { return x.r.score; });
  const avg = Math.round(scores.reduce(function (a, c) { return a + c; }, 0) / n * 10) / 10;
  t += '\n全班概况：\n';
  t += '- 已批改 ' + n + ' 篇，平均 ' + avg + ' 分，最高 ' + Math.max.apply(null, scores) +
    '，最低 ' + Math.min.apply(null, scores) + '\n';
  const buckets = [0, 0, 0, 0, 0];
  scores.forEach(function (s) { if (s >= 21) buckets[0]++; else if (s >= 16) buckets[1]++; else if (s >= 11) buckets[2]++; else if (s >= 6) buckets[3]++; else buckets[4]++; });
  t += '- 档次分布：一档 ' + buckets[0] + '，二档 ' + buckets[1] + '，三档 ' + buckets[2] +
    '，四档 ' + buckets[3] + '，五档 ' + buckets[4] + '\n';
  const dim = { content: 0, language: 0, structure: 0, handwriting: 0 };
  scored.forEach(function (x) {
    const d = x.r.dimensions || {};
    ['content', 'language', 'structure', 'handwriting'].forEach(function (k) { dim[k] += Number(d[k]) || 0; });
  });
  const r1 = function (v) { return Math.round(v / n * 10) / 10; };
  t += '- 四维平均：内容 ' + r1(dim.content) + '/10，语言 ' + r1(dim.language) + '/10，结构 ' +
    r1(dim.structure) + '/3，书写 ' + r1(dim.handwriting) + '/2\n';

  if (pts.length) {
    const lines = [];
    pts.forEach(function (pt, i) {
      let miss = 0, seen = 0;
      scored.forEach(function (x) {
        const pd = x.r.pointsDetail || [];
        let p = pd[i];
        if (!p) p = pd.find(function (q) { return q.point && q.point === pt; });
        if (!p) return;
        seen++;
        if (!p.covered) miss++;
      });
      if (seen) lines.push('要点 ' + (i + 1) + '「' + pt + '」：漏写 ' + miss + '/' + seen + ' 篇');
    });
    if (lines.length) t += '\n要点覆盖：\n' + lines.map(function (l) { return '- ' + l; }).join('\n') + '\n';
  }

  const tc = {};
  scored.forEach(function (x) {
    ((x.e.ai && x.e.ai.errors) || []).forEach(function (er) {
      const ty = String((er && er.type) || '').trim() || '未分类';
      tc[ty] = (tc[ty] || 0) + 1;
    });
  });
  const topTypes = Object.keys(tc).map(function (k) { return k + ' ' + tc[k] + ' 处'; }).slice(0, 8);
  if (topTypes.length) t += '\n错误类型：\n' + topTypes.map(function (s) { return '- ' + s; }).join('\n') + '\n';

  let under = 0, over = 0;
  scored.forEach(function (x) {
    const w = x.r.wordCount;
    if (w && w < 80) under++;
    else if (w && w > 120) over++;
  });
  if (under || over) t += '\n词数：低于 80 词 ' + under + ' 篇，超出 120 词 ' + over + ' 篇\n';

  const seen = {};
  const problems = [];
  scored.forEach(function (x) {
    (x.r.problems || []).forEach(function (p) {
      const k = String(p).trim();
      if (k && !seen[k]) { seen[k] = 1; problems.push(k); }
    });
  });
  if (problems.length) {
    t += '\n各篇代表性核心问题（去重后，最多 20 条）：\n';
    problems.slice(0, 20).forEach(function (p, i) { t += (i + 1) + '. ' + p + '\n'; });
  }
  t += '\n请据此写出全班共性分析与下一阶段教学建议，只返回 JSON。';
  return t;
}

async function callTextModel(settings, systemPrompt, userText) {
  const body = {
    model: settings.model,
    max_tokens: Number(settings.maxTokens) > 0 ? Number(settings.maxTokens) : 4096,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userText }
    ]
  };
  const ds = isDeepSeek(settings.baseUrl);
  if (ds) body.thinking = { type: 'disabled' };
  if (!(ds && settings.thinking === 'on')) {
    body.temperature = typeof settings.temperature === 'number' ? settings.temperature : 0.2;
  }
  if (settings.forceJson) body.response_format = { type: 'json_object' };

  const endpoint = String(settings.baseUrl || '').replace(/\/+$/, '') + '/chat/completions';
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, (settings.timeout || 180) * 1000);
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (settings.apiKey || '') },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (e) {
    clearTimeout(timer);
    throw new Error('网络请求失败：' + (e && e.message ? e.message : e));
  }
  clearTimeout(timer);
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text).error?.message || text; } catch (e) { /* ignore */ }
    throw new Error('接口返回 ' + res.status + '：' + String(msg).slice(0, 300));
  }
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error('接口返回内容无法解析为 JSON'); }
  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  const flat = Array.isArray(content)
    ? content.map(function (c) { return typeof c === 'string' ? c : (c && c.text) || ''; }).join('')
    : content;
  const parsed = extractJson(flat);
  if (!parsed) throw new Error('模型未返回标准 JSON：' + String(flat || '').slice(0, 300));
  return parsed;
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

/* 单个学生一页的报告                                                        */
/* 目标：每名学生固定占一页。先按默认版式排版，若估算高度超出页面可用高度，  */
/* 就逐级压缩字号与段间距；仍放不下时再精简内容（少列几条、缩短评语/范文）。 */
const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

/* --- 版面计量：把段落高度换算成 twips，用来判断一页放不放得下 --- */
const PAGE_W_TW = 11906;      // A4 宽（与 buildDocx 的 pgSz 一致）
const PAGE_H_TW = 16838;      // A4 高
const MARGIN_TW = 1021;       // 上下左右页边距
const TEXT_W_TW = PAGE_W_TW - MARGIN_TW * 2;          // 正文可用宽度 9864
const AVAIL_H_TW = PAGE_H_TW - MARGIN_TW * 2;         // 正文可用高度 14796
const LINE_FACTOR = 1.4;      // 单倍行距下的行高系数（略偏大，给实际渲染留余量）
const FIT_LIMIT_TW = AVAIL_H_TW - 420;  // 排版高度阈值：再预留一行的余量，避免估算误差导致溢出第二页

/* 估算一个字符占几个 em：中文/全角按 1，ASCII 按 0.55，空格更窄 */
function charEm(ch) {
  const c = ch.codePointAt(0);
  if ((c >= 0x2E80 && c <= 0x9FFF) || (c >= 0xF900 && c <= 0xFAFF) ||
      (c >= 0x3000 && c <= 0x303F) || (c >= 0xFF00 && c <= 0xFFEF) ||
      (c >= 0x2013 && c <= 0x2014) || c === 0x00B7) return 1.0;
  if (ch === ' ') return 0.3;
  return 0.55;
}

/* 文字渲染宽度（pt）：每字符宽度 = 字宽系数 × 字号（size 为半磅） */
function textWidthPt(text, size) {
  let w = 0;
  const s = String(text === undefined || text === null ? '' : text);
  for (const ch of s) w += charEm(ch) * (size / 2);
  return w;
}

/* 单个段落占用的高度（twips）：行数 × 行高 + 段前段后间距 */
function paraHeight(widthPt, maxSizeHalfPt, o) {
  const indent = o.indent || 0;
  const availPt = (TEXT_W_TW - indent) / 20;
  const lines = Math.max(1, Math.ceil(widthPt / availPt));
  const lineH = (maxSizeHalfPt / 2) * LINE_FACTOR * 20;
  return lines * lineH + (o.before || 0) + (o.after || 0);
}

/* 按最大字数截断长文本，尽量断在空格处并补省略号 */
function clipText(s, max) {
  if (max == null || !s || s.length <= max) return s;
  let t = s.slice(0, max);
  const sp = t.lastIndexOf(' ');
  if (sp > max * 0.6) t = t.slice(0, sp);
  return t.replace(/[\s，。；、,.]+$/, '') + '…';
}

/* 默认字号（半磅）与段间距，供各级压缩样式覆盖 */
const SIZES_BASE = {
  headTitle: 24,  // 页眉标题「英语作文批改报告」
  name: 19,       // 页眉的编号/姓名
  section: 20,    // 一、二、三 各小节标题
  label: 20,      // 作文题目、得分 等标签
  score: 32,      // 分数
  tier: 22,       // 档次
  dim: 19,        // 四维度、词数
  gapNote: 18,    // 四维合计说明
  body: 19,       // 要点/纠错/问题/建议/评语正文
  model: 20,      // 范文正文
  noteHead: 19,   // 「为什么这样改 / 好词好句」小标题
  note: 18,       // 修改说明
  key: 18,        // 好词好句
  placeholder: 18 // 尚未生成范文的提示
};

function mkSize(over) { return Object.assign({}, SIZES_BASE, over); }

/* 由松到紧的排版方案：字号递减、段间距收紧，最后两级开始精简内容。
   lim 里未出现的键表示不限制。 */
const FIT_PRESETS = [
  { size: mkSize({}), after: 1.00, lim: {} },
  {
    size: mkSize({
      headTitle: 22, section: 19, label: 19, score: 30, tier: 20, dim: 17,
      gapNote: 16, body: 18, model: 19, noteHead: 18, note: 17, key: 17, placeholder: 17
    }),
    after: 0.82,
    lim: {}
  },
  {
    size: mkSize({
      headTitle: 21, section: 18, label: 18, score: 28, tier: 19, dim: 16,
      gapNote: 15, body: 17, model: 18, noteHead: 17, note: 16, key: 16, placeholder: 16
    }),
    after: 0.66,
    lim: { problems: 2, suggestions: 2, notes: 1, keys: 3 }
  },
  {
    size: mkSize({
      headTitle: 20, section: 17, label: 17, score: 26, tier: 18, dim: 15,
      gapNote: 14, body: 16, model: 17, noteHead: 16, note: 15, key: 15, placeholder: 15
    }),
    after: 0.5,
    lim: {
      problems: 2, suggestions: 2, notes: 0, keys: 0,
      errors: 3, omitPointNote: true, commentChars: 90, modelChars: 360
    }
  },
  {
    size: mkSize({
      headTitle: 20, section: 16, label: 16, score: 26, tier: 18, dim: 15,
      gapNote: 14, body: 16, model: 16, noteHead: 15, note: 15, key: 15, placeholder: 15
    }),
    after: 0.4,
    lim: {
      // 最后一档：给所有仍不受限的长字段都加上硬上限，确保一定装进一页
      titleChars: 50, points: 5, pointChars: 30,
      problems: 1, problemChars: 50, suggestions: 1, suggestionChars: 50,
      notes: 0, keys: 0, errors: 0, omitPointNote: true,
      commentChars: 60, modelChars: 180
    }
  }
];

/* 生成单个学生页；同时累计估算高度，供 fitStudentPage 判断是否放得下。
   cfg = { size: {…}, after: 段间距系数, lim: {…} } */
function buildStudentPage(batch, essay, r, essayRes, index, cfg) {
  cfg = cfg || FIT_PRESETS[0];
  const S = cfg.size;
  const lim = cfg.lim || {};
  const afterScale = cfg.after || 1;
  const d = (r && r.dimensions) || {};
  const valid = r && !isEmptyResult(r);
  const score = valid ? (r.score !== undefined ? r.score : '—') : '—';
  const tier = valid && r.tier ? r.tier : '未批改';
  const pts = (valid && r.pointsDetail) ? r.pointsDetail.slice(0, lim.points == null ? Infinity : lim.points) : [];

  let x = '';
  let est = 0;                    // 估算高度（twips）
  let sec = 0;                    // 章节号动态递增，避免出现「二、」却找不到「一、」
  const nextSec = function () { return CN_NUM[sec++] + '、'; };

  // 追加一段：既拼 XML，又累计估算高度
  function add(runs, o) {
    o = o || {};
    let xml = '';
    let widthPt = 0;
    let maxSize = 0;
    runs.forEach(function (rn) {
      xml += wRun(rn.text, rn);
      const sz = rn.size || 20;
      if (sz > maxSize) maxSize = sz;
      widthPt += textWidthPt(rn.text, sz);
    });
    const oo = Object.assign({}, o);
    if (oo.after) oo.after = Math.round(oo.after * afterScale);
    if (oo.before) oo.before = Math.round(oo.before * afterScale);
    x += wPara(xml, oo);
    est += paraHeight(widthPt, maxSize, oo);
  }

  // 页眉（有姓名就打印姓名，没有就留空供手写）
  const who = (essay.identity && essay.identity.name) || '';
  const header = [
    { text: '英语作文批改报告', head: true, bold: true, size: S.headTitle },
    { text: '　　　　编号：' + essay.no + ' 号　　姓名：', size: S.name }
  ];
  if (who) header.push({ text: who, size: S.name, bold: true });
  else header.push({ text: '　　　　　', size: S.name, underline: true });
  add(header, { align: 'center', after: 40 });
  add([{ text: '', size: S.body }], { border: '2563EB', after: 120 });

  // 题目
  add([
    { text: '作文题目：', head: true, bold: true, size: S.label },
    { text: clipText(batch.title || '—', lim.titleChars), size: S.label }
  ], { after: 60 });

  // 得分
  add([
    { text: '得分：', head: true, bold: true, size: S.label },
    { text: String(score), head: true, bold: true, size: S.score, color: '2563EB' },
    { text: ' / 25　　', size: S.label },
    { text: '档次：' + tier, head: true, bold: true, size: S.tier, color: 'F97316' }
  ], { after: 80 });

  // 四维度
  if (valid) {
    add([{
      text: '内容 ' + (d.content ?? '—') + '/10　　语言 ' + (d.language ?? '—') + '/10　　结构 ' +
        (d.structure ?? '—') + '/3　　书写 ' + (d.handwriting ?? '—') + '/2' +
        (r.wordCount ? '　　词数 ' + r.wordCount : ''),
      size: S.dim, color: '475569'
    }], { after: 110 });
    // 这张纸是要发给学生的，四维加起来必须对得上总分
    const gap = scoreGapOf(r);
    if (gap !== 0) {
      add([{
        text: '四维合计 ' + dimensionTotal(r) + ' 分' +
          (gap < 0 ? '，硬性扣分 ' + Math.abs(gap) + ' 分' : '，上调 ' + gap + ' 分') +
          '，最终得分 ' + r.score + ' 分',
        size: S.gapNote, color: '475569'
      }], { after: 110 });
    }
  }

  // 要点核对
  if (pts.length) {
    add([{ text: nextSec() + '写作要点核对', head: true, bold: true, size: S.section }], { after: 30 });
    pts.forEach(function (p) {
      add([
        { text: p.covered ? '【已写】' : '【漏写】', size: S.body, bold: !p.covered, color: p.covered ? '059669' : 'DC2626' },
        { text: ' ' + clipText(p.point, lim.pointChars) + (!lim.omitPointNote && p.note ? '　—— ' + p.note : ''), size: S.body }
      ], { after: 20, indent: 200 });
    });
    add([{ text: '', size: S.body }], { after: 50 });
  }

  // 逐句纠错（三档及以上才有，来自 AI 初评的详细标注）
  const errLimit = lim.errors == null ? Infinity : lim.errors;
  const errors = ((essay.ai && essay.ai.errors) || []).slice(0, errLimit);
  if (errors.length) {
    add([{ text: nextSec() + '逐句纠错', head: true, bold: true, size: S.section }], { after: 30 });
    errors.forEach(function (er, i) {
      let line = (i + 1) + '. ' + (er.text || '');
      if (er.fix) line += '　→　' + er.fix;
      if (er.type) line += '　（' + er.type + '）';
      if (er.note) line += '　—— ' + er.note;
      add([{ text: line, size: S.body }], { after: 20, indent: 200 });
    });
    add([{ text: '', size: S.body }], { after: 50 });
  }

  // 需要改进的地方
  const problems = (valid && r.problems) ? r.problems.slice(0, lim.problems == null ? 3 : lim.problems) : [];
  if (problems.length) {
    add([{ text: nextSec() + '需要改进的地方', head: true, bold: true, size: S.section }], { after: 30 });
    problems.forEach(function (p, i) {
      add([{ text: (i + 1) + '. ' + clipText(p, lim.problemChars), size: S.body }], { after: 20, indent: 200 });
    });
    add([{ text: '', size: S.body }], { after: 50 });
  }

  // 怎么提高
  const suggestions = (valid && r.suggestions) ? r.suggestions.slice(0, lim.suggestions == null ? 3 : lim.suggestions) : [];
  if (suggestions.length) {
    add([{ text: nextSec() + '怎么提高', head: true, bold: true, size: S.section }], { after: 30 });
    suggestions.forEach(function (s, i) {
      add([{ text: (i + 1) + '. ' + clipText(s, lim.suggestionChars), size: S.body }], { after: 20, indent: 200 });
    });
    add([{ text: '', size: S.body }], { after: 50 });
  }

  // 评语：教师复核过叫「老师评语」，否则是 AI 初评，如实标成「AI 评语」
  if (valid && r.comment) {
    add([{ text: nextSec() + (essay.reviewed ? '老师评语' : 'AI 评语'), head: true, bold: true, size: S.section }], { after: 30 });
    add([{ text: clipText(r.comment, lim.commentChars), size: S.body }], { after: 100, indent: 200, shade: 'F3F7FF' });
  }

  // 范文（优先级见 effectiveModelEssay：essayMap 里传进来的已是统一口径后的文本）
  const modelRaw = (essayRes && essayRes.text) || '';
  const modelText = clipText(modelRaw, lim.modelChars);
  add([{ text: nextSec() + '为你改写的范文（照着读三遍，把好句子抄下来）', head: true, bold: true, size: S.section }], { after: 30 });
  if (modelText) {
    modelText.split(/\n+/).forEach(function (seg) {
      if (seg.trim()) add([{ text: seg.trim(), size: S.model }], { after: 40, indent: 200 });
    });
    const notes = (essayRes && essayRes.notes) ? essayRes.notes.slice(0, lim.notes == null ? 2 : lim.notes) : [];
    if (notes.length) {
      add([{ text: '为什么这样改：', head: true, bold: true, size: S.noteHead }], { after: 20 });
      notes.forEach(function (n, i) {
        add([{ text: (i + 1) + '. ' + n, size: S.note, color: '475569' }], { after: 18, indent: 200 });
      });
    }
    const keys = (essayRes && essayRes.keyPhrases) ? essayRes.keyPhrases.slice(0, lim.keys == null ? 4 : lim.keys) : [];
    if (keys.length) {
      add([{ text: '背下来能加分的好词好句：', head: true, bold: true, size: S.noteHead }], { after: 20 });
      keys.forEach(function (k) {
        add([{ text: '· ' + k, size: S.key, color: '1D4ED8' }], { after: 18, indent: 200 });
      });
    }
  } else {
    add([{ text: '（本篇尚未生成范文。请在平台里点「生成范文」，然后重新导出。）', size: S.placeholder, color: '94A3B8' }],
      { after: 100, indent: 200 });
  }

  return { xml: x, height: est };
}

/* 从最宽松的版式开始试，选第一个估算不超过一页的；
   最紧凑一档对题目/要点/问题/建议/评语/范文都做了硬上限，保证一定装进一页。 */
function fitStudentPage(batch, essay, r, essayRes, index) {
  let last = null;
  for (let i = 0; i < FIT_PRESETS.length; i++) {
    last = buildStudentPage(batch, essay, r, essayRes, index, FIT_PRESETS[i]);
    if (last.height <= FIT_LIMIT_TW) return last;
  }
  return last;
}

function buildReportDocx(batch, essays, essayMap) {
  let body = '';
  essays.forEach(function (e, i) {
    const r = eff(e);
    if (i > 0) body += pageBreak();
    body += fitStudentPage(batch, e, r, essayMap[e.id], i).xml;
  });
  if (!essays.length) body = wPara(wRun('本批次没有可导出的作文。', { size: 22 }));
  return buildDocx(body);
}

/* 取有效成绩：教师复核优先 */
function eff(e) {
  if (e.review && e.review.confirmed) return e.review;
  return e.ai || null;
}

/* 有效范文：教师复核里改过的优先（老师拍板的为准），其次「生成范文」单独生成的
   结果，最后批改时一并生成的那份。导出报告与档案详情都用这一个口径，
   三处不再各说各话 —— 否则老师在复核表单里改的范文，导出时会被旧结果顶掉。 */
function effectiveModelEssay(e) {
  const r = eff(e);
  if (e.reviewed && r && r.modelEssay && String(r.modelEssay).trim()) return String(r.modelEssay);
  if (e.modelEssayRes && e.modelEssayRes.text && String(e.modelEssayRes.text).trim()) return String(e.modelEssayRes.text);
  return String((r && r.modelEssay) || '');
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
  '.webp': 'image/webp',
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
  let s = v === null || v === undefined ? '' : String(v);
  // Excel / WPS 公式注入防护：以 = + - @ 开头的单元格会被表格软件当公式执行
  // （如 =HYPERLINK(...)），前面补一个半角单引号把它固定成文本。
  // 正常数据（中文姓名、数字得分）不会以这四个字符开头，不受影响。
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
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
    const files = [e.file, e.identityShot].filter(Boolean);
    for (const f of files) {
      try {
        await fsp.unlink(path.join(UPLOAD_DIR, f));
      } catch (err) {
        if (err.code !== 'ENOENT') failed++;
      }
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
      /* 本次启动是否发生过数据自愈（损坏 → 从快照恢复），前端会提示教师 */
      recovery: recoveryLog,
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
      const msg = (e && e.name === 'AbortError')
        ? '请求超时（45 秒内没有返回），接口可能不通或网络受限'
        : '请求失败：' + (e && e.message ? e.message : e);
      return sendJson(res, 200, { ok: false, error: msg });
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
    return await withData(async function () {
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
    });
  }

  /* ---- 修改批次（题目 / 默认班级 / 核心要点） ---- */
  if (pathname === '/api/batch/update') {
    return await withData(async function () {
      const db = await loadDb();
      const b = findBatch(db, body.id);
      if (!b) return sendJson(res, 404, { ok: false, error: '批次不存在' });
      if (body.title !== undefined) {
        b.title = String(body.title).trim() || '未命名作文题';
      }
      if (body.className !== undefined) {
        // 只改「批次默认班级」。已批改的作文各自记着卷面上写出的班级，不会跟着变
        // （一个批次里混了几个班的卷子时，批次班级本来就只是个默认值）。
        b.className = String(body.className).trim();
      }
      if (Array.isArray(body.points)) {
        b.points = body.points.map((s) => String(s).trim()).filter(Boolean);
      }
      b.updatedAt = new Date().toISOString();
      await writeJson(DB_FILE, db);
      return sendJson(res, 200, { ok: true, batch: b });
    });
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
    return await withData(async function () {
      const db = await loadDb();
      const i = db.batches.findIndex((b) => b.id === body.id);
      if (i === -1) return sendJson(res, 404, { ok: false, error: '批次不存在' });
      // 删除前留一份快照：误删整批（含照片）时至少记录还能找回
      const snap = await safeSnapshot(DB_FILE, 'db', {});
      const failed = await removeFiles(db.batches[i].essays);
      db.batches.splice(i, 1);
      await writeJson(DB_FILE, db);
      return sendJson(res, 200, { ok: true, cleanupFailed: failed, uploadDir: UPLOAD_DIR, snapshot: snap });
    });
  }

  /* ---- 上传照片（base64） ---- */
  if (pathname === '/api/upload') {
    return await withData(async function () {
      const db = await loadDb();
      const b = findBatch(db, body.batchId);
      if (!b) return sendJson(res, 404, { ok: false, error: '批次不存在' });
      const m = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/s.exec(String(body.dataUrl || ''));
      if (!m) return sendJson(res, 400, { ok: false, error: '图片格式不正确' });
      const ext = m[1] === 'image/png' ? '.png' : (m[1] === 'image/webp' ? '.webp' : '.jpg');
      const id = uid('e_');
      const file = id + ext;
      await fsp.writeFile(path.join(UPLOAD_DIR, file), Buffer.from(m[2], 'base64'));
      // 卷首放大图（前端裁好一起传上来）：小字手写姓名单独认一次，比整页照片认小字准得多。
      // 存成独立文件而不是只留在内存里，是为了教师事后点「识别姓名」时还能用。
      let identityShot = '';
      const sm = /^data:image\/[a-zA-Z+]+;base64,(.+)$/s.exec(String(body.shot || ''));
      if (sm) {
        identityShot = id + '_id.jpg';
        try {
          await fsp.writeFile(path.join(UPLOAD_DIR, identityShot), Buffer.from(sm[1], 'base64'));
        } catch (e) { identityShot = ''; }
      }
      // 文件名里带姓名就先填上（教师自己的名单）。批改时模型识别到的班级 / 学号会补进空着的字段，
      // 教师手工改过的（source = manual）不会被任何环节覆盖。
      const fromName = nameFromFileName(body.name);
      // 编号取「当前最大编号 + 1」。不能用 essays.length + 1：删掉中间一篇后
      // 长度会缩回去，再上传就会和现存作文撞号，登分表按编号对卷子会认错人。
      let maxNo = 0;
      b.essays.forEach(function (x) { if ((x.no || 0) > maxNo) maxNo = x.no; });
      const essay = {
        id,
        no: maxNo + 1,
        file,
        identityShot,
        mime: m[1],
        originalName: String(body.name || ''),
        createdAt: new Date().toISOString(),
        status: 'pending',
        identity: fromName
          ? { name: fromName, className: '', seatNo: '', source: 'filename', updatedAt: new Date().toISOString() }
          : null,
        ai: null,
        aiRaw: '',
        aiError: '',
        review: null,
        reviewed: false
      };
      b.essays.push(essay);
      await writeJson(DB_FILE, db);
      return sendJson(res, 200, { ok: true, essay });
    });
  }

  /* ---- 批改一篇 ---- */
  if (pathname === '/api/grade') {
    const settings = Object.assign({}, DEFAULT_SETTINGS, await readJson(SETTINGS_FILE, {}));
    if (!settings.apiKey || !settings.apiKey.trim()) return sendJson(res, 400, { ok: false, error: '尚未配置 API Key，请到「设置」填写' });
    if (!settings.baseUrl || !settings.model) return sendJson(res, 400, { ok: false, error: '尚未配置接口地址或模型名称' });
    const prompt = await fsp.readFile(PROMPT_FILE, 'utf8').catch(() => DEFAULT_PROMPT);

    // 先做只读预检（拿批改要用的题目与作文），404 在这里就能返回；
    // 真正的落库都在下面的锁内重新读、重新找 —— 预检和落库之间批次/作文可能已被删除。
    const db0 = await loadDb();
    const b0 = findBatch(db0, body.batchId);
    if (!b0) return sendJson(res, 404, { ok: false, error: '批次不存在' });
    const e0 = b0.essays.find((x) => x.id === body.essayId);
    if (!e0) return sendJson(res, 404, { ok: false, error: '作文记录不存在' });

    await withData(async function () {
      const db = await loadDb();
      const b = findBatch(db, body.batchId);
      const e = b && b.essays.find((x) => x.id === body.essayId);
      if (b && e) {
        e.status = 'grading';
        await writeJson(DB_FILE, db);
      }
    });

    try {
      // 模型调用可能要几十秒，必须放在锁外，否则会挡住其它所有写库操作
      const r = await callModel(settings, prompt, b0, e0);
      return await withData(async function () {
        const db2 = await loadDb();
        const b2 = findBatch(db2, body.batchId);
        const e2 = b2 && b2.essays.find((x) => x.id === body.essayId);
        if (!b2 || !e2) {
          return sendJson(res, 200, { ok: false, error: '批改已完成，但这篇作文或所在批次已被删除，结果未能保存。', essay: null });
        }
        if (r.ok) {
          e2.ai = r.result;
          e2.aiRaw = '';
          e2.aiError = '';
          e2.status = 'done';

          // 卷面识别到的学生信息：
          //  · 教师手工填过（manual）→ 一个字都不动
          //  · 其它来源（文件名兜底 / 上一次识别）→ 只补空着的字段，已有的值不被覆盖。
          //    模型偶尔认不出卷面小字（尤其竖排在装订线上的），整份覆盖会把文件名带来的姓名也清掉。
          const si = r.result.studentInfo || {};
          const cur = e2.identity || {};
          if (cur.source !== 'manual') {
            const pick = (first, second) => String(first || '').trim() || String(second || '').trim();
            // 姓名：文件名（教师自己的名单）优先，它是姓名最可靠的来源
            const name = pick(cur.name, si.name);
            // 班级 / 学号：以本次识别为准。旧数据里存过「教师后台班级」被回填进来的值，
            // 若让旧值优先，重新批改也改不掉那个错误的班级。
            const className = pick(si.className, cur.className);
            const seatNo = pick(si.seatNo, cur.seatNo);
            const any = name || className || seatNo;
            // source 只记「姓名」的出处：教师一眼能看出这个名字是手填的、文件名带出来的，还是认出来的
            let source = 'none';
            if (any) {
              source = cur.name ? (cur.source || 'ai') : 'ai';
              if (source === 'none') source = 'ai';
            }
            e2.identity = { name: name, className: className, seatNo: seatNo, source: source, updatedAt: new Date().toISOString() };
          }
          // 作文标识（标题 + 正文首句），每次批改刷新
          e2.identifier = {
            title: r.result.essayTitle || '',
            firstSentence: r.result.firstSentence || ''
          };
          // 卷面姓名没认出来时，再单独跑一次「卷首放大图」识别，并用班级名单核定。
          // 姓名认错会把 A 的成绩记到 B 头上，值得多花这一次图片请求；认出来了就不重复花钱。
          if (!((e2.identity || {}).name) && e2.identityShot && settings.apiKey) {
            try {
              const sc = await readEssayIdentity(settings, b2, e2);
              if (sc.ok) applyIdentityScan(e2, sc.merged, sc.read, false);
            } catch (err) { /* 姓名识别失败不影响批改结果 */ }
          }
          // 归入学生档案（有姓名才归）
          e2.studentId = (e2.identity && e2.identity.name) ? await resolveStudent(b2, e2.identity) : '';
        } else {
          e2.status = 'error';
          e2.aiError = r.reason || '解析失败';
          e2.aiRaw = r.raw || '';
        }
        await writeJson(DB_FILE, db2);
        return sendJson(res, 200, { ok: true, essay: e2 });
      });
    } catch (err) {
      return await withData(async function () {
        const db2 = await loadDb();
        const b2 = findBatch(db2, body.batchId);
        const e2 = b2 && b2.essays.find((x) => x.id === body.essayId);
        if (e2) {
          e2.status = 'error';
          e2.aiError = String(err.message || err);
          await writeJson(DB_FILE, db2);
        }
        return sendJson(res, 200, { ok: false, error: String(err.message || err), essay: e2 || null });
      });
    }
  }

  /* ---- 教师复核保存 ---- */
  if (pathname === '/api/review') {
    return await withData(async function () {
      const db = await loadDb();
      const b = findBatch(db, body.batchId);
      if (!b) return sendJson(res, 404, { ok: false, error: '批次不存在' });
      const e = b.essays.find((x) => x.id === body.essayId);
      if (!e) return sendJson(res, 404, { ok: false, error: '作文记录不存在' });
      e.review = body.review || null;
      e.reviewed = !!(body.review && body.review.confirmed);
      await writeJson(DB_FILE, db);
      return sendJson(res, 200, { ok: true, essay: e });
    });
  }

  /* ---- 删除单篇 ---- */
  if (pathname === '/api/essay/delete') {
    return await withData(async function () {
      const db = await loadDb();
      const b = findBatch(db, body.batchId);
      if (!b) return sendJson(res, 404, { ok: false, error: '批次不存在' });
      const i = b.essays.findIndex((x) => x.id === body.essayId);
      let failed = 0;
      if (i > -1) {
        await safeSnapshot(DB_FILE, 'db', {});
        failed = await removeFiles([b.essays[i]]);
        b.essays.splice(i, 1);
      }
      await writeJson(DB_FILE, db);
      return sendJson(res, 200, { ok: true, cleanupFailed: failed, uploadDir: UPLOAD_DIR });
    });
  }

  /* ---- 为某一篇生成优化范文 ---- */
  if (pathname === '/api/essay/model') {
    const settings = Object.assign({}, DEFAULT_SETTINGS, await readJson(SETTINGS_FILE, {}));
    if (!settings.apiKey || !settings.apiKey.trim()) {
      return sendJson(res, 200, { ok: false, error: '尚未配置 API Key，请到「设置」填写' });
    }
    const db0 = await loadDb();
    const b0 = findBatch(db0, body.batchId);
    if (!b0) return sendJson(res, 404, { ok: false, error: '批次不存在' });
    const e0 = b0.essays.find((x) => x.id === body.essayId);
    if (!e0) return sendJson(res, 404, { ok: false, error: '作文记录不存在' });

    try {
      const r = await callModelForEssay(settings, b0, e0, eff(e0));
      if (!r.ok) return sendJson(res, 200, { ok: false, error: r.reason, raw: r.raw });
      return await withData(async function () {
        const db2 = await loadDb();
        const b2 = findBatch(db2, body.batchId);
        const e2 = b2 && b2.essays.find((x) => x.id === body.essayId);
        if (!b2 || !e2) {
          return sendJson(res, 200, { ok: false, error: '范文已生成，但这篇作文或所在批次已被删除，结果未能保存。' });
        }
        e2.modelEssayRes = Object.assign({}, r.result, { createdAt: new Date().toISOString() });
        await writeJson(DB_FILE, db2);
        return sendJson(res, 200, { ok: true, essay: e2 });
      });
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: String(err.message || err) });
    }
  }

  /* ---- 本地补录作文标识（不调 AI，零成本） ---- */
  if (pathname === '/api/backfill') {
    return await withData(async function () {
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
      // 再补姓名：早先版本上传时没有从文件名取姓名，老数据这里补上（教师手填过的不动，
      // 已经认出姓名的不动）。文件名是教师自己的名单，比认卷面上竖排的小字可靠。
      let named = 0;
      b.essays.forEach(function (e) {
        const idt = e.identity || {};
        if (idt.source === 'manual') return;
        if (String(idt.name || '').trim()) return;
        const nm = nameFromFileName(e.originalName);
        if (!nm) return;
        e.identity = Object.assign({}, idt, { name: nm, source: 'filename', updatedAt: new Date().toISOString() });
        named++;
      });
      // 再有就是「只认出考号/学号、没认出姓名」的：拿班级名单把姓名定下来。
      // 考号是阿拉伯数字，模型认数字远比认草书汉字准；名单里一个号对一个人，错不了。
      const rosters = await loadRosters();
      b.essays.forEach(function (e) {
        const idt = e.identity || {};
        if (idt.source === 'manual') return;
        if (String(idt.name || '').trim()) return;
        if (!String(idt.seatNo || '').trim()) return;
        const merged = reconcileWithRoster(rosters, idt.className || b.className || '',
          { name: '', className: idt.className, seatNo: idt.seatNo, candidates: [] });
        if (!merged.rosterName) return;
        e.identity = Object.assign({}, idt, {
          name: merged.rosterName, source: 'roster', updatedAt: new Date().toISOString()
        });
        named++;
      });
      if (filled || named) await writeJson(DB_FILE, db);
      const rebuilt = await rebuildStudents();
      return sendJson(res, 200, {
        ok: true, filled: filled, named: named,
        students: rebuilt.students, linked: rebuilt.linked
      });
    });
  }

  /* ---- 一键填写班级：把班级名批量填到这一批的作文上 ----
     一个批次里混了几个班的卷子时用得上。只填空白的，不会动已经认出来的班级；
     选「全部改成」才会覆盖。重新批改时若卷面上识别到班级，仍会以识别结果为准。 */
  if (pathname === '/api/class/fill') {
    return await withData(async function () {
      const db = await loadDb();
      const b = findBatch(db, body.batchId);
      if (!b) return sendJson(res, 404, { ok: false, error: '批次不存在' });
      const cls = String(body.className || '').trim();
      if (!cls) return sendJson(res, 200, { ok: false, error: '请先填写班级名称' });
      const all = body.mode === 'all';
      let filled = 0;
      b.essays.forEach(function (e) {
        const idt = e.identity || {};
        const has = String(idt.className || '').trim();
        if (!all && has) return;                       // 只填空白：班级还空着的都要填，
                                                        // 不看姓名是手填的还是认出来的
        if (has === cls) return;
        e.identity = Object.assign({}, idt, {
          className: cls,
          updatedAt: new Date().toISOString()
        });
        filled++;
      });
      if (filled) {
        await writeJson(DB_FILE, db);
        await rebuildStudents();       // 班级变了，学生档案的归并键跟着变
      }
      return sendJson(res, 200, { ok: true, filled: filled });
    });
  }

  /* ---- 班级共性分析 + 教学建议（AI 生成，纯文本，成本低） ---- */
  if (pathname === '/api/class/analysis') {
    const settings = Object.assign({}, DEFAULT_SETTINGS, await readJson(SETTINGS_FILE, {}));
    if (!settings.apiKey || !settings.apiKey.trim()) return sendJson(res, 200, { ok: false, error: '尚未配置 API Key，请到「设置」填写' });
    if (!settings.baseUrl || !settings.model) return sendJson(res, 200, { ok: false, error: '尚未配置接口地址或模型名称' });
    const db0 = await loadDb();
    const b0 = findBatch(db0, body.batchId);
    if (!b0) return sendJson(res, 404, { ok: false, error: '批次不存在' });
    if (!b0.essays.some(function (e) { return hasResult(e); })) {
      return sendJson(res, 200, { ok: false, error: '这一批还没有批改结果，先批改完再生成' });
    }
    try {
      const parsed = await callTextModel(settings, CLASS_PROMPT, buildClassUserText(b0));
      const out = {
        commonStrengths: toStrArr(parsed.commonStrengths || parsed.strengths).slice(0, 2),
        commonProblems: toStrArr(parsed.commonProblems || parsed.issues).slice(0, 4),
        guidance: toStrArr(parsed.guidance || parsed.suggestions || parsed.advice).slice(0, 5),
        createdAt: new Date().toISOString()
      };
      return await withData(async function () {
        const db2 = await loadDb();
        const b2 = findBatch(db2, body.batchId);
        if (!b2) return sendJson(res, 200, { ok: false, error: '批次已被删除，分析结果未能保存。' });
        b2.classAnalysis = out;
        await writeJson(DB_FILE, db2);
        return sendJson(res, 200, { ok: true, classAnalysis: out });
      });
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: String(err.message || err) });
    }
  }

  /* ---- 教师订正卷面学生信息 ---- */
  if (pathname === '/api/identity') {
    return await withData(async function () {
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
      // 教师已经拍板了，之前识别出来的候选就没有用了
      e.nameCandidates = [];
      // 同步进学生档案（跨批次归并）
      e.studentId = name ? await resolveStudent(b, e.identity) : '';
      await writeJson(DB_FILE, db);
      return sendJson(res, 200, { ok: true, essay: e });
    });
  }

  /* ---- 单独识别一卷的姓名 / 班级 / 考号（卷首放大图 + 班级名单核对） ----
     批改时若没认出姓名会自动跑一次；教师也可以在详情里点「识别姓名」重跑。
     传 force: true 表示「以这次识别为准」，连 AI 上一次认出来的姓名也允许改掉。 */
  if (pathname === '/api/identity/scan') {
    const settings = Object.assign({}, DEFAULT_SETTINGS, await readJson(SETTINGS_FILE, {}));
    if (!settings.apiKey || !settings.apiKey.trim()) {
      return sendJson(res, 200, { ok: false, error: '尚未配置 API Key，请到「设置」填写' });
    }
    const db0 = await loadDb();
    const b0 = findBatch(db0, body.batchId);
    if (!b0) return sendJson(res, 404, { ok: false, error: '批次不存在' });
    const e0 = b0.essays.find((x) => x.id === body.essayId);
    if (!e0) return sendJson(res, 404, { ok: false, error: '作文记录不存在' });
    try {
      // 识别（含一次模型请求）在锁外跑，识别完再进锁落库
      const r = await readEssayIdentity(settings, b0, e0);
      if (!r.ok) return sendJson(res, 200, { ok: false, error: r.error, raw: r.raw });
      return await withData(async function () {
        const db = await loadDb();
        const b = findBatch(db, body.batchId);
        const e = b && b.essays.find((x) => x.id === body.essayId);
        if (!b || !e) {
          return sendJson(res, 200, { ok: false, error: '识别已完成，但这篇作文或所在批次已被删除，结果未能保存。' });
        }
        const out = applyIdentityScan(e, r.merged, r.read, !!body.force);
        e.studentId = (e.identity && e.identity.name) ? await resolveStudent(b, e.identity) : '';
        await writeJson(DB_FILE, db);
        return sendJson(res, 200, {
          ok: true, essay: e, candidates: out.candidates, scan: out.scan,
          hadShot: r.hadShot
        });
      });
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: String(err.message || err) });
    }
  }

  /* ---- 班级名单：读 / 存 ----
     GET  /api/class/list?className=九二班 → 返回该班名单与原文
     POST /api/class/list { className, text } → 覆盖保存（换行分隔，一行一人） */
  if (pathname === '/api/class/list') {
    const store = await loadRosters();
    if (req.method === 'GET') {
      const className = String(query.get('className') || '').trim();
      const cls = rosterOf(store, className);
      return sendJson(res, 200, {
        ok: true,
        className: cls ? cls.className : className,
        students: cls ? cls.students : [],
        classes: store.classes.map(function (c) {
          return { className: c.className, count: c.students.length, updatedAt: c.updatedAt || '' };
        })
      });
    }
    const className = String(body.className || '').trim();
    if (!className) return sendJson(res, 200, { ok: false, error: '请先填写班级名称' });
    return await withData(async function () {
      const store = await loadRosters();
      const students = parseRosterText(body.text);
      const key = classKey(className);
      const rest = store.classes.filter(function (c) { return classKey(c.className) !== key; });
      if (students.length) {
        rest.push({ className: className, students: students, updatedAt: new Date().toISOString() });
      }
      const next = { classes: rest };
      await writeJson(ROSTERS_FILE, next);
      return sendJson(res, 200, { ok: true, className: className, students: students, saved: students.length });
    });
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
          /* 点开某一篇看详细批改时要用的字段（档案页的作文明细表） */
          essayId: e.id,
          file: e.file || '',
          status: e.status || '',
          className: (e.identity || {}).className || '',
          wordCount: (r && r.wordCount) || 0,
          score: r && r.score !== undefined ? r.score : null,
          tier: (r && r.tier) || '', reviewed: !!e.reviewed,
          title: (e.identifier || {}).title || '',
          firstSentence: (e.identifier || {}).firstSentence || '',
          comment: (r && r.comment) || '',
          problems: (r && r.problems) || [],
          deductions: (r && r.deductions) || [],
          suggestions: (r && r.suggestions) || [],
          pointsDetail: (r && r.pointsDetail) || [],
          errors: (e.ai && e.ai.errors) || [],
          plagiarism: (e.ai && e.ai.plagiarism) || null,
          transcription: (r && r.transcription) || '',
          modelEssay: effectiveModelEssay(e),
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
    return await withData(async function () {
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
            // 教师改过档案就把这篇锁定为「教师填写」，之后重新批改不会再把信息改回去
            source: 'manual',
            updatedAt: new Date().toISOString()
          });
          touched++;
        });
      });
      await writeJson(DB_FILE, db);
      await writeJson(STUDENTS_FILE, store);
      const rebuilt = await rebuildStudents();
      return sendJson(res, 200, { ok: true, updated: touched, rebuilt: rebuilt });
    });
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
      const srcTxt = idt.source === 'manual' ? '教师填写'
        : (idt.source === 'filename' ? '文件名' : (idt.source === 'ai' ? '卷面识别' : '未识别'));
      rows.push([
        e.no + ' 号',
        idt.name || '',
        idt.className || '',
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
    list.forEach(function (e) {
      // 范文统一走 effectiveModelEssay 的口径：教师复核改过的 > 单独生成的 > 批改附带的
      const text = effectiveModelEssay(e);
      essayMap[e.id] = text ? {
        text: text,
        notes: (e.modelEssayRes && e.modelEssayRes.notes) || [],
        keyPhrases: (e.modelEssayRes && e.modelEssayRes.keyPhrases) || []
      } : null;
    });

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
    return await withData(async function () {
      const db = await loadDb();
      const b = findBatch(db, body.batchId);
      if (!b) return sendJson(res, 404, { ok: false, error: '批次不存在' });
      const e = b.essays.find((x) => x.id === body.essayId);
      // 旧结果一并清掉：不然重置后登分表还显示旧分、状态却是「未批改」，自相矛盾。
      // reset 只用于重批失败 / 空结果的篇目，清掉的本来就不是有效成绩。
      if (e) { e.status = 'pending'; e.ai = null; e.aiError = ''; e.aiRaw = ''; }
      await writeJson(DB_FILE, db);
      return sendJson(res, 200, { ok: true });
    });
  }

  /* ---- 导出 CSV ---- */
  if (pathname === '/api/export') {
    const db = await loadDb();
    const b = findBatch(db, body.id || query.get('id'));
    if (!b) return sendJson(res, 404, { ok: false, error: '批次不存在' });
    const head = ['编号', '姓名', '最终得分', '档次', '内容', '语言', '结构', '书写', '四维合计', '词数', '硬性扣分', '核心问题', '改进建议', '抄袭标记', '复核状态'];
    const rows = [head.map(csvCell).join(',')];
    b.essays.forEach((e) => {
      const r = e.review && e.review.confirmed ? e.review : e.ai;
      const empty = isEmptyResult(r);
      const sc = (r && r.score !== undefined && !empty) ? r.score : '';
      const dim = (r && !empty && r.dimensions) || {};
      const idt = e.identity || {};
      const pl = (!empty && e.ai && e.ai.plagiarism) || {};
      const plTxt = pl.verdict === 'copied' ? '判定抄袭'
        : (pl.verdict === 'suspect' ? '疑似抄袭' : '');
      rows.push([
        e.no + ' 号',
        idt.name || '',
        sc,
        (!empty && r && r.tier) || '',
        dim.content !== undefined ? dim.content : '',
        dim.language !== undefined ? dim.language : '',
        dim.structure !== undefined ? dim.structure : '',
        dim.handwriting !== undefined ? dim.handwriting : '',
        (!empty && r && r.dimensions) ? (dimensionTotal(r) ?? '') : '',
        (!empty && r && r.wordCount) || '',
        (!empty && r && r.deductions ? r.deductions.join('；') : ''),
        (!empty && r && r.problems ? r.problems.join('；') : ''),
        (!empty && r && r.suggestions ? r.suggestions.join('；') : ''),
        plTxt,
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
  // 只认指向本机服务的 Host 头，挡掉 DNS rebinding：外部网页把自己的域名解析到
  // 127.0.0.1 后冒充同源来读本地学生数据。正常访问（127.0.0.1 / localhost + 端口）不受影响。
  const host = String(req.headers.host || '').toLowerCase();
  if (host !== HOST + ':' + PORT && host !== 'localhost:' + PORT) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('forbidden');
    return;
  }
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
  } else if (code === 'CORRUPT_DATA') {
    console.error('');
    console.error('  ✗ 数据文件损坏，且没有找到可用的自动快照。');
    console.error('');
    console.error('    文件：' + (e.file || DB_FILE));
    console.error('');
    console.error('    处理：');
    console.error('      1. 先把损坏的文件改名留档（例如 db.json → db.broken.json）');
    console.error('      2. 到 data/backup/ 里挑一份对应的快照（损坏的是 db.json 就找 db-*.json，');
    console.error('         是 students.json 就找 students-*.json，是 rosters.json 就找 rosters-*.json；');
    console.error('         文件名排序最靠后的那份最新），复制成同名文件');
    console.error('      3. 重新启动。若这是第一次使用、本来就没有数据，直接删掉损坏文件即可。');
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
