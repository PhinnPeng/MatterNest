"use client";

import { INK } from "@/app/theme/brand";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Form, Input, Typography } from "antd";

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
 * 曾有一块"演示账号（口令 = 账号，点一下填入）"的提示，只在非生产渲染。
 * 它依赖「seed 的口令 = 用户名」这个前提；F1 把口令摘要从 seed 与库里都清掉之后，
 * 该前提不成立，那块就变成了一个必然 401 的控件（页面上却写着"点一下填入"），
 * 已整块撤除。冒烟改走运行时自建的一次性账号，不依赖仓库里的任何凭据。
 */
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
    </div>
  );
}
