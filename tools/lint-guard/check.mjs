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

if (loaded === 0) failures.push("A 一个 fixture 都没读到，整套断言都是假通过");

if (failures.length > 0) {
  console.error("lint-guard 失败：");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}

console.log(
  `lint-guard 通过：${SCOPES.length} 条禁令 × (违规按数被拦 / 合法不误伤 / 挂载点正确 / 覆盖不被顶掉 / 不溢出)，共 ${loaded} 个 fixture`,
);
