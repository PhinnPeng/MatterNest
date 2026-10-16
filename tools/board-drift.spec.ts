import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gradeBoard, readCommits } from "./board-drift.mjs";

/**
 * 漂移探测器的证据测试（#85）。
 *
 * ## 为什么分成两个 seam
 *
 * **Seam 1 `gradeBoard`** —— 分级判据本身。这是全部的价值所在：
 * 「未见带票号」与「做完没关」的归类错了，这个工具就是在制造噪音，
 * 而噪音的工具第一次就会被放弃。
 *
 * **Seam 2 CLI 的退出码与 canary** —— 「扫到 0 处却报绿」是本仓反复栽过的形态
 * （禁令⑧ 的「扫到 0 处是假通过」、禁令⑨、禁令⑩ 各一条）。
 *
 * ## 为什么要喂快照而不是让工具自己查票
 *
 * 仓库明令 Paca 只经 MCP，REST 兜底路径已被删除且**不应重建**
 * （`docs/agents/issue-tracker.md`：删它的直接原因是一个按标题 upsert 的
 * 脚本静默覆盖了 32 张卡的描述）。所以工具读不到票状态 ——
 * 票侧由 agent 经 MCP 取来、作为一个快照文件喂进来，git 侧工具自己读。
 */

const TOOL = "tools/board-drift.mjs";
const DAY = 86400000;
const NOW = Date.parse("2026-10-15T00:00:00Z");
/** 「末次提交距今 ≤ 14 天」算收尾提交，不算漂移（裁定：阈值压掉收尾提交） */
const STALE_DAYS = 14;

let dir: string;

const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

/** 票侧快照（由 agent 经 MCP 取得） */
const board = (entries: Record<string, string>) => ({
  capturedAt: "2026-10-15T00:00:00Z",
  tickets: Object.fromEntries(
    Object.entries(entries).map(([n, status]) => [n, { status, title: n }]),
  ),
});

/** git 侧：票 → 末次提交 */
const commits = (entries: Record<string, string>) =>
  Object.fromEntries(Object.entries(entries).map(([n, at]) => [n, { lastCommitAt: at, count: 1 }]));

const grade = (b: object, c: object) =>
  gradeBoard(b as never, c as never, { now: NOW, staleDays: STALE_DAYS });

beforeAll(() => {
  /**
   * **把 git 的定位类变量从进程环境里清掉**（2026-10-16，MATT-92）。
   *
   * 钩子会带着它们跑 `pnpm verify`：git 给 linked worktree 的提交注入
   * `GIT_DIR` / `GIT_INDEX_FILE`（普通仓提交不注入 —— 实测对照过），
   * 而下面的临时仓夹具继承 `process.env`。继承一次就够：夹具在「临时目录」里
   * 跑的 `git init` 会把 `GIT_DIR` 指的那个仓**翻成 `core.bare=true`**，
   * `git config` 会写它的配置，`git commit` 会提交进它并再触发钩子 ⇒ 自激循环。
   * 真咬过：主仓被写掉身份、被写成裸仓，22:18 那次 `invalid object` 也是它。
   *
   * 清掉之后，下面每条命令都只可能作用在**自己刚建的临时仓**上；
   * `repo()` 里还有一条断言把这件事钉死。
   */
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("GIT_")) delete process.env[k];
  }
  dir = mkdtempSync(join(tmpdir(), "mn-drift-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("gradeBoard：两种漂移分开报（处置方向相反）", () => {
  it("**未见带票号的提交** = 非 Done 且一个带票号的提交都没有", () => {
    const r = grade(board({ "MATT-1": "Todo", "MATT-2": "Done" }), commits({}));
    expect(r.notStarted.map((t) => t.ticket)).toEqual(["MATT-1"]);
  });

  it("**做完没关** = 非 Done、且有带票号的提交", () => {
    const r = grade(board({ "MATT-84": "Backlog" }), commits({ "MATT-84": ago(20) }));
    expect(r.doneNotClosed.map((t) => t.ticket)).toEqual(["MATT-84"]);
    // 距今天数是**显示列**，供读者排优先级用
    expect(r.doneNotClosed[0].ageDays).toBe(20);
  });

  /**
   * **没有时间阈值** —— 这条是被真数据推翻后钉死的。
   *
   * 原裁定：末次提交 < 14 天的算「收尾提交」，不算漂移。2026-10-15 真跑全板时，
   * 14 张**当天交付、当天没关**的票全被塞进那一段，而「做完没关」那段是 0 ——
   * 阈值恰好把要找的用例藏了起来。
   *
   * 根因是推理里的错：`Done` 的票在分级循环开头就 `continue` 了，所以「关票后的
   * 收尾提交」这种噪音**根本到不了分级** —— 阈值解决的是一个不存在的问题。
   *
   * 所以：**当天交付当天没关，必须立刻报出来**。这两条钉住「1 天前」和「99 天前」
   * 得到同样的处置 —— 都是关票。
   */
  it("**刚做完没关的**（1 天前）照样算漂移 —— 不因时间近而放过", () => {
    const r = grade(board({ "MATT-84": "Backlog" }), commits({ "MATT-84": ago(1) }));
    expect(r.doneNotClosed.map((t) => t.ticket)).toEqual(["MATT-84"]);
  });

  it("**躺了很久没关的**（99 天前）同样算漂移 —— 不因时间远而降级", () => {
    const r = grade(board({ "MATT-85": "Backlog" }), commits({ "MATT-85": ago(99) }));
    expect(r.doneNotClosed.map((t) => t.ticket)).toEqual(["MATT-85"]);
    expect(r.doneNotClosed[0].ageDays).toBeGreaterThan(STALE_DAYS);
  });

  it("两段互斥：一张票不会同时落进「未见带票号的提交」", () => {
    const r = grade(
      board({ "MATT-84": "Backlog", "MATT-86": "Todo" }),
      commits({ "MATT-84": ago(1) }),
    );
    expect(r.doneNotClosed.map((t) => t.ticket)).toEqual(["MATT-84"]);
    expect(r.notStarted.map((t) => t.ticket)).toEqual(["MATT-86"]);
  });

  it("已 Done 的票不报 —— 关掉之后仍有提交是正常的", () => {
    const r = grade(board({ "MATT-40": "Done" }), commits({ "MATT-40": ago(1) }));
    expect(r.notStarted).toHaveLength(0);
    expect(r.doneNotClosed).toHaveLength(0);
  });

  it("**快照里没有的票出现在提交里 ⇒ 报「快照不完整」**", () => {
    // 这是 canary 那一维：快照不完整会让下面三段**整体漏报**，而工具自己看不出来
    const r = grade(
      board({ "MATT-1": "Todo" }),
      commits({ "MATT-1": ago(40), "MATT-99": ago(40) }),
    );
    expect(r.commitsNotInBoard.map((t) => t.ticket)).toEqual(["MATT-99"]);
    expect(r.ok).toBe(false);
  });

  it("快照为空 ⇒ ok=false（否则「三段全空」会被读成「没有漂移」）", () => {
    const r = grade({ capturedAt: "x", tickets: {} }, commits({ "MATT-1": ago(40) }));
    expect(r.notStarted).toHaveLength(0);
    expect(r.doneNotClosed).toHaveLength(0);
    expect(r.ok).toBe(false);
  });

  it("git 侧完全没有 MATT 提交 ⇒ ok=false", () => {
    const r = grade(board({ "MATT-1": "Todo" }), {});
    expect(r.ok).toBe(false);
  });

  it("**真实场景的形状**（本会话实测过的）：已交付但忘关的票都落进第二段", () => {
    const r = grade(
      board({ "MATT-69": "Todo", "MATT-74": "Backlog", "MATT-85": "Todo" }),
      commits({ "MATT-69": ago(1), "MATT-74": ago(1) }),
    );
    expect(r.notStarted.map((t) => t.ticket)).toEqual(["MATT-85"]);
    expect(r.doneNotClosed.map((t) => t.ticket)).toEqual(["MATT-69", "MATT-74"]);
  });
});

describe("readCommits：git 适配器（唯一没被 Seam 1 盖到的地方）", () => {
  /**
   * 这个 bug 已经真咬过一次：`git --grep` 搜的是**整条**消息，而只解析 `%s`（标题行）
   * 时，「票号只写在正文里」的提交会被 grep 命中、却提取不出来 ⇒ 那张票被判成
   * 「未见带票号的提交」。2026-10-15 真跑全板时，本会话**自己**的 6 张已交付票全落进
   * 那一段 —— 而其中 4 张会被读者拿去「排期」，也就是重做一遍。
   *
   * `gradeBoard` 的单测抓不到它（输入是手造的），所以这里用一个**真的临时 git 仓**
   * 来钉。
   */
  const repo = () => {
    /**
     * **先挡环境**：定位类变量在场就说明「cwd 说了不算」（2026-10-16，MATT-92）。
     *
     * 这条要在**任何 git 命令之前**判 —— 真咬过的那次，`git init` 一跑就把真仓
     * 翻成了 `core.bare=true`，事后再发现已经晚了。
     */
    for (const k of Object.keys(process.env)) {
      if (
        /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|COMMON_DIR|ALTERNATE_OBJECT_DIRECTORIES)$/.test(
          k,
        )
      ) {
        throw new Error(
          `环境里带着 ${k}=${process.env[k]} —— git 会绕开 cwd 去打那个仓（MATT-92）`,
        );
      }
    }

    const d = mkdtempSync(join(tmpdir(), "mn-git-"));
    const g = (...args: string[]) => execFileSync("git", args, { cwd: d, encoding: "utf8" });
    g("init", "-q");

    /**
     * **再钉一次结果**：这个仓就是我刚在临时目录里建的那个。
     *
     * 上面挡的是「已知的」泄漏形态；这条挡住「没预料到的」那些（`GIT_CONFIG_*`、
     * `core.worktree`、别的路径变量）。宁可测试当场红，也不要静默去写别人的仓。
     */
    // 比路径要当心 Windows 的 8.3 短名：mkdtemp 给的是 `C:\Users\ADMINI~1\…`，
    // git 回的是长名 —— `realpathSync.native` 把两边都规范化成长名再比，别被写法骗红。
    const canon = (p: string) => realpathSync.native(p).toLowerCase();
    const actual = canon(g("rev-parse", "--absolute-git-dir").trim());
    const want = canon(join(d, ".git"));
    if (actual !== want) {
      throw new Error(
        `临时仓没建在临时目录里：git 解析到 ${actual}（期望 ${want}）——` +
          `这种状态下每条命令都在写别人的仓（MATT-92）`,
      );
    }

    g("config", "user.email", "t@example.com");
    g("config", "user.name", "t");
    return { d, g };
  };

  /**
   * 带固定日期的提交。
   *
   * 默认作者日期与提交者日期**一起**钉 —— `git log` 按提交者日期排序，只钉作者日期的话，
   * 排序与断言就落在两个基准上，那正是工具刚改过的那处。
   *
   * `authorDate` 可单独给，用来模拟 rebase / cherry-pick 之后两者的分叉。
   */
  const at = (d: string, date: string, subject: string, body: string, authorDate?: string) =>
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", subject, "-m", body], {
      cwd: d,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: authorDate ?? date,
        GIT_COMMITTER_DATE: date,
      },
    });

  const commit = (g: (...a: string[]) => string, subject: string, body: string) => {
    g("commit", "-q", "--allow-empty", "-m", subject, "-m", body);
  };

  it("**票号只写在正文里**（标题行不提）也要算进这张票", () => {
    const { d, g } = repo();
    try {
      // 标题行里没有票号 —— 这正是本会话踩到的形态
      commit(g, "fix(冒烟): 报表夹具移出分档边界", "本条修的是 MATT-84。");
      const found = readCommits(d);
      expect(Object.keys(found)).toContain("MATT-84");
      expect(found["MATT-84"].count).toBe(1);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("一条提交提多张票 ⇒ 每张都算进去，且**末次**取最新那条的时间", () => {
    const { d } = repo();
    try {
      // 两条：较新的那条同时提 MATT-1 与 MATT-2，较旧的只提 MATT-1
      // 作者日期与提交者日期**都**钉住：`git log` 按提交者日期排序，
      // 只钉作者日期的话，排序与断言就落在两个基准上了。
      // ⚠ 顺序必须是「旧先、新后」：真实历史里子提交总是更新的，
      // 而 `git log` 按提交者日期倒序 —— 若让较新的那条当了父提交，
      // 较旧的子提交就会排在最前，「先到即末次」这条推理就被数据本身破坏了。
      at(d, "2020-01-01T00:00:00", "旧", "MATT-1");
      at(d, "2020-01-02T00:00:00", "新", "MATT-1 MATT-2");
      const found = readCommits(d);
      expect(Object.keys(found).sort()).toEqual(["MATT-1", "MATT-2"]);
      expect(found["MATT-1"].count).toBe(2);
      // git log 是倒序 ⇒ 先到的那条才是末次
      expect(found["MATT-1"].lastCommitAt.slice(0, 10)).toBe("2020-01-02");
      expect(found["MATT-2"].lastCommitAt.slice(0, 10)).toBe("2020-01-02");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  /**
   * 钉住「时间取提交者日期 %cd，不是作者日期 %ad」。
   *
   * `git log` 的排序依据是提交者日期，所以「倒序第一条即末次」这条推理只在同一个基准上
   * 成立。两者在 rebase / cherry-pick 之后会分叉 —— 取错会让「末次提交距今」偏向一条
   * 实际更早的提交，而它是读者排优先级的依据。
   *
   * 上面的用例把两个日期设成一样，**抓不到**这个区别（反向红验过：改回 %ad 一条都不挂）。
   */
  it("作者日期 ≠ 提交者日期时，取**提交者日期**（与 git log 的排序同基准）", () => {
    const { d, g } = repo();
    try {
      commit(g, "父", "MATT-7");
      // 作者日期给 2020-01-01，提交者日期给 2020-06-01 —— 分叉形态
      at(d, "2020-06-01T00:00:00", "子", "MATT-7", "2020-01-01T00:00:00");
      const found = readCommits(d);
      expect(found["MATT-7"].lastCommitAt.slice(0, 10)).toBe("2020-06-01");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("提交里**没有**任何 MATT-nx ⇒ 返回空对象（不是 null、不是抛错）", () => {
    const { d, g } = repo();
    try {
      commit(g, "无关提交", "正文也没有票号");
      expect(readCommits(d)).toEqual({});
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("不是 git 仓 / git 失败 ⇒ **抛错**，不静默返回空（空会被读成「没有漂移」）", () => {
    const d = mkdtempSync(join(tmpdir(), "mn-nogit-"));
    try {
      expect(() => readCommits(d)).toThrow();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  /**
   * **反向红**：环境里带着 `GIT_DIR` 时，夹具必须当场拒绝、一个字节都不碰别的仓。
   *
   * 这条钉的是 2026-10-16 的真事故（MATT-92）：钩子把 `GIT_DIR` 泄漏进 verify，
   * 夹具的三条命令于是全部打在真仓上 —— 写掉身份、把仓翻成 `core.bare=true`，
   * 还靠「提交 → 钩子 → verify → 夹具再提交」自激。
   *
   * 去掉 `repo()` 里那两条守卫，这条用例就会挂成「静默把替身仓写了」。
   */
  it("环境里带着 GIT_DIR ⇒ 夹具当场拒绝，替身仓一个字节都没动", () => {
    const victim = mkdtempSync(join(tmpdir(), "mn-victim-"));
    execFileSync("git", ["init", "-q"], { cwd: victim });
    const before = readFileSync(join(victim, ".git/config"), "utf8");
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = join(victim, ".git");
    try {
      expect(() => repo()).toThrow(/GIT_DIR/);
      expect(readFileSync(join(victim, ".git/config"), "utf8")).toBe(before);
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
      rmSync(victim, { recursive: true, force: true });
    }
  });
});

describe("CLI：退出码与 canary", () => {
  const snap = (obj: object) => {
    const p = join(dir, `snap-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(p, JSON.stringify(obj), "utf8");
    return p;
  };

  const commitsFile = (obj: object) => {
    const p = join(dir, `cm-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(p, JSON.stringify(obj), "utf8");
    return p;
  };

  it("正常跑 ⇒ 退出码 0，且打印三段标题", () => {
    const p = snap(board({ "MATT-1": "Todo", "MATT-2": "Backlog" }));
    const c = commitsFile({ "MATT-2": { lastCommitAt: ago(30), count: 2 } });
    const r = spawnSync(process.execPath, [TOOL, "--board", p, "--commits", c], {
      encoding: "utf8",
    });
    const out = `${r.stdout}${r.stderr}`;
    expect(r.status).toBe(0);
    expect(out).toContain("未见带票号的提交");
    expect(out).toContain("做完没关");
    // 分级真的落到了对应段，而不只是把标题打出来
    expect(out).toMatch(/MATT-2\s+Backlog/);
  });

  /**
   * 这条是被真失败逼出来的：Windows 上 `Set-Content -Encoding UTF8` 写 BOM，
   * 而 `JSON.parse` 见到 U+FEFF 直接抛。快照由 **agent** 生成，
   * 读它的那一侧必须比写它的那一侧宽容 —— 否则这个工具在 Windows 上永远起不来。
   */
  it("快照带 BOM 也能读（Windows PowerShell 写文件的默认形态）", () => {
    const p = join(dir, "bom.json");
    writeFileSync(p, `\uFEFF${JSON.stringify(board({ "MATT-1": "Todo" }))}`, "utf8");
    const c = commitsFile({ "MATT-1": { lastCommitAt: ago(1), count: 1 } });
    const r = spawnSync(process.execPath, [TOOL, "--board", p, "--commits", c], {
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
  });

  it("**快照文件缺失 ⇒ 非零退出**并说清是哪个文件", () => {
    const r = spawnSync(process.execPath, [TOOL, "--board", join(dir, "nope.json")], {
      encoding: "utf8",
    });
    expect(r.status).not.toBe(0);
    expect(`${r.stderr}`).toContain("nope.json");
  });

  it("**空快照 ⇒ 非零退出**（canary：否则「全绿」会被读成「没有漂移」）", () => {
    const p = snap({ capturedAt: "x", tickets: {} });
    const c = commitsFile({ "MATT-9": { lastCommitAt: ago(1), count: 1 } });
    const r = spawnSync(process.execPath, [TOOL, "--board", p, "--commits", c], {
      encoding: "utf8",
    });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain("快照");
  });

  it("**快照里出现 git 没有的票 ⇒ 非零退出**（快照与仓库对不上，此刻任何结论都不可信）", () => {
    const p = snap(board({ "MATT-99999": "Todo" }));
    const c = commitsFile({ "MATT-1": { lastCommitAt: ago(1), count: 1 } });
    const r = spawnSync(process.execPath, [TOOL, "--board", p, "--commits", c], {
      encoding: "utf8",
    });
    expect(r.status).not.toBe(0);
    // 而「快照少一张票」必须**指名道姓**地说，否则读者不知道该重取哪一张
    expect(`${r.stdout}${r.stderr}`).toContain("MATT-1");
  });
});
