# Design — P5-D2 一

## 边界

只动两处：
- `src/app/(desk)/risk-matters/[id]/risk-detail.tsx`（页面本体）
- 文案所在文件（菜单、metadata、列表/工作台/归档、创建弹窗、状态弹窗、登录页以外的位置）

不动：API 与服务层、schema、`PageHeader` 签名、案件侧布局。

## 结构（原型 D2 的 React 版）

```
<div maxWidth 1180>
  <Row gutter={16} align="stretch">
    <Col flex="auto">                      ← 左列
      <Card> 页头                                  ← 原 PageHeader 的内容落到卡内
        Row: [meta 行(编号·状态·未指派·等级)] ... [动作区]
        h2 标题 / 描述 / 处置措施 / 字段行 / <details> 参考材料
      </Card>
      <Card> 页签（事项节点 / 活动日志）+ 面板（flex:1） </Card>
    </Col>
    <Col flex="340px">                     ← 右栏
      <div sticky> 评论（列表滚动 + 输入框钉底） </div>
    </Col>
  </Row>
</div>
```

## 关键决定

**右栏高度用纯 CSS，不学原型的 JS 量法。** 原型里 `--rail-h` 是为了补"整幅页头把评论栏推下去"这个偏移；D2 里右栏与左列**同顶边**（都在内容区顶端），所以 `position: sticky; top: 76px; max-height: calc(100vh - 92px)` 直接成立（76 = 顶栏 60 + 内容内边距 16；-92 再留 16px 下边距）。这条简化要写进代码注释，否则下一个人会照原型抄一份 JS 量法回来。

**两列等高的做法**：`Row align="stretch"` + 左列 `min-height` 与右栏同源（都用同一个 `calc(100vh - 92px)` 作 min-height 的基准），左列内部 `display:flex; flex-direction:column`，内容卡 `flex:1`。

**已转案件的 hover 详情**：用 antd `Popover`（`trigger="hover"`），不用自绘 `.d-pop`——原型里那段是 CSS `:hover`，这里换成组件以便键盘可达（`Popover` 支持 focus 触发）。

**折叠区**：用 antd `Collapse`（`ghost`）或原生 `<details>`；选 `Collapse` 以与全站一致，默认 `activeKey=[]`（收起）。

## 兼容与回滚

- 纯前端改动，回滚 = revert 这一个提交；无迁移、无数据影响。
- 既有路由与 DTO 不变；冒烟脚本的断言不依赖页面结构（依赖 API），预期不受影响——但要跑一遍确认。
