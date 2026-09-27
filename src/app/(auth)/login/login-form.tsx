"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";

import { api, ApiFailure } from "@/app/lib/client/api";
import { loginSchema, type LoginInput } from "@/shared/schema/hosts";
import { Button } from "@/app/components/ui/button";
import { Field } from "@/app/components/form/fields";
import { Input } from "@/app/components/ui/input";
import { StateBlock } from "@/app/components/ui/state-block";

/**
 * 登录表单。
 *
 * 服务端对"账号不存在 / 口令错 / 未开通"给同一个 401 文案（那是防枚举，见 login route），
 * 所以这里也**只**显示那一句，不改写成"口令不正确"——客户端文案不能把服务端的防泄露口径打回原形。
 *
 * 演示账号提示块只在非生产渲染：这套 seed 的口令等于用户名，生产绝不能带这段文案。
 */
const DEMO = [
  { username: "wangkf", who: "主任", scope: "全所 L1" },
  { username: "lichen", who: "风控合伙人", scope: "全所 L1" },
  { username: "zhaolj", who: "承办律师（兼两角色）", scope: "L1 + 撤归档" },
  { username: "suny", who: "助理", scope: "我参与 L2" },
  { username: "hezp", who: "IT", scope: "我承办 L3 + 管配置" },
];

export function LoginForm() {
  const router = useRouter();
  const qc = useQueryClient();
  const [serverError, setServerError] = useState<string | null>(null);
  const [pendingUsername, setPendingUsername] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { username: "", password: "" },
  });

  const onSubmit = handleSubmit(async (values) => {
    setServerError(null);
    try {
      // 登录失败与"会话过期"共用一个状态码，这里显式关掉自动跳转（见 api.request）
      await api.post("/api/auth/login", values, { redirectOn401: false });
      // 换人必须清缓存：上一个账号的范围谓词不一样，缓存着的列表会让新用户看见别人的行
      qc.clear();
      router.replace("/");
    } catch (e) {
      setServerError(e instanceof ApiFailure ? e.message : "登录失败，请稍后再试");
    }
  });

  function fill(username: string) {
    // 演示便利：点账号=同时填口令（这套 seed 口令等于用户名，仅 dev）
    setValue("username", username, { shouldValidate: true });
    setValue("password", username, { shouldValidate: true });
    setPendingUsername(username);
  }

  return (
    <form onSubmit={onSubmit} className="w-full max-w-sm" noValidate>
      <h2 className="text-lg font-semibold">登录</h2>
      <p className="mt-1 mb-5 text-xs text-muted-foreground">
        用本所账号。连续失败不会锁定，但每次都会记进审计。
      </p>

      <div className="grid gap-3.5">
        <Field label="账号" required error={errors.username?.message} htmlFor="login-username">
          <Input
            id="login-username"
            autoComplete="username"
            autoFocus
            aria-invalid={Boolean(errors.username)}
            {...register("username")}
          />
        </Field>
        <Field label="口令" required error={errors.password?.message} htmlFor="login-password">
          <Input
            id="login-password"
            type="password"
            autoComplete="current-password"
            aria-invalid={Boolean(errors.password)}
            {...register("password")}
          />
        </Field>
      </div>

      {serverError ? <StateBlock className="mt-4" tone="error" title={serverError} /> : null}

      <Button type="submit" className="mt-5 w-full" disabled={isSubmitting}>
        {isSubmitting ? "登录中" : "登录"}
      </Button>

      {process.env.NODE_ENV !== "production" ? (
        <div className="mt-7 border-t border-border pt-4">
          <p className="mb-2 text-xs text-muted-foreground">
            演示账号（口令 = 账号，点一下填入）。换一个账号登就能看到同一张表行数不同——
            那是服务端范围谓词在起作用，不是前端筛的。
          </p>
          <ul className="space-y-1">
            {DEMO.map((d) => (
              <li key={d.username}>
                <button
                  type="button"
                  onClick={() => fill(d.username)}
                  className="group flex w-full items-baseline gap-2 rounded-md px-1.5 py-1 text-left text-xs outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <span className="num text-foreground">{d.username}</span>
                  <span className="text-muted-foreground">{d.who}</span>
                  <span
                    className={`ml-auto shrink-0 ${
                      pendingUsername === d.username ? "text-primary" : "text-muted-foreground/70"
                    }`}
                  >
                    {d.scope}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[0.68rem] text-muted-foreground/80">
            另有 qiangl（未开通）：登录应与口令错误给同一句提示。
          </p>
        </div>
      ) : null}
    </form>
  );
}
