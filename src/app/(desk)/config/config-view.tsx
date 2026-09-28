"use client";

import { Card, Col, Flex, Row, Space, Table, Tag, Typography } from "antd";

import { useMeta } from "@/app/lib/client/api";
import { PageHeader } from "@/app/components/page-header";
import { StateBlock } from "@/app/components/ui/state-block";

/**
 * 配置字典（**只读**）。
 *
 * 这张页存在的理由是 W0-3 那条裁定要能被看见：值域分两类——
 *   · 配置驱动（状态、风险等级、标签）→ 存在库里，运营可改，所以两张宿主各一份；
 *   · 闭集枚举（案件类型、审级、诉讼地位、节点状态…）→ 写在 `@/shared/enums`，
 *     与迁移里的 `CHECK` 由 `enum-check.spec.ts` 双向核对。
 * 并排列出来，"为什么这个能改那个不能改"就不用口头解释。
 *
 * 一期不做配置编辑（`can_manage_config` 目前只用于读），所以这里明写"只读"，
 * 而不是摆一排禁用按钮。
 */
export function ConfigView() {
  const matter = useMeta("matter");
  const risk = useMeta("risk_matter");

  if (matter.isPending || risk.isPending) {
    return <Card size="small" loading style={{ maxWidth: 1180, margin: "0 auto" }} />;
  }
  if (matter.isError || risk.isError) {
    return <StateBlock tone="error" title="配置读不到" hint="会话可能已过期，重新登录后再看。" />;
  }

  const m = matter.data!;
  const r = risk.data!;

  const statusColumns = [
    {
      title: "code",
      dataIndex: "code",
      width: 120,
      render: (v: string) => <span className="num">{v}</span>,
    },
    { title: "名称", dataIndex: "name", width: 120 },
    {
      title: "语义（决定系统行为）",
      dataIndex: "semantics",
      render: (v: string) => (
        <Space size={6}>
          <Tag bordered={false}>{m.enums.semantics?.[v] ?? v}</Tag>
          <Typography.Text type="secondary" className="num" style={{ fontSize: 11 }}>
            {v}
          </Typography.Text>
        </Space>
      ),
    },
  ];

  return (
    <div style={{ maxWidth: 1180, margin: "0 auto" }}>
      <PageHeader
        title="配置字典"
        meta={<span>只读。左侧菜单里没有编辑入口是因为一期没做写接口，不是权限问题。</span>}
      />

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card size="small" title={`案件状态 (${m.statuses.length})`}>
            <Table
              size="small"
              rowKey="code"
              pagination={false}
              dataSource={m.statuses}
              columns={statusColumns}
            />
            {m.tags.length ? (
              <div style={{ marginTop: 12 }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  标签
                </Typography.Text>
                <div>
                  {m.tags.map((t) => (
                    <Tag key={t.id}>{t.name}</Tag>
                  ))}
                </div>
              </div>
            ) : null}
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small" title={`事项状态 (${r.statuses.length})`}>
            <Table
              size="small"
              rowKey="code"
              pagination={false}
              dataSource={r.statuses}
              columns={statusColumns}
            />
          </Card>
        </Col>

        <Col xs={24} lg={12}>
          <Card size="small" title="风险等级（两宿主共用一张表）">
            <Table
              size="small"
              rowKey="code"
              pagination={false}
              dataSource={m.levels}
              columns={[
                {
                  title: "code",
                  dataIndex: "code",
                  width: 120,
                  render: (v: string) => <span className="num">{v}</span>,
                },
                { title: "名称", dataIndex: "name" },
              ]}
            />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small" title="闭集枚举（改动要走迁移，不在这里改）">
            <Flex vertical gap={10}>
              <EnumBlock title="案件类型" map={m.enums.caseTypes} />
              <EnumBlock title="审级 / 程序" map={m.enums.procedures} />
              <EnumBlock title="诉讼地位" map={m.enums.litigationRoles} />
              <EnumBlock title="当事人类型" map={m.enums.partyTypes} />
              <EnumBlock title="节点状态" map={m.enums.nodeStatuses} />
              <EnumBlock title="事项类型" map={r.enums.riskTypes} />
            </Flex>
          </Card>
        </Col>
      </Row>
    </div>
  );
}

function EnumBlock({ title, map }: { title: string; map?: Record<string, string> }) {
  const entries = Object.entries(map ?? {});
  return (
    <div>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {title} · {entries.length}
      </Typography.Text>
      <div style={{ marginTop: 4 }}>
        {entries.map(([code, label]) => (
          <Tag key={code} title={code} style={{ marginBottom: 4 }}>
            {label}
          </Tag>
        ))}
      </div>
    </div>
  );
}
