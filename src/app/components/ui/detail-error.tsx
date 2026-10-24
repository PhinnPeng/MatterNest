"use client";

import Link from "next/link";
import { Button } from "antd";
import { ArrowLeftOutlined } from "@ant-design/icons";

import { StateBlock } from "./state-block";
import { ErrorArt } from "./error-art";

/**
 * 详情页读取出错 / 不可见（2026-10-24 从三份逐字重复的块抽出来）。
 *
 * 三条纪律保持不变：
 *   · 404 与"不可见"同形同措辞（权限模型元规则 3），标题不说"你没权限"；
 *   · 非 404 用 error 语气，并把原始错误带出来（"读取出错"四个字没有排查价值）；
 *   · 整页居中 + 插图，而不是贴在内容区左上角的一张小卡片。
 */
export function DetailError({
  what,
  denied,
  error,
  onRetry,
  backHref,
  backLabel,
}: {
  /** 领域名词：案件 / 事项 / 档案 */
  what: string;
  denied: boolean;
  error: unknown;
  onRetry: () => void;
  backHref: string;
  backLabel: string;
}) {
  const message = error instanceof Error ? error.message : "未知错误";
  const back = (
    <Link href={backHref}>
      <Button size="small" icon={<ArrowLeftOutlined />}>
        {backLabel}
      </Button>
    </Link>
  );

  return (
    <StateBlock
      layout="page"
      art={<ErrorArt variant={denied ? "not-found" : "error"} />}
      tone={denied ? "denied" : "error"}
      title={denied ? `打不开这条${what}` : "读取出错"}
      hint={
        denied
          ? "它要么不存在，要么不在你的数据范围内 —— 这两种情况系统给的是同一个响应，不区分。"
          : message
      }
      action={
        denied ? (
          back
        ) : (
          <div className="rowflex" style={{ gap: 8, justifyContent: "center" }}>
            <Button size="small" onClick={onRetry}>
              重试
            </Button>
            {back}
          </div>
        )
      }
    />
  );
}
