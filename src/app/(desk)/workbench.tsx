"use client";

import { BRAND, INK } from "@/app/theme/brand";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Card,
  Col,
  Divider,
  Flex,
  List,
  Progress,
  Row,
  Space,
  Statistic,
  Tag,
  Typography,
} from "antd";
import { ReloadOutlined } from "@ant-design/icons";

import { useMeta, useOverview } from "@/app/lib/client/api";
import { PageHeader } from "@/app/components/page-header";
import { StateBlock } from "@/app/components/ui/state-block";
import { fromNow, dateTime } from "@/app/lib/client/format";
import { DEADLINE_TONE } from "@/app/theme/antd";

/**
 * 工作台。开场放的是**到期压力**，不是四个大数字方块：
 * 这张页要回答的第一问是"今天有什么会过期"，所以临期清单排第一，案件总数只是背景信息。
 *
 * 与列表页共用同一套后端口径：所有数字都来自 `/api/overview`，
 * 那里每个读数都过 `scopedWhere`，且**归档不计入**（归档是终态且列表默认隐藏）。
 */
function daysLeft(iso: string | null): number | null {
  if (!iso) return null;
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

export function Workbench() {
  const { data, isPending, isError, error } = useOverview();
  const { data: meta } = useMeta("matter");
  const qc = useQueryClient();

  const day = new Date().toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  });

  if (isError) {
    return (
      <StateBlock
        tone="error"
        title="工作台读数没拿到"
        hint={error instanceof Error ? error.message : "未知错误"}
        action={
          <Button
            size="small"
            onClick={() => void qc.invalidateQueries({ queryKey: ["overview"] })}
          >
            重试
          </Button>
        }
      />
    );
  }

  const upcoming = data?.upcoming ?? [];
  const statusColor = (semantics: string) =>
    semantics === "closed"
      ? BRAND.success
      : semantics === "in_progress"
        ? BRAND.primary
        : semantics === "archived"
          ? INK.faint
          : INK.rail;

  return (
    <div style={{ maxWidth: 1180, margin: "0 auto" }}>
      <PageHeader
        eyebrow={
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {day}
          </Typography.Text>
        }
        title="今天该动手的"
        actions={
          <Button
            icon={<ReloadOutlined />}
            onClick={() => {
              // 两个查询一起失效：只刷 overview 会留着上一个账号缓存的字典
              void qc.invalidateQueries({ queryKey: ["overview"] });
              void qc.invalidateQueries({ queryKey: ["meta"] });
            }}
          >
            刷新
          </Button>
        }
      />

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={15}>
          <Card
            size="small"
            title="节点到期"
            extra={
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                含已逾期，按期限升序
              </Typography.Text>
            }
            styles={{ body: { padding: upcoming.length ? 0 : 24 } }}
          >
            {isPending ? (
              <Card.Grid style={{ width: "100%", padding: 24 }}>加载中…</Card.Grid>
            ) : !upcoming.length ? (
              <StateBlock
                title="没有待办节点"
                hint="所有已确认时间的节点都完成了。新建节点在案件详情页的「工作节点」里。"
                action={
                  <Link href="/matters">
                    <Button size="small" type="primary">
                      去案件列表
                    </Button>
                  </Link>
                }
              />
            ) : (
              <List
                dataSource={upcoming}
                renderItem={(n) => {
                  const d = daysLeft(n.deadlineTime);
                  const overdue = d !== null && d < 0;
                  const soon = d !== null && d >= 0 && d <= 3;
                  const color = overdue
                    ? DEADLINE_TONE.overdue.color
                    : soon
                      ? DEADLINE_TONE.soon.color
                      : "transparent";
                  return (
                    <List.Item
                      key={n.id}
                      style={{ padding: "8px 12px" }}
                      actions={[
                        <span
                          key="d"
                          style={{
                            color: color === "transparent" ? undefined : color,
                            fontVariantNumeric: "tabular-nums",
                            fontSize: 13,
                            minWidth: 92,
                            textAlign: "right",
                          }}
                        >
                          {d === null
                            ? "未定"
                            : d < 0
                              ? `逾期 ${-d} 天`
                              : d === 0
                                ? "今天"
                                : `剩 ${d} 天`}
                        </span>,
                      ]}
                    >
                      {/* 左侧一条 3px 色带承担"危险程度"，文字仍写完整日期：色带只让扫读更快，不是唯一通道 */}
                      <div style={{ display: "flex", gap: 10, minWidth: 0 }}>
                        <span
                          style={{
                            width: 3,
                            borderRadius: 2,
                            background: color,
                            alignSelf: "stretch",
                            flex: "0 0 auto",
                          }}
                        />
                        <div style={{ minWidth: 0 }}>
                          <Link href={`/matters/${n.hostId}`} style={{ color: "inherit" }}>
                            <Typography.Text style={{ fontSize: 13 }} strong>
                              {n.name}
                            </Typography.Text>
                          </Link>
                          <div style={{ fontSize: 12, color: INK.muted }}>
                            <span className="num">{n.hostCode}</span> · {n.hostName}
                            {n.owner ? ` · ${n.owner}` : ""} · {dateTime(n.deadlineTime)}
                          </div>
                        </div>
                      </div>
                    </List.Item>
                  );
                }}
              />
            )}
          </Card>
        </Col>

        <Col xs={24} lg={9}>
          <Space orientation="vertical" size={16} style={{ display: "flex" }}>
            <Card size="small" title="范围读数">
              <Row gutter={[0, 4]}>
                <Col span={12}>
                  <Statistic
                    title={
                      <Link href="/matters" style={{ color: "inherit" }}>
                        在办案件
                      </Link>
                    }
                    value={data?.matters.total ?? 0}
                    styles={{ content: { fontSize: 20 } }}
                  />
                </Col>
                <Col span={12}>
                  <Statistic
                    title="逾期节点"
                    value={data?.nodes.overdue ?? 0}
                    styles={{
                      content: {
                        fontSize: 20,
                        color: data?.nodes.overdue ? DEADLINE_TONE.overdue.color : undefined,
                      },
                    }}
                  />
                </Col>
                <Col span={12}>
                  <Statistic
                    title="7 日内到期"
                    value={data?.nodes.within7 ?? 0}
                    styles={{
                      content: {
                        fontSize: 20,
                        color: data?.nodes.within7 ? DEADLINE_TONE.soon.color : undefined,
                      },
                    }}
                  />
                </Col>
                <Col span={12}>
                  <Statistic
                    title={
                      <Link href="/risk-matters" style={{ color: "inherit" }}>
                        风险事项
                      </Link>
                    }
                    value={data?.risks.total ?? 0}
                    suffix={
                      data ? (
                        <span style={{ fontSize: 11, color: INK.muted }}>
                          已转 {data.risks.converted}
                        </span>
                      ) : null
                    }
                    styles={{ content: { fontSize: 20 } }}
                  />
                </Col>
              </Row>

              {meta && data?.matters.total ? (
                <>
                  <Divider style={{ margin: "12px 0" }} />
                  <Flex vertical gap={4}>
                    {meta.statuses.map((s) => {
                      const n = data.matters.byStatus[s.code] ?? 0;
                      return (
                        <Flex key={s.code} align="center" gap={8}>
                          <span style={{ width: 56, fontSize: 12, color: INK.secondary }}>
                            {s.name}
                          </span>
                          <Progress
                            percent={Math.round((n / data.matters.total) * 100)}
                            size="small"
                            showInfo={false}
                            strokeColor={statusColor(s.semantics)}
                            style={{ flex: 1, margin: 0 }}
                          />
                          <span
                            className="num"
                            style={{ width: 24, textAlign: "right", fontSize: 12 }}
                          >
                            {n}
                          </span>
                        </Flex>
                      );
                    })}
                  </Flex>
                </>
              ) : null}
            </Card>

            <Card
              size="small"
              title="最近动作"
              extra={
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {data?.recent.length ?? 0}
                </Typography.Text>
              }
              styles={{ body: { padding: data?.recent.length ? 0 : 24 } }}
            >
              {!data?.recent.length ? (
                <StateBlock title="还没有活动记录" hint="建案、改状态、加评论都会记在这里。" />
              ) : (
                <List
                  dataSource={data.recent}
                  renderItem={(r) => (
                    <List.Item style={{ padding: "6px 12px" }}>
                      <div style={{ minWidth: 0 }}>
                        <Space size={6} wrap>
                          <Tag variant="filled" style={{ fontSize: 11, marginInlineEnd: 0 }}>
                            {r.actionLabel}
                          </Tag>
                          <Link
                            href={`/${r.kind === "matter" ? "matters" : "risk-matters"}/${r.hostId}`}
                          >
                            <span className="num" style={{ fontSize: 12 }}>
                              {r.hostCode ?? "—"}
                            </span>
                          </Link>
                        </Space>
                        <div style={{ fontSize: 11, color: INK.muted }}>
                          {r.operator} · {fromNow(r.createdAt)}
                          {r.reason ? ` · ${r.reason}` : ""}
                        </div>
                      </div>
                    </List.Item>
                  )}
                />
              )}
            </Card>
          </Space>
        </Col>
      </Row>
    </div>
  );
}
