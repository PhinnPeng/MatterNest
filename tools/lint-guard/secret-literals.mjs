/**
 * 禁令⑩ 部署与 CI 配置里不许出现密钥字面量（2026-10-15，MATT-36）。
 *
 * ## 防的是什么
 *
 * 三把密钥的托管口径已裁定：**只经 `environment:` 注入，不入库、不进镜像、不进 git**
 * （`docs/research-secret-storage.md`）。产出方式是 `node tools/keys.mjs gen`，
 * 操作手册在 `deploy/README.md`「三把密钥怎么产出」一节 —— 与部署步骤同一个文件，
 * 是为了让「产出」与「怎么部署」不在两处各说一半。
 *
 * 有了产出工具之后，**唯一还可能把密钥字面量写回仓库的路径**就是配置文件：
 * 有人为了「让 CI 先跑起来」给 `MN_AES_KEY` 塞一个占位值。那正是本条要拦的。
 *
 * ## 它拦的是一个已经发生过的真实形态
 *
 * MATT-36 落地前的 `.github/workflows/ci.yml` 写着：
 *
 * ```yaml
 * MN_AES_KEY: ${{ secrets.MN_AES_KEY || '0000...0000' }}
 * MN_HMAC_KEY: ${{ secrets.MN_HMAC_KEY || '0000...0000' }}
 * ```
 *
 * 两个问题，第二个更隐蔽：
 *   1. 固定明文当密钥 —— OWASP SM §2.7.1 要求「cryptographically robust enough
 *      for their purpose」，而 `0000…0` 是熵为 0 的常量；
 *   2. ⚠ **`MN_AES_KEY` 与 `MN_HMAC_KEY` 的兜底值逐字相同** ⇒ 违反 NIST
 *      SP 800-57 Pt1 R5 §5.2 的 `shall`（一条 key 只做一个用途），而它躺在
 *      **我们自己 CI 里**、运行了很久没人发现。
 *
 * 第 2 条是这条禁令存在的理由：它不是「防止有人泄密」，而是**防止有人为了让 CI
 * 变绿而绕过那三把密钥的启动期断言**。现在 CI 改为运行时 `keys:gen`，
 * 而启动期自检会拦「三把相同」⇒ 把占位值加回来会让 CI 立刻起不来。
 * 这条禁令把那条因果链的**前半段**也钉住：不让它被悄悄加回来。
 *
 * ## 扫描范围为什么是这几个目录，而不是 `src/**`
 *
 * · `.github/workflows/**` —— CI 注入三把的地方；
 * · `deploy/**` —— 生产 compose 与 Dockerfile；
 * · `.env.example` —— 会被复制成 `.env` 的模板。
 *
 * ⚠ **刻意不扫 `.env`**：那是每个开发者本地的真实密钥所在的文件，
 * 扫它会把「你本机有密钥」报成违规，而那是完全正常的状态。
 *
 * ## 误伤面
 *
 * 允许的三种形态（都**不含**任何密钥字节）：
 *   · `MN_AES_KEY=` —— 空值（`.env.example` 与 compose 的默认槽）
 *   · `MN_AES_KEY: ${MN_AES_KEY:-}` —— compose 的环境变量间接
 *   · `MN_AES_KEY: ${{ secrets.MN_AES_KEY }}` —— 纯 secret 引用（无 `||` 回落）
 *
 * ## 抓不到什么（别高估它）
 *
 * · **变量名写错**：本条只看 `MN_AES_KEY|MN_HMAC_KEY|MN_SESSION_PEPPER` 三个名字。
 *   写成 `AES_KEY` 不会被扫到 —— 但那会让应用起不来（`parseKeyMaterial` 抛），
 *   所以它会以「启动失败」的形式暴露，而不是静默。
 * · **运行时拼出来的值**：`AES: ${MN_}_KEY` 之类的间接拼接扫不到（YAML 不允许）。
 * · **注释里的示例值**：本条**剥掉 `#` 注释**再匹配，与禁令⑨ 同理 ——
 *   「解释不要写死密钥」这件事自然要把形状写出来。
 * · **仓库外的机器**：本条管不了在部署机上直接 `echo` 进 `.env`。那是运维动作，
 *   由 `tools/keys.mjs` 的护栏（拒绝覆盖已填的 env）兜。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";

/** .gitignore 的 `.env` / `.env.*` 规则（唯一例外是 `.env.example`） */
const GITIGNORED_ENV = /^\.env/;

/** 只为上面那个「大文件上限」服务 */
const sizeOf = (p) => {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
};
import { join } from "node:path";

/** 只扫这些；每个都是「会被复制/部署出去」的配置文件 */
const ROOTS = [".github/workflows", "deploy"];
const EXTRA_FILES = [".env.example"];

const SECRET_NAMES = ["MN_AES_KEY", "MN_HMAC_KEY", "MN_SESSION_PEPPER"];

/** 由上面那三个名字拼出的匹配式 —— **唯一来源**。
 *  别在别处再写一遍这三个名字：改一处忘一处的话，门禁会静默放过新名字下的字面量，
 *  而那正是「扫到 0 处 ⇒ 假绿」的同一类失效。 */
const SECRET_ASSIGN = new RegExp(
  "^\\s*(?:ENV\\s+)?(" + SECRET_NAMES.join("|") + ")\\s*[:=]\\s*(.*)$",
);

/** 允许的「值」形态：空、compose 间接、纯 secret 引用 */
const ALLOWED_VALUE = [
  /^$/,
  // ⚠ `:-` 后面**不许有默认值**（评审实测：`${MN_AES_KEY:-<64 个 0>}` 能整条溜过去，
  //   而它与本条要杀的 `secrets.X || '<字面量>'` 是同一个意图的两种写法 ——
  //   `docker-compose.yml` 里现在写的就是 `${MN_AES_KEY:-}`，一个字符之差而已）。
  /^\$\{[A-Za-z0-9_]+(:-)?\}$/,
  /^\$\{\{\s*secrets\.[A-Za-z0-9_]+\s*\}\}$/,
];

function* walk(path) {
  let st;
  try {
    st = statSync(path);
  } catch {
    return;
  }
  if (st.isFile()) {
    yield path;
    return;
  }
  for (const name of readdirSync(path)) {
    yield* walk(join(path, name));
  }
}

/**
 * 剥掉 `#` 注释。
 *
 * 只认**行首或空白后的** `#`，且不处理引号内的 `#` —— YAML 的行尾 `#` 注释
 * 在本仓这几个文件里都没有引号包裹的情形。若将来出现，那条会被当成
 * 「值里有字面量」而误报；方向是**误报**而不是漏报，可以接受。
 */
function stripComments(text) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const at = line.search(/(^|\s)#/);
      return at < 0 ? line : line.slice(0, at);
    })
    .join("\n");
}

export async function assertNoSecretLiterals(failures) {
  const files = [];
  for (const root of ROOTS) files.push(...walk(root));
  for (const f of EXTRA_FILES) files.push(...walk(f));

  let assignments = 0;
  let scanned = 0;
  const seenNames = new Set();

  for (const file of files) {
    // ⚠ **跳过 gitignore 的真实密钥文件**（`.env` / `.env.local` / `.env.prod` …，
    //    规则见 .gitignore 的 `.env` / `.env.*` / `!.env.example`）。
    //    它们永远进不了仓库 ⇒ 扫它们不产生任何门禁价值，却会让**本机有
    //    deploy/.env.prod 的运维每次跑 lint-guard 都误报**。只留 `.env.example`。
    if (GITIGNORED_ENV.test(basename(file)) && basename(file) !== ".env.example") continue;
    // 按**内容**判文本，不按扩展名（评审实测：`deploy/Dockerfile` 不匹配任何扩展名清单，
    // 而它是要进仓库的 —— 扩展名清单是猜的，含 NUL 字节才是真的）。
    if (sizeOf(file) > 256 * 1024) continue;
    const raw = readFileSync(file);
    if (raw.includes(0)) continue; // 二进制
    const body = stripComments(raw.toString("utf8"));
    scanned++;

    body.split(/\r?\n/).forEach((line, i) => {
      const m = SECRET_ASSIGN.exec(line);
      if (!m) return;
      assignments++;
      seenNames.add(m[1]);
      const value = m[2].trim();
      if (ALLOWED_VALUE.some((re) => re.test(value))) return;
      // 单独点出 `||` 回落：它是本条拦的那个具体形态，且消息要能指给人看
      const why = value.includes("||")
        ? "`||` 回落 —— 配错 secret 名字时它在 CI 里永远不暴露，而缺值本该立刻暴露"
        : "非空的字面量";
      failures.push(
        `${file}:${i + 1} ${m[1]} 带${why}。密钥由 node tools/keys.mjs gen 产出、` +
          `node tools/keys.mjs check 核对，配置里只放 ${m[1]}= 或 \${${m[1]}:-}` +
          `（依据：deploy/README.md「密钥托管口径」）`,
      );
    });
  }

  // canary：扫到 0 个文件或 0 条赋值 ⇒ 下面「没报违规」是假绿。
  // 本仓对「扫到 0 处」有真实戒心（禁令⑧ 的「扫到 0 处是假通过」、禁令⑨ 同款）。
  if (scanned === 0) {
    failures.push(
      `禁令⑩ 一个文件都没扫到（扫了 ${scanned} 个）—— 路径写错了，或配置被挪出了 ROOTS/EXTRA_FILES。` +
        `此时本禁令会「全部通过」而什么都没验`,
    );
  }
  // 逐把要求，而不是「总共见过 ≥1 条」：评审实测后者太弱 ——
  // 把三把从 ci.yml 与 docker-compose.yml 里**全删掉**，本禁令仍然绿。
  const missingNames = SECRET_NAMES.filter((n) => !seenNames.has(n));
  if (missingNames.length > 0) {
    failures.push(
      `禁令⑩ 这几把在 ${scanned} 个被扫文件里一次都没出现：${missingNames.join(" / ")} —— ` +
        `要么它们被改名了（那本禁令就扫不到了），要么匹配式失效。此刻它是假绿`,
    );
  }

  return { scanned, assignments };
}
