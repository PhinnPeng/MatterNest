"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";

import { api, ApiFailure } from "@/app/lib/client/api";
import { maxLengthOf } from "@/app/components/form/zod-rules";
import { loginSchema } from "@/shared/schema/hosts";

/**
 * 登录表单（MATT-99：换成 canon 的字段与按钮形态）。
 *
 * 校验规则仍从 `loginSchema` 读（禁令⑧）——提交时由同一条 schema 兜底，
 * 字段级报错从 `safeParse` 的 issues 里取（不再走 antd 的 `rulesFor`，
 * 但**规则的定义源还是 shared 那一份**，只是渲染层换成了 canon 的 `.hint.err`）。
 *
 * 服务端对"账号不存在 / 口令错 / 未开通"给同一个 401 文案（防枚举），
 * 所以这里也只显示那一句，不改写成"口令不正确"——客户端文案不能把服务端的防泄露口径打回原形。
 *
 * 原型 `login.html` 有一个「记住我」勾选框，但**后端没有对应的持久化**（会话 Cookie
 * 由服务端下发，客户端无"记住/不记住"之分）。按「不留点了没反应的控件」的纪律，
 * 这里不放它——画一个勾了也不影响登录时长的勾选框，是把一件不存在的事画成可操作的。
 *
 * 2026-10-12 页面优化：① 标题下的副标题按产品口径撤除；② 文案口径统一为"密码"
 * （标签、`loginSchema` 的 validation、登录接口 401 文案三处一起改）。
 */
export function LoginForm() {
  const router = useRouter();
  const qc = useQueryClient();
  // 上界从 schema 取，不在这里写第二份数字（禁令⑧）：schema 改字长时输入框跟着改
  const usernameMax = maxLengthOf(loginSchema, ["username"]);
  const passwordMax = maxLengthOf(loginSchema, ["password"]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [serverError, setServerError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<{ username?: string; password?: string }>({});
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setServerError(null);
    const parsed = loginSchema.safeParse({ username, password });
    if (!parsed.success) {
      // 字段级报错取 schema 的 message（与后端同一份定义），一次把两个字段的错都收齐
      const next: { username?: string; password?: string } = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        if (key === "username" || key === "password") next[key] ??= issue.message;
      }
      setFieldError(next);
      return;
    }
    setFieldError({});
    setBusy(true);
    try {
      // 登录失败与"会话过期"共用一个状态码，所以关掉 api 层的自动跳转（否则整页重载、错误提示被冲掉）
      await api.post("/api/auth/login", parsed.data, { redirectOn401: false });
      // 换人必须清缓存：上一个账号的范围谓词不一样，缓存着的列表会让新用户看见别人的行
      qc.clear();
      router.replace("/");
    } catch (err) {
      setServerError(err instanceof ApiFailure ? err.message : "登录失败，请稍后再试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      {serverError ? (
        <div className="hint err" role="alert" style={{ marginBottom: 14 }}>
          {serverError}
        </div>
      ) : null}

      <div className="field" style={{ marginBottom: fieldError.username ? 6 : 14 }}>
        <label htmlFor="login-username">账号</label>
        <input
          id="login-username"
          className="inp"
          type="text"
          autoFocus
          autoComplete="username"
          maxLength={usernameMax}
          aria-invalid={fieldError.username ? true : undefined}
          aria-describedby={fieldError.username ? "login-username-err" : undefined}
          value={username}
          onChange={(e) => {
            setUsername(e.target.value);
            // 改输入即撤旧错：错误提示留着会让人以为这次提交又失败了
            if (fieldError.username) setFieldError((prev) => ({ ...prev, username: undefined }));
          }}
        />
      </div>
      {fieldError.username ? (
        <div
          id="login-username-err"
          className="hint err"
          role="alert"
          style={{ marginTop: 0, marginBottom: 12 }}
        >
          {fieldError.username}
        </div>
      ) : null}

      <div className="field" style={{ marginBottom: fieldError.password ? 6 : 16 }}>
        <label htmlFor="login-password">密码</label>
        <input
          id="login-password"
          className="inp"
          type="password"
          autoComplete="current-password"
          maxLength={passwordMax}
          aria-invalid={fieldError.password ? true : undefined}
          aria-describedby={fieldError.password ? "login-password-err" : undefined}
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            if (fieldError.password) setFieldError((prev) => ({ ...prev, password: undefined }));
          }}
        />
      </div>
      {fieldError.password ? (
        <div
          id="login-password-err"
          className="hint err"
          role="alert"
          style={{ marginTop: 0, marginBottom: 12 }}
        >
          {fieldError.password}
        </div>
      ) : null}

      <button
        type="submit"
        className="btn pri"
        disabled={busy}
        style={{ width: "100%", justifyContent: "center" }}
      >
        {busy ? "登录中…" : "登录"}
      </button>
    </form>
  );
}
