/**
 * 三道禁令的可证伪断言（W0-1 起，Demo 那轮加到三条）。
 *
 * 为什么需要：`eslint.config.mjs` 里写了 `no-restricted-imports` **不等于它会触发**。
 * glob 打错、`files` 段指错目录、被后面的 config 覆盖 —— 都会让规则静默失效而 CI 全绿。
 * 本项目已经因为"自证脚本覆盖面不足"翻过一次车，所以连 lint 规则也要有回归。
 *
 * 做法：把 fixture 的代码用 `lintText` 以**仓库 config 真正会命中的虚拟路径**喂给本 config
 * —— 测的是真配置、真路径，而不是另写一份内联 config 自欺欺人。
 *
 * 每个 scope 五道断言，任一失败即 exit 1：
 *   A  fixture 存在且非空（否则 B/C 是"假通过"）
 *   B  违规代码在该 scope 下必须产出 no-restricted-imports error
 *   C  合法代码在同一 scope 下必须 0 命中（防规则过宽）
 *   D  config 对该 scope 的挂载路径确实开了这条规则（防 files 段指错目录）
 *   E  该 scope 的规则不得溢出到"本该允许"的路径（防误伤）
 */
import { readFile } from "node:fs/promises";
import { ESLint } from "eslint";

const RULE = "no-restricted-imports";

/**
 * 三个 scope。每个都自带"该被拦的写法 / 不该被拦的写法 / 挂载点 / 不该扩到的地方"。
 * 新增禁令时往这里加一行即可 —— check 的逻辑是通用的，别再复制一份五连。
 */
const SCOPES = [
  {
    id: "禁令① shared 层纯净",
    bad: "tools/lint-guard/fixtures/bad/shared-forbidden.ts",
    good: "tools/lint-guard/fixtures/good/shared-allowed.ts",
    /** 喂进去时假装自己是这个路径下的文件 */
    badPath: "src/shared/__guard_bad__.ts",
    goodPath: "src/shared/__guard_good__.ts",
    mountedAt: "src/shared/probe.ts",
    mustNotReach: "src/app/lib/server/probe.ts",
    whyOverflow: "服务端层允许用 Node API，会被误伤",
  },
  {
    id: "禁令⑦ 一套组件体系",
    bad: "tools/lint-guard/fixtures/bad/ui-direct-primitive.ts",
    good: "tools/lint-guard/fixtures/good/ui-via-wrapper.ts",
    badPath: "src/app/components/__guard_bad__.ts",
    goodPath: "src/app/components/__guard_good__.ts",
    mountedAt: "src/app/(desk)/matters/probe.ts",
    mustNotReach: "src/app/components/ui/select.ts",
    whyOverflow: "components/ui/ 那一层就是用来包原语的，规则扩到这儿等于没有合法写法",
  },
  {
    id: "禁令⑥⑤ 页面壳不碰数据层",
    bad: "tools/lint-guard/fixtures/bad/shell-imports-server.ts",
    good: "tools/lint-guard/fixtures/good/shell-page.ts",
    badPath: "src/app/(desk)/matters/__guard_bad__/page.tsx",
    goodPath: "src/app/(desk)/matters/__guard_good__/page.tsx",
    mountedAt: "src/app/(desk)/probe/page.tsx",
    mustNotReach: "src/app/api/matters/route.ts",
    whyOverflow: "handler 层按定义就要碰 DB，规则扩到 /api 会逼人在页面里写查询",
  },
];

const failures = [];
const eslint = new ESLint();

let loaded = 0;
for (const scope of SCOPES) {
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
  const hits = (bad?.messages ?? []).filter((m) => m.ruleId === RULE && m.severity === 2);
  if (hits.length === 0) {
    failures.push(
      `${scope.id} · B 违规代码未被拦下（规则静默失效）。` +
        `该路径实际报出的规则：${JSON.stringify((bad?.messages ?? []).map((m) => m.ruleId))}`,
    );
  }

  const [good] = await eslint.lintText(goodCode, { filePath: scope.goodPath });
  const falsePositives = (good?.messages ?? []).filter((m) => m.ruleId === RULE);
  if (falsePositives.length > 0) {
    failures.push(
      `${scope.id} · C 合法代码被误拦：${falsePositives.map((m) => m.message).join("；")}（规则过宽）`,
    );
  }

  const mounted = await eslint.calculateConfigForFile(scope.mountedAt);
  const mountedRule = mounted?.rules?.[RULE];
  if (!(mountedRule?.[0] === "error" || mountedRule?.[0] === 2)) {
    failures.push(
      `${scope.id} · D 在 ${scope.mountedAt} 上 ${RULE} 未生效：files 段指错了目录（拿到 ${JSON.stringify(mountedRule)}）`,
    );
  }

  const outside = await eslint.calculateConfigForFile(scope.mustNotReach);
  const outsideRule = outside?.rules?.[RULE];
  if (outsideRule?.[0] === "error" || outsideRule?.[0] === 2) {
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
  `lint-guard 通过：${SCOPES.length} 条禁令 × (违规被拦 / 合法不误伤 / 挂载点正确 / 不溢出)，共 ${loaded} 个 fixture`,
);
