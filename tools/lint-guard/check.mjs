/**
 * 禁令① 的可证伪断言（W0-1）。
 *
 * 为什么需要：`eslint.config.mjs` 里写了 `no-restricted-imports` **不等于它会触发**。
 * glob 打错、`files` 段指错目录、被后面的 config 覆盖 —— 都会让规则静默失效而 CI 全绿。
 * 本项目已经因为"自证脚本覆盖面不足"翻过一次车，所以连 lint 规则也要有回归。
 *
 * 做法：把 fixture 的代码用 `lintText` 以 **`src/shared/` 下的虚拟文件名**喂给仓库自己的
 * config —— 测的是真配置、真路径，而不是另写一份内联 config 自欺欺人。
 *
 * 五道断言，任一失败即 exit 1：
 *   A  fixture 存在且非空（否则 B/C 是"假通过"）
 *   B  违规代码在 src/shared 下必须产出 no-restricted-imports error
 *   C  合法代码在同一规则下必须 0 命中（防规则过宽拦死正常 shared 层）
 *   D  仓库 config 对 src/shared/ 确实挂载了该规则（防 files 段指错目录）
 *   E  该规则不得溢出到 src/app/lib/server/（服务端层本可以用 Node API）
 */
import { readFile } from "node:fs/promises";
import { ESLint } from "eslint";

const RULE = "no-restricted-imports";
const FIXTURE_BAD = "tools/lint-guard/fixtures/bad/shared-forbidden.ts";
const FIXTURE_GOOD = "tools/lint-guard/fixtures/good/shared-allowed.ts";

const failures = [];
const eslint = new ESLint();

/** 以 src/shared 下的虚拟路径 lint 一段代码，走的是仓库 config */
async function lintAsShared(filePath, code) {
  const [result] = await eslint.lintText(code, { filePath: `src/shared/${filePath}` });
  if (!result) throw new Error(`lintText 无结果：${filePath}`);
  return result;
}

let badCode = "";
let goodCode = "";
try {
  badCode = await readFile(FIXTURE_BAD, "utf8");
  goodCode = await readFile(FIXTURE_GOOD, "utf8");
} catch (e) {
  failures.push(`A fixture 读不到（${e.code}）：${e.path ?? "?"}`);
}
if (badCode.trim() === "") failures.push("A 违规 fixture 为空，断言 B 会假通过");
if (goodCode.trim() === "") failures.push("A 合法 fixture 为空，断言 C 会假通过");

if (failures.length === 0) {
  const bad = await lintAsShared("__guard_bad__.ts", badCode);
  const hits = bad.messages.filter((m) => m.ruleId === RULE && m.severity === 2);
  if (hits.length === 0) {
    failures.push(
      `B 违规代码未被拦下（禁令① 静默失效）。该文件实际报出的规则：` +
        JSON.stringify(bad.messages.map((m) => m.ruleId)),
    );
  }

  const good = await lintAsShared("__guard_good__.ts", goodCode);
  const falsePositives = good.messages.filter((m) => m.ruleId === RULE);
  if (falsePositives.length > 0) {
    failures.push(
      `C 合法代码被误拦：${falsePositives.map((m) => m.message).join("；")}（规则过宽会挡住正常 shared 层）`,
    );
  }

  const sharedCfg = await eslint.calculateConfigForFile("src/shared/probe.ts");
  const sharedRule = sharedCfg?.rules?.[RULE];
  const sharedOn = sharedRule?.[0] === "error" || sharedRule?.[0] === 2;
  if (!sharedOn) {
    failures.push(
      `D src/shared/ 上 ${RULE} 未生效：files 段指错了目录（拿到 ${JSON.stringify(sharedRule)}）`,
    );
  }

  const serverCfg = await eslint.calculateConfigForFile("src/app/lib/server/probe.ts");
  const serverRule = serverCfg?.rules?.[RULE];
  const serverOn = serverRule?.[0] === "error" || serverRule?.[0] === 2;
  if (serverOn) {
    failures.push("E 禁令① 溢出到 src/app/lib/server/ —— 服务端层允许用 Node API，会被误伤");
  }
}

if (failures.length > 0) {
  console.error("lint-guard（禁令①）失败：");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}

console.log("lint-guard 通过：违规被拦 / 合法不误伤 / 规则只作用于 src/shared（app 层不受影响）");
