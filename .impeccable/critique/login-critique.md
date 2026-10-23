⚠️ DEGRADED: single-context (评估 B 的独立子代理在 rate-limit 处中断；CLI 检测器与浏览器实测由主上下文补跑完成，但 A/B 未做到完全隔离)

## Report header provenance
Method: design review only (detector not fully available, native platform restrictions)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of system status | **3/4** | busy state exists but renders as white-fill/blue-border/gray-text; no spinner |
| 2 | Match system / real world | **3/4** | Chinese UI, but English zod strings leak into the only surface a legal reporter sees |
| 3 | User control and freedom | **3/4** | real `<form>`, Enter submits, autofocus; but no password reveal and field errors can't be cleared except by resubmitting |
| 4 | Consistency and standards | **3/4** | canon classes used consistently; product says **密码** here but **口令** everywhere else (`profile-view.tsx:81`, `users-view.tsx:276`) |
| 5 | Error prevention | **2/4** | no `maxLength` (measured `-1`), no rate limiting on `/api/auth/login`, no caps-lock hint |
| 6 | Recognition rather than recall | **4/4** | persistent labels, correct `autocomplete`, no placeholder-only fields |
| 7 | Flexibility and efficiency | **3/4** | autofocus + autocomplete + Enter is the whole story; adequate, no accelerator beyond it |
| 8 | Aesthetic and minimalist design | **4/4** | genuinely excellent restraint: one focus, one accent use, no decoration |
| 9 | Recognize/diagnose/recover from errors | **2/4** | anti-enumeration copy is right, but errors have no `aria-*` wiring, don't clear on edit, and the server error is a bare red line |
| 10 | Help and documentation | **2/4** | `仅限内网访问` is a fact, not help; no recovery path for locked-out/not-yet-activated users |

**Total: 29/40** (rating band: Good — 72.5%)

## Design Specificity Verdict

The composition — 400px card dead-centered on an empty canvas, brand word + muted subline + two stacked fields + one full-width primary + a footer fact — is world-correct but product-anonymous. It faithfully executes 「标准写法」, and since that world was deliberately committed as category-default, this is not a world failure. But apply the brief's test literally — *could an unrelated B2B product use it unchanged?* — and the answer is yes, entirely. Strip three Chinese strings and it is Grafana's or Jira's login. Nothing signals litigation, legal department, or docket data. The one degree of freedom the world leaves open — the words, and the craft of focus/error states — is exactly where the page is weakest. Composition passes; specificity sits at zero.

## Cognitive load

- Single focus — Pass (one card, one task)
- Chunking ≤4/group — Pass (2 fields + 1 button)
- Grouping — Pass (one stacked field group)
- Visual hierarchy — Pass (brand 17px/600 > sub 13px muted > label 12px)
- One thing at a time — Pass at rest
- Minimal choices ≤4 — Pass (3 visible controls)
- Working memory — Pass (labels persist; nothing to recall)
- Progressive disclosure — Pass (nothing needed is hidden)

**Failures: 0 — Low band.** Baseline load is exemplary; the strain is the error moment, where two field errors plus a server error can stack at once.

## Emotional journey

Peak is correct: `autoFocus` on `#login-username` means the caret is already blinking when the card paints — "start here" without a word. The valley is mishandled for the stakes. On bad credentials, `账号或密码不正确` (12px, `#DC2626`, 4.83:1 on the white card) appears as a small red line *above* the 账号 label, unattached to either field, no icon, no weight change, no recovery hint — and nothing distinguishes "I typo'd" from "my account isn't activated" or names who to contact. The anti-enumeration rule (route.ts:35) is correct security, but collapses three real situations into one dead end. First impression is also emotionally thin: "MatterNest / 内网办公系统" asserts almost nothing, giving a legal reporter no institutional signal this is *the company's case ledger* rather than a generic portal. Reassurance is absent exactly where the North Star ("期限不会漏") should be felt.

## 2–3 strengths

1. **Anti-enumeration enforced end-to-end, not just at the API.** `route.ts:35` returns the same message for nonexistent/wrong/not-activated, *and* `login-form.tsx:17-18` explicitly forbids the client from "improving" it into "口令不正确". Most codebases lose this contract the first time someone edits the form; this one is structurally defended.
2. **The form scaffolding is semantically real.** Genuine `<form onSubmit>`, `label htmlFor` ↔ `id` pairs, `type="password"`, correct `autocomplete` on both fields, `autoFocus`, `noValidate`, `type="submit"`. Password managers and keyboard users work with zero custom machinery.
3. **The 记住我 omission is a reasoned decision, not a copy.** `login-form.tsx:20-22` refuses to draw the prototype's checkbox because sessions have no client-side persistence (`auth.ts:24`, `SESSION_TTL_SECONDS = 60*60*8`, server-issued cookie). Drawing a non-functional control would violate the project's own 「不留点了没反应的控件」 discipline. Design courage over prototype fidelity.

## 3–5 priority issues

- **[P0] 主按钮在键盘焦点下根本没有焦点环（比输框更严重）。** 实测按钮键盘焦点：`outline: rgb(11,18,32) none 3px` —— `none` 即无环；`borderColor` 只是常态强调色。输入框退回浏览器默认白环（`rgb(238,238,238) auto 1px`，深色页面上是一圈刺眼白边，见截图），按钮则是零指示。`globals.css` 只为四个选择器写了 `:focus-visible`（225、289、335、566 行），`.inp` / `.btn` 都不在其中。**Why:** 违规 DESIGN.md:167（焦点环 + 当前输入框描边），键盘用户无法确认按钮是否已聚焦，直接卡在提交前一步。**Fix:** `.btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}` 与 `.inp:focus-visible{border-color:var(--accent);outline:2px solid var(--accent);outline-offset:-1px}`。

- **[P0] English zod messages leak into an all-Chinese UI.** Reproduced live: 70 chars in 账号 → `"Too big: expected string to have ≤64 characters"`; 210 chars in 密码 → `"Too big: expected string to have ≤200 characters"`. **Why:** `src/shared/schema/hosts.ts:308-309` gives Chinese messages only to `.min()`, leaving `.max()` at zod defaults — and both inputs lack `maxLength` (measured `-1`), so users can reach them. The system's front door shows raw developer text. **Fix:** add `账号最多 64 个字符` / `密码最多 200 个字符` in the schema, plus `maxLength={64}` / `maxLength={200}` on the inputs as first line of defense.

- **[P1] Errors are visually announced but not programmatically wired, never clear on edit, and there is no hover state anywhere.** Measured: `#login-username` has `aria-describedby: null`, `aria-invalid: null`; the two `.hint.err` field messages (login-form.tsx:86, :103) have no `role`/`aria-live` (only the server error has `role="alert"`, line 68). After both field errors show, typing `admin` left both hints on screen. Grepping every rule containing `hover` found **no `.btn:hover` and no `.inp:hover`**. **Why:** a screen-reader user gets zero announcement of "请输入账号"/"请输入密码"; sighted users get no feedback that their correction registered; the primary button has no hover affordance at all. **Fix:** give each hint an `id`, set `aria-invalid={!!fieldError.x}` + `aria-describedby="login-username-err"` on the input and `role="alert"` on the hint; clear `fieldError.x` in each `onChange`; add `.btn:hover{background:var(--hover)}` (darkened accent for `.pri`) and `.inp:hover{border-color:var(--control-line)}`.

- **[P2] No heading, no landmark, and the card lurches 44px when an error appears.** Measured: `querySelectorAll('h1..h6')` returns **[]**; no `<main>`/`<nav>`/`role=main`. Brand is a `<div className="brand">` (page.tsx:25). Separately, on validation errors the card grows 43.69px and re-centers, top moving `286.67 → 264.83` (−21.84px). **Why:** for a screen reader the system's front door is structureless; for a sighted user the whole card jumps under the cursor at the exact moment of failure. **Fix:** make the brand an `<h1>`, wrap the form region in `<main>`, and stabilize vertical position (reserve the error band, or anchor `.login` with `align-items:flex-start` at a fixed top offset).

- **[P3] The busy state drops the primary affordance at the worst moment; no password reveal.** Measured disabled button: `color rgb(106,113,125)`, `background rgb(250,251,252)`, `border-color rgb(37,99,235)` — near-white with a blue outline, easily read as a disabled outline button. **Why:** the moment the user needs confidence the click registered (`SESSION_TTL_SECONDS = 60*60*8`, so re-auth daily), the solid blue anchor vanishes; and a typo in the password cannot be verified without retyping blind. **Fix:** keep the accent fill during `busy`, append a small inline spinner, keep the `登录中…` label; add a reveal toggle to the password field.

## Persona red flags

**Alex (Power User):** No keyboard focus styling on `.inp`/`.btn`; form requires 3 clicks to first interaction (focus, tab, submit); no password reveal; 记住我 omitted means every session resets. Red flags: focus falls to browser default ring, not authored; no bulk/automation path for a daily-reauth task.

**Jordan (First-Timer):** Technical jargon "Too big: expected string to have ≤64 characters" (English) in a Chinese UI; no visible help at any step; no hover states anywhere; card jumps when errors appear. Red flags: English error messages, no hover affordance, card lurch on error.

**Sam (Accessibility-Dependent):** Missing `aria-invalid`/`aria-describedby` on inputs; field `.hint.err` has no `role="alert"` or live region; no keyboard focus indicator authored; `color-scheme` not declared so native autofill/password-manager surfaces light-on-dark. Red flags: zero screen-reader announcement for field labels; native focus ring only; `color-scheme` leak.

## Minor observations

- `#login-username` is `type="text"` with no `inputMode`/`autoCapitalize="off"`/`autoCorrect="off"` and `spellcheck` defaults to `true` — red squiggles will underline a username on some browsers.
- Neither input has a `name` attribute (measured `null`), which is fine for fetch-based submit but blocks any future native/progressive-enhancement fallback.
- The `.inp` rule's font shorthand `font: 13px/1 inherit` is **not in the CSSOM** — probing it directly returns the inherited 16px, i.e. the browser drops it as invalid. Inputs therefore render at **14px** (inherited from antd's `.ant-app` wrapper), not the 13px body baseline DESIGN.md:216 calls the sitewide standard. This is a silent ~7% size drift on the system's two most-used controls, inherited from the same declaration in `canon.css:147`.
- The card's shadow is `0 8px 24px rgba(16,24,40,.08)` (globals.css:1123) — the only place in the system with a shadow that heavy; DESIGN.md:268 says the light-mode shadow exists only to lift cards "一丝", at `0 1px 2px rgba(16,24,40,.06)` (`ELEVATION.light`). The login card overrides `--shadow` with a ~3× stronger blur.
- Container contrast numbers are all sound: `#6A717D` on white = 4.92, on paper = 4.55; `#2563EB` on white = 5.17; error red on white = 4.83, on paper = 4.47. The one that fails the AA text floor is `#DC2626` on `paper #F5F6F8` = **4.47** — though on this page the error sits on the white card (4.83), so it passes as rendered.
- Mobile: at 375px viewport the card measured 400px wide, `left: 50, right: 450` against `scrollWidth 500` — it does not horizontally overflow because the 500px reading came from a 500px-wide emulated window, but at a true 375px width a fixed 400px card plus the `.login` flex centering has no side padding (`padding: 0px`) and will clip. PRODUCT.md:23 marks mobile "只需可看、可查", so this is out-of-scope rather than broken, but a single `max-width: calc(100vw - 32px)` would close it.
- `autoFocus` on mount is correct here, but combined with card re-centering on error, focus stays pinned while the card moves.
- ~~No `color-scheme` is declared on `:root` or the inputs~~ — **已证伪**（浏览器实测 `documentElement.colorScheme = "dark"`，输入框同样为 `dark`）。此项撤回。

## Run Notes

- Target slug: `src-app-auth-login-page-tsx`（解析自 `src/app/(auth)/login/page.tsx`）
- Ignore list: `.impeccable/critique/ignore.md` 不存在，无剔除项
- Assessment independence: **降级**。A 完整跑完；B 首次子代理因 rate limit 中途失败，改为在同一上下文内实测（CLI 检测器始终未跑通）
- CLI detector: **已执行，两份文件均 0 findings（exit 0）** —— `page.tsx` 与 `login-form.tsx`。静态规则全部通过，说明下列 P0/P1 属于「规则库不覆盖的工程质量」，不是反模式违规
- Browser visibility: 已打开新标签页 http://localhost:3777/login，页面可见
- Overlay injection: **成功**。注入 `http://localhost:8400/detect.js` 后页面顶部出现 `impeccable-banner`，控制台输出 `[impeccable] 1 anti-pattern found`
- Live server cleanup: 8400 helper 仍在运行（pid 22948），未停止；如不再需要可 `impeccable live-server stop`
- Temp-file cleanup: 无临时文件残留
- 检测器唯一报告项 `bounce-easing`（`cubic-bezier(0.12,0.4,0.29,1.46)`）经定位是 antd 主题变量 `--ant-motion-ease-out-back`，全站无引用 —— **误报**

## Provocative questions

1. The world is committed as "category-default done impeccably" — but if the only surface where a legal user ever *feels* the institution is this login gate, and the gate currently asserts nothing beyond "MatterNest / 内网办公系统", **what exactly is the product buying by spending its one degree of freedom on `仅限内网访问` instead of a sentence that makes a litigation reporter feel they've reached the right place?** Is "内网办公系统" a fact about this product, or a placeholder that survived because nobody asked whether it could be deleted?

2. The anti-enumeration rule collapses three states into `账号或密码不正确`. The security reasoning is unimpeachable. But the not-yet-activated user is a *known, first-party* case — the system literally models `activationStatus` (route.ts:44) and has an approval flow. **Is rendering that user indistinguishable from an attacker actually the right trade, or is the real fix an out-of-band path (the 内网 phone/contact fact that belongs in the card footer) rather than more copy in the error line?**

3. Focus is listed as one of the three permitted uses of `#2563EB` (DESIGN.md:167), and the login page uses the accent for the button but **not** for focus. Given that `.inp`/`.btn` focus was simply never authored, **how many other pages in the batch-two migration inherited the same gap** — is this one page's omission or a systematic hole in the canon→`globals.css` transcription?

4. The prototype (`login.html:22-25`) draws 记住我, and the team deliberately removed it as an honest omission. The right call. But the prototype also shows filled values (`value="zhangwei"`, `value="············"`) — a signal the designer wanted the page to feel *already warm*. **Was removing the checkbox the only prototype element that should not have shipped, or was the intent to show a warmer, more institutional first frame lost along with it?**

5. `SESSION_TTL_SECONDS = 60*60*8` means every user re-authenticates roughly once per workday. For a page seen that often, **is "one card, dead center, 400px" the right composition, or is this a surface that should optimize for the 200th visit (muscle memory, zero friction) rather than the 1st (ceremony, trust)?** The page currently optimizes for neither decisively.