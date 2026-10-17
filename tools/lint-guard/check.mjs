/**
 * 禁令的可证伪断言（W0-1 起，Demo 那轮加到三条，antd 这轮加到四条）。
 *
 * 为什么需要：`eslint.config.mjs` 里写了规则 **不等于它会触发**。
 * glob 打错、`files` 段指错目录、被后面的 config 覆盖 —— 都会让规则静默失效而 CI 全绿。
 * 本项目已经因为"自证脚本覆盖面不足"翻过一次车，所以连 lint 规则也要有回归。
 *
 * 做法：把 fixture 的代码用 `lintText` 以**仓库 config 真正会命中的虚拟路径**喂给本 config
 * —— 测的是真配置、真路径，而不是另写一份内联 config 自欺欺人。
 *
 * 每个 scope 六道断言，任一失败即 exit 1：
 *   A  fixture 存在且非空（否则 B/C 是"假通过"）
 *   B  违规代码在该 scope 下必须产出**预期条数**的规则命中
 *      （只断言 ">0" 是不够的：十条 group 写坏九条也照样绿，计数才暴露"部分失效"）
 *   C  合法代码在同一 scope 下必须 0 命中（防规则过宽）
 *   D  config 对该 scope 的挂载路径确实开了这条规则（防 files 段指错目录）
 *   D2 该路径上生效的规则**内容**必须含本 scope 的标记（防"后段 config 整条覆盖同名规则"）
 *   E  在"本该允许"的路径上，生效的规则里不得出现本 scope 的标记
 *      （只看"规则在不在"是不够的：禁令⑦ 现在挂在 src/app/** 全域，
 *       api/lib/server 都带着它，那些位置**不该**带的其实是 ⑥⑤/① 那份）
 */
import { readFile } from "node:fs/promises";
import { ESLint } from "eslint";

const RULE = "no-restricted-imports";

/**
 * 四个 scope。每个都自带"该被拦的写法 / 不该被拦的写法 / 挂载点 / 不该扩到的地方 / 预期命中数"。
 * 新增禁令时往这里加一行即可 —— check 的逻辑是通用的，别再复制一份六连。
 */
const SCOPES = [
  {
    id: "禁令① shared 层纯净",
    rule: RULE,
    bad: "tools/lint-guard/fixtures/bad/shared-forbidden.ts",
    good: "tools/lint-guard/fixtures/good/shared-allowed.ts",
    /** 喂进去时假装自己是这个路径下的文件 */
    badPath: "src/shared/__guard_bad__.ts",
    goodPath: "src/shared/__guard_good__.ts",
    expectHits: 2,
    mountedAt: "src/shared/probe.ts",
    /** ⑦ 的 glob 一旦扩到 src/shared，后段 config 会整条覆盖 ① —— 只查"规则在不在"看不出来 */
    marker: "禁令①",
    mustNotReach: "src/app/lib/server/probe.ts",
    whyOverflow: "服务端层允许用 Node API，会被误伤",
  },
  {
    id: "禁令⑦ 一套组件体系（antd）",
    rule: RULE,
    bad: "tools/lint-guard/fixtures/bad/ui-direct-primitive.ts",
    good: "tools/lint-guard/fixtures/good/ui-via-wrapper.ts",
    badPath: "src/app/components/__guard_bad__.ts",
    goodPath: "src/app/components/__guard_good__.ts",
    expectHits: 10,
    mountedAt: "src/app/(desk)/matters/probe.ts",
    marker: "禁令⑦",
    mustNotReach: "src/shared/enums/common.ts",
    whyOverflow:
      "shared 层归禁令① 管；⑦ 挂在 src/app/**，glob 一旦扩到 shared，" +
      "config 后段会把 ① 整条覆盖掉，纯 TS 边界静默消失",
  },
  {
    id: "禁令⑦ 色值单源",
    rule: "no-restricted-syntax",
    bad: "tools/lint-guard/fixtures/bad/hardcoded-color.ts",
    good: "tools/lint-guard/fixtures/good/via-theme.ts",
    badPath: "src/app/components/__guard_bad__.ts",
    goodPath: "src/app/components/__guard_good__.ts",
    expectHits: 4,
    mountedAt: "src/app/(desk)/matters/probe.ts",
    marker: "色值只在",
    mustNotReach: "src/app/theme/brand.ts",
    whyOverflow: "brand.ts 就是那个唯一源，规则扩到它里面等于没人能定义颜色了",
  },
  {
    id: "禁令⑥⑤ 页面壳不碰数据层",
    rule: RULE,
    bad: "tools/lint-guard/fixtures/bad/shell-imports-server.ts",
    good: "tools/lint-guard/fixtures/good/shell-page.ts",
    badPath: "src/app/(desk)/matters/__guard_bad__/page.tsx",
    goodPath: "src/app/(desk)/matters/__guard_good__/page.tsx",
    expectHits: 3,
    mountedAt: "src/app/(desk)/probe/page.tsx",
    marker: "禁令⑥",
    mustNotReach: "src/app/api/matters/route.ts",
    whyOverflow: "handler 层按定义就要碰 DB，规则扩到 /api 会逼人在页面里写查询",
  },
  {
    // 出口形态（2026-10-17 retro 候选 1）。实测来源：watch 路由自己写了
    // `fail(404, "not_found", "找不到这条记录。")`，与 http.ts:54 的规范措辞不同 ——
    // 而"不可见与不存在同形同措辞"是权限模型的骨架。
    id: "404 出口只从 notFound() 出来",
    rule: "no-restricted-syntax",
    bad: "tools/lint-guard/fixtures/bad/hand-rolled-not-found.ts",
    good: "tools/lint-guard/fixtures/good/via-not-found.ts",
    badPath: "src/app/api/__guard_notfound_bad__/route.ts",
    goodPath: "src/app/api/__guard_notfound_good__/route.ts",
    /** fixture 里两处 `fail(404, …)` 都要被拦（只拦一处＝ selector 写窄了） */
    expectHits: 2,
    mountedAt: "src/app/api/matters/route.ts",
    marker: "404 出口只有 http.ts",
    /** `http.ts` 正是 `notFound()` 的定义处，是这条规则唯一合法的现场 */
    mustNotReach: "src/app/lib/server/http.ts",
    whyOverflow: "http.ts 就是 notFound() 的定义体，规则扩进去等于把自己拦下来",
  },
  {
    // id 形态单源（2026-10-17 retro 候选 1）：19 位上界与 bigint 转换只在 pathId()。
    // 实测来源：watch 路由把这份正则又抄了一遍并按自造的 bad_target 报错 ⇒ 同一个错误两个码。
    id: "id 形态只在 pathId() 一处",
    rule: "no-restricted-syntax",
    bad: "tools/lint-guard/fixtures/bad/redeclared-id-shape.ts",
    good: "tools/lint-guard/fixtures/good/via-path-id.ts",
    badPath: "src/app/api/__guard_idshape_bad__/route.ts",
    goodPath: "src/app/api/__guard_idshape_good__/route.ts",
    /** 单个 id 的两处形状（`.regex()` 与裸 `.test()`）都要被拦 */
    expectHits: 2,
    mountedAt: "src/app/(desk)/matters/page.tsx",
    marker: "id 的形态（19 位上界）",
    /**
     * `src/shared/**` 不在本规则的挂载面内（那里正是 body id 数组的家：
     * `schema/batch.ts` 的 `idField` 用同一个上界，且注释写了理由），
     * 用它当 mustNotReach 才验得动"规则没有溢出到 shared"。
     */
    mustNotReach: "src/shared/schema/batch.ts",
    whyOverflow:
      "shared 是 body id 数组的家（batch.ts 的 idField 同形且有理有据），" +
      "规则扩过去会把合法的 body 校验也拦下",
  },
  {
    // 宿主集合单源（2026-10-18 retro 候选 3）。`type-safety.md` 早写着「禁止在 src/app/**
    // 里再声明一份业务枚举」却没有检查，于是 `["matter","risk_matter"]` 又长出两份。
    id: "宿主集合只引 HOST_TYPES",
    rule: "no-restricted-syntax",
    bad: "tools/lint-guard/fixtures/bad/redeclared-host-set.ts",
    good: "tools/lint-guard/fixtures/good/via-host-types.ts",
    badPath: "src/app/api/__guard_hostset_bad__/route.ts",
    goodPath: "src/app/api/__guard_hostset_good__/route.ts",
    /**
     * 两处**两种顺序**都要被拦 —— 只写一条 selector 时倒序那处会静默漏过，
     * 而这个计数就是为了暴露"只拦下一半"。实测过：单条 selector 只命中 1 处。
     */
    expectHits: 2,
    mountedAt: "src/app/lib/server/services/reports.ts",
    marker: "宿主集合的单一源是 HOST_TYPES",
    /**
     * `HOST_TYPES` 的定义处就在 shared（`shared/enums/targets.ts:84` 那行字面量是唯一
     * 合法的），`automation.ts` 那几处是 preset 规则各自的宿主域 —— 都不该被这条规则碰。
     */
    mustNotReach: "src/shared/enums/targets.ts",
    whyOverflow:
      "shared 是 HOST_TYPES 的定义处（那行字面量唯一合法），" +
      "且 automation.ts 的宿主域是「这条规则作用于哪些宿主」、不是宿主集合",
  },
];

const failures = [];
const eslint = new ESLint();

let loaded = 0;
for (const scope of SCOPES) {
  const rule = scope.rule ?? RULE;
  let badCode;
  let goodCode;
  try {
    badCode = await readFile(scope.bad, "utf8");
    goodCode = await readFile(scope.good, "utf8");
    loaded += 2;
  } catch (e) {
    failures.push(`${scope.id} · A fixture 读不到（${e.code}）：${e.path ?? "?"}`);
    continue;
  }
  if (badCode.trim() === "") failures.push(`${scope.id} · A 违规 fixture 为空，断言 B 会假通过`);
  if (goodCode.trim() === "") failures.push(`${scope.id} · A 合法 fixture 为空，断言 C 会假通过`);

  const [bad] = await eslint.lintText(badCode, { filePath: scope.badPath });
  const hits = (bad?.messages ?? []).filter((m) => m.ruleId === rule && m.severity === 2);
  if (hits.length === 0) {
    failures.push(
      `${scope.id} · B 违规代码未被拦下（规则静默失效）。` +
        `该路径实际报出的规则：${JSON.stringify((bad?.messages ?? []).map((m) => m.ruleId))}`,
    );
  } else if (hits.length !== scope.expectHits) {
    failures.push(
      `${scope.id} · B 命中 ${hits.length} 条，预期 ${scope.expectHits} 条 —— ` +
        `规则只拦下了一部分（漏掉的那些 group 写错了却没人知道）。明细：` +
        hits.map((m) => `${m.line}:${m.column}`).join(" "),
    );
  }

  const [good] = await eslint.lintText(goodCode, { filePath: scope.goodPath });
  const falsePositives = (good?.messages ?? []).filter((m) => m.ruleId === rule);
  if (falsePositives.length > 0) {
    failures.push(
      `${scope.id} · C 合法代码被误拦：${falsePositives.map((m) => m.message).join("；")}（规则过宽）`,
    );
  }

  const mounted = await eslint.calculateConfigForFile(scope.mountedAt);
  const mountedRule = mounted?.rules?.[rule];
  if (!(mountedRule?.[0] === "error" || mountedRule?.[0] === 2)) {
    failures.push(
      `${scope.id} · D 在 ${scope.mountedAt} 上 ${rule} 未生效：files 段指错了目录（拿到 ${JSON.stringify(mountedRule)}）`,
    );
  } else if (!JSON.stringify(mountedRule).includes(scope.marker)) {
    failures.push(
      `${scope.id} · D2 ${scope.mountedAt} 上生效的是**别的**同名规则：` +
        `配置里找不到「${scope.marker}」，说明有后段 config 把它整条覆盖了`,
    );
  }

  const outside = await eslint.calculateConfigForFile(scope.mustNotReach);
  const outsideRule = outside?.rules?.[rule];
  if (outsideRule && JSON.stringify(outsideRule).includes(scope.marker)) {
    failures.push(`${scope.id} · E 规则溢出到 ${scope.mustNotReach} —— ${scope.whyOverflow}`);
  }
}

/**
 * 副标题纪律（2026-10-12 起）：`PageHeader` 不再提供"什么都能塞"的第二行说明插槽。
 * 对应 `docs/research-subtitle-discipline.md` §B.3 的组件收口。
 *
 * **它不能进 `SCOPES`**：上面六道断言里有四道（A/B/C/D、D2、E）的前提是
 * "存在一条 eslint 规则"，要靠 `lintText` 与 `calculateConfigForFile` 去查配置。
 * 这条是**源码断言**，没有规则可挂载，硬塞进 `SCOPES` 会得到一个永远为假的 D。
 *
 * 为什么只匹配 JSX 属性形态（`名=`）而不是词本身：组件自己的注释里会**写**这两个词
 * （"为什么没有第二行插槽"），词级匹配会把说明文字自己拦下来。属性形态才是"有人
 * 真的把它当 prop 用回来了"。
 *
 * 推导依据（收口前后各跑一次 `git grep`，数字是数出来的，不是估的）：
 *   · `eyebrow=` 收口前 5 处里占 3：matter-detail:178 / risk-detail:128 / workbench:83
 *   · `meta=` 2 处：matter-detail:190 / risk-detail:134
 *   · 收口后 0 处（`git grep -cE '\b(eyebrow|meta)\s*=' -- src` 无输出）
 * 误伤面：将来有人把局部变量命名成 `eyebrow` / `meta` 并赋值，会误报一次 —— 这是
 * **说清楚代价后接受的误报**，比让插槽悄悄回来便宜。
 *
 * ⚠ 2026-10-18 补：它是**否定式**断言（干净时命中数天然为 0），所以必须自证还会咬人
 * —— 见下面 `SUBTITLE_SELF_CHECK`。实测过：正则腐掉后本断言静默全绿。
 */
const SUBTITLE_SLOTS = [
  { name: "eyebrow", re: /\beyebrow\s*=/g },
  { name: "meta", re: /\bmeta\s*=/g },
];

/** 正样本：两处属性形态各来一个，必然命中。跑不中即「正则腐掉」 */
const SUBTITLE_SELF_CHECK = ['<PageHeader eyebrow="x" />', '<PageHeader meta="y" />'].join("\n");

async function assertNoSubtitleSlots() {
  // ⚠ **正样本自检**（2026-10-18，retro 候选 1）。形状抄 `antd-deprecated.mjs`。
  //
  // 本断言是「否定式」的：仓库干净时命中数**天然为 0**。于是「真干净」与
  // 「正则被我改死了」在结果上**逐字相同** —— 实测把 `eyebrow` 那条换成永不命中的
  // 形态，`check.mjs` 照样退出 0、汇总行照样打印「页头无第二行插槽 0 处」。
  // 这条断言连 `scanned === 0` 那类 canary 都没有（它不数文件），所以正样本是唯一防线。
  for (const { name, re } of SUBTITLE_SLOTS) {
    if (!new RegExp(re.source).test(SUBTITLE_SELF_CHECK)) {
      failures.push(
        `页头第二行插槽断言：匹配式 \`${name}\` 连**自检样本**都匹配不上 —— 正则写歪了，` +
          "本条此刻在「永远绿」的状态（仓库干净时它本来就不报，看不出区别）",
      );
    }
  }

  const { readdir, readFile } = await import("node:fs/promises");
  // 递归必须 `Promise.all` 摊开：`flatMap` 里直接返回子目录的 Promise，会把 Promise 本身
  // 当成文件路路径丢给 `readFile`（实测报 ERR_INVALID_ARG_TYPE）
  const walk = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true });
    const sub = await Promise.all(
      entries.filter((e) => e.isDirectory()).map((e) => walk(`${dir}/${e.name}`)),
    );
    const files = entries.filter((e) => !e.isDirectory() && /\.tsx?$/.test(e.name));
    return [...sub.flat(), ...files.map((e) => `${dir}/${e.name}`)];
  };
  for (const file of await walk("src")) {
    const code = await readFile(file, "utf8");
    for (const { name, re } of SUBTITLE_SLOTS) {
      const hits = code.match(re)?.length ?? 0;
      if (hits > 0)
        failures.push(
          `${file} 有 ${hits} 处 \`${name}=\` —— 页面头不再有第二行说明的位置。` +
            `状态用 status、主键用 code，字段回页面里已有的 Descriptions / MetaLine；` +
            `依据 .trellis/spec/frontend/component-guidelines.md「副标题纪律」`,
        );
    }
  }
}

await assertNoSubtitleSlots();

/**
 * 禁令⑦ 富文本白名单（2026-10-12，MATT-57 / ADR-0002）。
 *
 * ADR 明写「门禁在这一条上是瞎的：`tools/lint-guard` 与收工清单的名字表里没有
 * `mantine`/`blocknote`，照抄进去照样绿」。这条源码断言就是来补这个洞的——
 * 把"靠 review 守"变成"靠脚本守"。
 *
 * 规则：`@blocknote/*` 与 `@mantine/*` 只允许出现在 `src/app/components/ui/rich-text/` 内。
 * 只匹配 **import 说明符形态**（引号里的 `@blocknote/…` / `@mantine/…`），不匹配裸词——
 * 与副标题断言同一哲学：注释里会**写**这些词解释白名单，词级匹配会把说明文字自己拦下来；
 * 引号形态才是"真的有人把它 import 进来了"。
 *
 * 代价：`@mantine/*` 除富文本外一律禁（ADR 的硬边界）；将来若白名单要扩，
 * 必须同时改这条、§13.6.2 那行、与 ADR——三处一起改是本仓"文档先行不破值列"的同批纪律。
 *
 * ⚠ 2026-10-18 补：与副标题断言同款 —— **否定式**断言，干净时命中数天然为 0，
 * 所以必须自证还会咬人（见下面 `RICH_TEXT_SELF_CHECK`）。
 */
const RICH_TEXT_DIR = "src/app/components/ui/rich-text/";
const RICH_TEXT_IMPORT = /["']@(?:blocknote|mantine)\/[^"']*["']/g;

/** 正样本：两种包各来一个 import 说明符，必然命中。跑不中即「正则腐掉」 */
const RICH_TEXT_SELF_CHECK = [
  'import { BlockNoteView } from "@blocknote/react";',
  'import { TextInput } from "@mantine/core";',
].join("\n");

async function assertRichTextWhitelist() {
  // ⚠ **正样本自检**（2026-10-18，retro 候选 1，形状抄 `antd-deprecated.mjs`）。
  // 理由与副标题断言同一句：仓库干净时命中数天然为 0 ⇒ 「真干净」与「正则腐掉」
  // 在结果上逐字相同，而这条断言没有任何 canary 兜底。
  if (!new RegExp(RICH_TEXT_IMPORT.source).test(RICH_TEXT_SELF_CHECK)) {
    failures.push(
      "富文本白名单断言：匹配式连**自检样本**都匹配不上 —— 正则写歪了，" +
        "本条此刻在「永远绿」的状态（仓库干净时它本来就不报，看不出区别）",
    );
  }

  const { readdir, readFile } = await import("node:fs/promises");
  const walk = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true });
    const sub = await Promise.all(
      entries.filter((e) => e.isDirectory()).map((e) => walk(`${dir}/${e.name}`)),
    );
    const files = entries.filter((e) => !e.isDirectory() && /\.tsx?$/.test(e.name));
    return [...sub.flat(), ...files.map((e) => `${dir}/${e.name}`)];
  };
  for (const file of await walk("src")) {
    if (file.startsWith(RICH_TEXT_DIR)) continue; // 白名单目录内合法
    const code = await readFile(file, "utf8");
    const hits = code.match(RICH_TEXT_IMPORT) ?? [];
    if (hits.length > 0)
      failures.push(
        `${file} 引了 ${hits.length} 处 \`@blocknote/*\` 或 \`@mantine/*\`（${hits.join(", ")}）—— ` +
          `禁令⑦ 白名单只允许它们出现在 ${RICH_TEXT_DIR} 内；` +
          `依据 docs/adr/0002-rich-text-blocknote.md 与 docs/tech-stack-decision.md §13.6.2`,
      );
  }
}

await assertRichTextWhitelist();

// 禁令⑧ 冒烟脚本卫生（2026-10-14，retro 候选 ①）
// 独立文件：它的理由、误伤面与「抓不到什么」的说明有 60 行，放在 check.mjs 里
// 会把那条"规则写了不等于会触发"的断言挤成两倍长。
const { assertSmokeHygiene } = await import("./smoke-hygiene.mjs");
await assertSmokeHygiene(failures);

// 禁令⑨ 业务日不许写成 UTC 日切片（2026-10-15，MATT-79）
// 与冒烟卫生同款：理由、误伤面、抓不到什么有几十行，放独立文件里。
const { assertNoUtcDaySlice } = await import("./business-day.mjs");
await assertNoUtcDaySlice(failures);

// 禁令⑩ 部署与 CI 配置里不许出现密钥字面量（2026-10-15，MATT-36）
// 独立文件的理由同上：它的「抓不到什么」有一整节，且必须写清
// 「刻意不扫 .env」—— 否则下一个人会以为本门禁能管住本机的真实密钥。
const { assertNoSecretLiterals } = await import("./secret-literals.mjs");
await assertNoSecretLiterals(failures);

// 禁令⑪ 判据脚本可移植（2026-10-16，retro 候选 1 + 2）
// `agent-work/` 是 eslint / prettier / anchors / run-smokes 四道都不读的空白区，
// 于是「脚本起不来」与「功能有缺陷」同形（10 个探针写死 chromium-1224 躺了一个版本周期）。
const { assertJudgePortability } = await import("./judge-portability.mjs");
await assertJudgePortability(failures);

// 禁令⑫ antd 已废弃 API（2026-10-16）
// List → Listy、Space 的 direction → orientation。独立文件的理由同上；
// 另外它按**行号**定位，报出来的每一行都对应一个要改的标签。
const { assertNoAntdDeprecated } = await import("./antd-deprecated.mjs");
await assertNoAntdDeprecated(failures);

if (loaded === 0) failures.push("A 一个 fixture 都没读到，整套断言都是假通过");

if (failures.length > 0) {
  console.error("lint-guard 失败：");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}

console.log(
  `lint-guard 通过：${SCOPES.length} 条禁令 × (违规按数被拦 / 合法不误伤 / 挂载点正确 / 覆盖不被顶掉 / 不溢出)，共 ${loaded} 个 fixture；` +
    `另：源码断言「页头无第二行插槽」0 处 · 「富文本白名单」0 处越界 · 冒烟脚本卫生 0 处裸调用 · 业务日 UTC 切片 0 处 · ` +
    `密钥字面量 0 处 · 判据脚本可移植 0 处违规 · antd 废弃 API 0 处`,
);
