"use client";

import { INK } from "@/app/theme/brand";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Form, Input, List, Space, Tag, Typography } from "antd";

import { api, ApiFailure } from "@/app/lib/client/api";
import { loginSchema } from "@/shared/schema/hosts";
import { rulesFor } from "@/app/components/form/zod-rules";

/**
 * 登录表单。
 *
 * 校验规则从 `loginSchema` 里读（`rulesFor`），提交时仍由同一条 schema 兜底——
 * antd 的 rules 只负责即时提示，规则的定义源还是 shared 那一份（禁令⑧）。
 *
 * 服务端对"账号不存在 / 口令错 / 未开通"给同一个 401 文案（防枚举），
 * 所以这里也只显示那一句，不改写成"口令不正确"——客户端文案不能把服务端的防泄露口径打回原形。
 * 演示账号提示块只在非生产渲染：这套 seed 的口令等于用户名，生产绝不能带这段文案。
 */
const DEMO = [
  { username: "wangkf", who: "主任", scope: "全所 L1" },
  { username: "lichen", who: "风控合伙人", scope: "全所 L1" },
  { username: "zhaolj", who: "承办律师（兼两角色）", scope: "L1 + 撤归档" },
  { username: "suny", who: "助理", scope: "我参与 L2" },
  { username: "hezp", who: "IT", scope: "我承办 L3 + 管配置" },
];

type FormValues = { username: string; password: string };

export function LoginForm() {
  const router = useRouter();
  const qc = useQueryClient();
  const [form] = Form.useForm<FormValues>();
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(values: FormValues) {
    setServerError(null);
    setBusy(true);
    try {
      // 先过 schema（长度/去空白），再发请求：与后端用的是同一份定义
      const parsed = loginSchema.safeParse(values);
      if (!parsed.success) {
        setBusy(false);
        return;
      }
      // 登录失败与"会话过期"共用一个状态码，所以关掉 api 层的自动跳转（否则整页重载、错误提示被冲掉）
      await api.post("/api/auth/login", parsed.data, { redirectOn401: false });
      // 换人必须清缓存：上一个账号的范围谓词不一样，缓存着的列表会让新用户看见别人的行
      qc.clear();
      router.replace("/");
    } catch (e) {
      setServerError(e instanceof ApiFailure ? e.message : "登录失败，请稍后再试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ width: 320 }}>
      <Typography.Title level={4} style={{ marginBottom: 4 }}>
        登录
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 20 }}>
        用本所账号。连续失败不会锁定，但每次都会记进审计。
      </Typography.Paragraph>

      <Form<FormValues>
        form={form}
        layout="vertical"
        requiredMark={false}
        onFinish={submit}
        initialValues={{ username: "", password: "" }}
      >
        <Form.Item label="账号" name="username" rules={rulesFor(loginSchema, ["username"])}>
          <Input autoFocus autoComplete="username" allowClear />
        </Form.Item>
        <Form.Item label="口令" name="password" rules={rulesFor(loginSchema, ["password"])}>
          <Input.Password autoComplete="current-password" />
        </Form.Item>
        {serverError ? (
          <Alert type="error" showIcon message={serverError} style={{ marginBottom: 12 }} />
        ) : null}
        <Button type="primary" htmlType="submit" block loading={busy}>
          登录
        </Button>
      </Form>

      {process.env.NODE_ENV !== "production" ? (
        <div style={{ marginTop: 28, borderTop: `1px solid ${INK.line}`, paddingTop: 12 }}>
          <Typography.Paragraph type="secondary" style={{ fontSize: 11, marginBottom: 6 }}>
            演示账号（口令 = 账号，点一下填入）。换一个账号登就能看到同一张表行数不同——
            那是服务端范围谓词在起作用，不是前端筛的。
          </Typography.Paragraph>
          <List
            size="small"
            dataSource={DEMO}
            renderItem={(d) => (
              <List.Item
                style={{ padding: "4px 0", cursor: "pointer" }}
                onClick={() => {
                  form.setFieldsValue({ username: d.username, password: d.username });
                }}
              >
                <Space size={6} wrap>
                  <span className="num" style={{ fontSize: 12 }}>
                    {d.username}
                  </span>
                  <span style={{ fontSize: 11, color: INK.muted }}>{d.who}</span>
                  <Tag
                    bordered={false}
                    style={{ fontSize: 10, lineHeight: "16px", marginInlineEnd: 0 }}
                  >
                    {d.scope}
                  </Tag>
                </Space>
              </List.Item>
            )}
          />
          <Typography.Text type="secondary" style={{ fontSize: 10 }}>
            另有 qiangl（未开通）：登录应与口令错误给同一句提示。
          </Typography.Text>
        </div>
      ) : null}
    </div>
  );
}
