// 全量原型的机械体检：外链、脚本、旧世界残留、深色副本齐备、骨架完整、三份清单一致。
import fs from "node:fs";
import path from "node:path";

const dir = path.resolve(".impeccable/mocks/pages");
const SKIP = new Set(["index.html", "direction.html", "_sheet.html"]);
const pages = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith(".html") && !SKIP.has(f) && !/-dark\.html$/.test(f))
  .sort();

let bad = 0;
for (const f of pages) {
  const p = path.join(dir, f);
  const html = fs.readFileSync(p, "utf8");
  const issues = [];
  if (!html.includes('href="canon.css"')) issues.push("缺 canon.css");
  if (/<script/i.test(html)) issues.push("含 <script>");
  if (/https?:\/\//.test(html)) issues.push("含外部 http 链接");
  if (/<img|url\(|@import/i.test(html)) issues.push("含图片/外链资源");
  if (/cinnabar|world\.css|--paper|--jibiao/.test(html)) issues.push("含旧世界残留");
  if (!f.startsWith("login") && !html.includes('class="nav"')) issues.push("缺导航骨架");
  if (!html.includes('class="topbar"') && !f.startsWith("login")) issues.push("缺顶栏");
  if (!/colgroup/.test(html) && !/class="(login|grid2|dl)/.test(html) && !f.startsWith("login")) {
    if (!/class="card/.test(html)) issues.push("既无表也无卡");
  }
  const dark = path.join(dir, f.replace(/\.html$/, "-dark.html"));
  if (!fs.existsSync(dark)) issues.push("缺深色副本");
  if (issues.length) {
    bad++;
    console.log(`✗ ${f} — ${issues.join("；")}`);
  }
}
console.log(bad === 0 ? `✓ ${pages.length} 页全部通过体检` : `共 ${bad} 页有问题`);

/**
 * 三份清单必须指向同一批页（研究结论见 docs/research-prototype-platform-feasibility.md §2.1）。
 *
 * 已经一致的三方是：目录里的浅色页 / `index.html` 链接的页 / `canon-spec.md` 引用的文件名。
 * 这条断言防的是**下一次加页时漏掉其中一处** —— 那种漏不会让任何单页体检变红
 * （新页自己可能是合格的），只会让它从画廊或施工规格里消失。
 *
 * 只比集合，不比编号：编号在两处按不同哲学排（spec 按业务流程、index 按界面形态），
 * 是既存事实，不是漂移；把它塞进断言只会换来一次 31 行的噪音 diff。
 */
function checkManifests() {
  const light = new Set(pages);

  const idxHtml = fs.readFileSync(path.join(dir, "index.html"), "utf8");
  const idxLinked = new Set(
    [...idxHtml.matchAll(/href="([a-z0-9-]+\.html)"/g)]
      .map((m) => m[1])
      .filter((f) => !f.endsWith("-dark.html")),
  );

  const specPath = path.resolve(".impeccable/mocks/canon-spec.md");
  const specHtml = fs.readFileSync(specPath, "utf8");
  const specNamed = new Set([...specHtml.matchAll(/`([a-z0-9-]+\.html)`/g)].map((m) => m[1]));

  const problems = [];
  const diff = (a, b, aName, bName) =>
    [...a].filter((f) => !b.has(f)).sort().map((f) => `${aName} 有、${bName} 没有：${f}`);

  problems.push(...diff(light, idxLinked, "pages/", "index.html"));
  problems.push(...diff(idxLinked, light, "index.html", "pages/"));
  problems.push(...diff(light, specNamed, "pages/", "canon-spec.md"));
  problems.push(...diff(specNamed, light, "canon-spec.md", "pages/"));

  // canon-spec 的页面清单**不含** workbench（它只作为骨架模板被提到），
  // 所以上面那一对比的是「被引用的文件名」，不是「清单条目」——这正是比集合而非比条目的原因。
  if (problems.length) {
    for (const p of problems) console.log(`✗ 清单不一致 — ${p}`);
    return problems.length;
  }
  console.log(`✓ 三份清单一致（各 ${light.size} 页）`);
  return 0;
}

bad += checkManifests();

/**
 * ⚠ 退出码必须跟着 `bad` 走。
 *
 * 2026-10-20 实测：本脚本此前**报出 6 个问题仍退出 0**（造一个无 canon.css、含 `<script>`、
 * 无 nav 的页面即可复现）。而 `prototype-guidelines.md` 在文档里把它写成「门禁」——
 * 一个永远绿的判据比没有判据更糟，因为它让人相信已经守住了。
 * 同一天补上：`_chk/check-headings.mjs` 也有一模一样的问题。
 */
process.exitCode = bad === 0 ? 0 : 1;
