# Implement — P5-D2 一

按顺序做；每步都能单独验，别攒到最后。

## 1. 先读原型（10 分钟，别跳）

`git show prototype/p5-p6-2026-10-11:src/app/(desk)/risk-matters/prototype-p5-detail.html`，看 `function VariantD(archived)` 与它上面那段 D2 注释。React 版是它的**结构翻译**，不是重画。

## 2. 页面骨架（`risk-detail.tsx`）

- [ ] `Row align="stretch"` + 左 `Col flex="auto"` + 右 `Col flex="340px"`；右栏 `position: sticky; top: 76`、`maxHeight: calc(100vh - 92px)`。
- [ ] 页头卡：meta 行 + 标题 + 描述字段块 + 处置措施字段块 + `d-facts-row`（一行 `dt/dd`，含 `已转案件 N 件` 的 `Popover`）。
- [ ] 折叠区（`Collapse`，默认收起）：当事人 / 参与人 / 附件 / 登记信息。
- [ ] 页签两枚 + 面板；`手动添加节点` 移进节点面板右上。
- [ ] 评论卡：`flex` 列 + 列表 `overflow:auto` + 输入框贴底；归档态整块换成只读说明。
- [ ] 左列 `minHeight` 与右栏同基准、内容卡 `flex:1`。

## 3. 文案（可 grep 验收）

- [ ] `风险事项`→`事项`（**保留** `(auth)/login/page.tsx` 与 `layout.tsx` 两处）；`变更处理人`→`变更经办人`；`活动流`→`活动日志`（案件侧页签「活动」→「活动日志」）；`风险描述`→`描述`；`软删`→`删除`（Popover 文案保留"库里仍保留、没有回收站"）。
- [ ] 反向核：`git grep -n "风险事项\|变更处理人\|活动流\|软删" src` 只应剩登录页与站点描述两处。

## 4. 验证

```bash
pnpm verify          # format/lint/typecheck/vitest/lint-guard 五道
pnpm build
node agent-work/smoke-demo.mjs   # 真 HTTP，需 dev/start 在 3777
```

浏览器实测（**截图不可用时用数值**）：1366 与 1920 两档量左列/右栏宽、两列顶边 y、左列高 = 右栏高、右栏底距折线、元素级横向溢出、页签数、加节点按钮所在面板；再切归档态与 `demo=empty` 各看一遍。

## 5. 收口

- [ ] `trellis-update-spec` 走一遍：本轮若发现新坑（例如 sticky 高度、antd Popover 的键盘可达）写回前端 spec。
- [ ] 提交前把 `task.json.notes` 与 Paca #55 的评论补上实测数字。

## 回滚点

每个提交点都可回滚：骨架（2）一个提交、文案（3）一个提交——文案独立成提交是为了**改名可单独 revert**（它跨多个文件，与骨架混在一起会让"只回退改名"变得不可能）。
