"use client";

import { INK } from "@/app/theme/brand";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Form, Input, Space, Tag, Typography } from "antd";

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
  { username: "wangkf", who: "总经理", scope: "全公司 L1" },
  { username: "lichen", who: "风控总监", scope: "全公司 L1" },
  { username: "zhaolj", who: "项目负责人（兼两角色）", scope: "L1 + 撤归档" },
  { username: "suny", who: "专员", scope: "我参与 L2" },
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
    <div>
      <Typography.Title level={4} style={{ marginTop: 0, marginBottom: 4 }}>
        登录
      </Typography.Title>
      <Typography.Paragraph style={{ fontSize: 12, color: INK.secondary, marginBottom: 22 }}>
        用公司账号。连续失败不会锁定，但每次都会记进审计。
      </Typography.Paragraph>

      {serverError ? (
        <Alert
          type="error"
          showIcon
          message={serverError}
          style={{ marginBottom: 16 }}
          role="alert"
        />
      ) : null}

      <Form<FormValues>
        form={form}
        layout="vertical"
        requiredMark={false}
        onFinish={submit}
        initialValues={{ username: "", password: "" }}
      >
        <Form.Item label="账号" name="username" rules={rulesFor(loginSchema, ["username"])}>
          <Input size="large" autoFocus autoComplete="username" allowClear />
        </Form.Item>
        <Form.Item label="口令" name="password" rules={rulesFor(loginSchema, ["password"])}>
          <Input.Password size="large" autoComplete="current-password" />
        </Form.Item>
        <Button size="large" type="primary" htmlType="submit" block loading={busy}>
          登录
        </Button>
      </Form>

      {process.env.NODE_ENV !== "production" ? (
        <div style={{ marginTop: 26, borderTop: `1px solid ${INK.line}`, paddingTop: 12 }}>
          <Typography.Paragraph style={{ fontSize: 11, color: INK.secondary, marginBottom: 6 }}>
            演示账号（口令 = 账号，点一下填入）。换一个账号登就能看到同一张表行数不同——
            那是服务端范围谓词在起作用，不是前端筛的。
          </Typography.Paragraph>
          {/* 用 text Button 而不是带 onClick 的 div：这块要能用键盘走到（Tab + Enter） */}
          <Space orientation="vertical" size={2} style={{ width: "100%" }}>
            {DEMO.map((d) => (
              <Button
                key={d.username}
                type="text"
                size="small"
                block
                style={{ textAlign: "left", paddingInline: 6 }}
                onClick={() => {
                  form.setFieldsValue({ username: d.username, password: d.username });
                }}
              >
                <Space size={6}>
                  <span className="num" style={{ fontSize: 12 }}>
                    {d.username}
                  </span>
                  <span style={{ fontSize: 11, color: INK.secondary }}>{d.who}</span>
                  <Tag
                    variant="filled"
                    style={{ fontSize: 11, lineHeight: "16px", marginInlineEnd: 0 }}
                  >
                    {d.scope}
                  </Tag>
                </Space>
              </Button>
            ))}
          </Space>
          <Typography.Text style={{ fontSize: 11, color: INK.secondary }}>
            另有 qiangl（未开通）：登录应与口令错误给同一句提示。
          </Typography.Text>
        </div>
      ) : null}
    </div>
  );
}
