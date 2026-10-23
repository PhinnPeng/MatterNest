"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input, theme } from "antd";

import { api } from "@/app/lib/client/api";
import { mentionTriggerAt, type MentionTrigger } from "@/app/lib/client/mention-trigger";

/**
 * 带 @ 选人的评论输入框 —— 案件详情「过程记录」与事项详情「评论」共用。
 *
 * ## 为什么之前是个死 prompt
 *
 * 两处输入框此前都是裸 `Input.TextArea`，placeholder 却写着「用 @姓名 提及同事」。
 * 界面**声明**了一个能力，而按 `@` 只会得到一个字面符号：名字要用户自己拼，
 * 拼错一个字（同名、漏字、多空格）通知就静默发不出去，而正文里看着完全正常。
 *
 * ## 为什么不做结构化提及
 *
 * 写入口径（`notifications.ts#resolveMentionIds` → `shared/notification/mention.ts`）
 * 认的是正文里的**字面 `@显示名`**，`mention_ids` 由服务端在那串文本上解析。
 * 所以选中一个人 = 把 `@名字 ` 插进光标处，就这么简单；换成富文本 mention 节点
 * 要同时动编辑器、markdown 往返与 DTO 三处（ADR-0002 也明写编辑器保持默认配置）。
 *
 * ## 为什么不用 antd `Mentions`
 *
 * 它插入的文本与本组件一致，但候选面**永远挂在输入框右边缘外侧**（rc-mentions 的
 * `bottomRight` / `topRight` 固定点位）。评论栏只有 300 多像素宽，实测那个面板
 * 会整个飘到卡片外、盖在正文上；而这里需要的是"贴着输入框、同宽、向上开"。
 * 自绘一个候选面反而更小：定位、宽度、行高都能与本栏其余部分同一套刻度。
 *
 * ## 候选人为什么是 `selectable-users`，而不是全花名册
 *
 * 写入口径的候选人是**全体在职账号**，但那是"解析正文"用的 —— 它不向外泄露名单，
 * 只是把用户已经写下的名字映射成 id。界面不能照抄这一条：按 §4.1，
 * 裸列花名册等于把一份同事清单送到每个登录者手上，`/api/users` 因此必须 `canManageUser`。
 *
 * 所以这里用同一页已经在用的 `/api/{host}/{id}/selectable-users`（在册可用 ∩ 我的可见用户集）：
 * · 它与「变更处理人 / 添加关注人」同一个 `queryKey`，共用缓存，不额外发请求；
 * · 看不到的同事不出现在候选里，但**手打 `@名字` 仍然有效** —— 解析不依赖这份列表，
 *   那正是"先 @ 一个还没进来的同事"的正常时序。
 *
 * ## 去重按显示名
 *
 * 同名同事在解析时**一起命中**（`parseMentionIds`：宁可多喊一个，也不让点名落空），
 * 所以同名两行是同一个动作的两个副本 —— 只留一行，看到的与落库的结果才一致。
 */

/** 宿主类型：值域与 `/api/{host}/...` 的两条路由一一对应 */
export type MentionHost = "matter" | "risk_matter";

const HOST_BASE: Record<MentionHost, string> = {
  matter: "/api/matters",
  risk_matter: "/api/risk-matters",
};

type SelectableUser = { id: string; displayName: string; username: string };

/** 光标处这次提及的判定（纯函数放在 `lib/client/mention-trigger.ts`，带单测） */
const measure = (el: HTMLTextAreaElement) =>
  mentionTriggerAt(el.value, el.selectionStart ?? el.value.length);

/** 候选面板的最大高度：约 8 行，再多就成了遮住半边评论栏的巨物 */
const PANEL_MAX_H = 232;

export type MentionInputProps = {
  host: MentionHost;
  hostId: string;
  value: string;
  onChange: (value: string) => void;
  /** 透传给底层 textarea 的其余属性（`rows` / `autoSize` / `maxLength` / `placeholder` …） */
  rows?: number;
  autoSize?: { minRows?: number; maxRows?: number };
  maxLength?: number;
  placeholder?: string;
  onPressEnter?: React.KeyboardEventHandler<HTMLTextAreaElement>;
  disabled?: boolean;
  /** 作用在外层定位容器上（调用方用它撑满一行） */
  style?: React.CSSProperties;
};

export function MentionInput({
  host,
  hostId,
  value,
  onChange,
  style,
  onPressEnter,
  ...rest
}: MentionInputProps) {
  const { token } = theme.useToken();
  const selectable = useQuery({
    queryKey: ["selectable-users", host, hostId],
    queryFn: () =>
      api.get<{ users: SelectableUser[] }>(`${HOST_BASE[host]}/${hostId}/selectable-users`),
  });

  const elRef = useRef<HTMLTextAreaElement | null>(null);
  /** 插入后要落到的光标位置：等受控 value 渲染完再设，设早了会被这一帧的 value 冲掉 */
  const caretRef = useRef<number | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const [trigger, setTrigger] = useState<MentionTrigger | null>(null);
  const [active, setActive] = useState(0);

  const people = useMemo(() => {
    const seen = new Set<string>();
    return (selectable.data?.users ?? []).flatMap((u) => {
      if (!u.displayName || seen.has(u.displayName)) return [];
      seen.add(u.displayName);
      return [u];
    });
  }, [selectable.data]);

  const keyword = trigger?.query.trim().toLowerCase() ?? "";
  const matches = useMemo(
    () =>
      keyword
        ? people.filter(
            (u) =>
              u.displayName.toLowerCase().includes(keyword) ||
              u.username.toLowerCase().includes(keyword),
          )
        : people,
    [people, keyword],
  );

  // 插入是受控写回：value 落到 DOM 之后才能把光标放回名字后面
  useEffect(() => {
    if (caretRef.current == null) return;
    const el = elRef.current;
    el?.focus();
    el?.setSelectionRange(caretRef.current, caretRef.current);
    caretRef.current = null;
  }, [value]);

  // 键盘上下移动时把当前项收进可视区（候选可能超过 8 行）
  useEffect(() => {
    if (!trigger) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, trigger]);

  const insert = (u: SelectableUser) => {
    const el = elRef.current;
    if (!el || !trigger) return;
    const caret = el.selectionStart ?? value.length;
    const token = `@${u.displayName} `;
    const next = value.slice(0, trigger.start) + token + value.slice(caret);
    caretRef.current = trigger.start + token.length;
    setTrigger(null);
    onChange(next);
  };

  return (
    <div style={{ position: "relative", ...style }}>
      <Input.TextArea
        {...rest}
        value={value}
        onChange={(e) => {
          elRef.current = e.currentTarget;
          setTrigger(measure(e.currentTarget));
          setActive(0);
          onChange(e.target.value);
        }}
        // 光标自己挪走（点别处、Home/End）时跟着重算，否则面板会留在上一个人的名字上
        onSelect={(e) => {
          elRef.current = e.currentTarget;
          setTrigger(measure(e.currentTarget));
        }}
        onPressEnter={onPressEnter}
        // 点到页面别处就收起来：候选面是这一行的附属物，不该跟着输入框漂在别的内容上
        onBlur={() => setTrigger(null)}
        onKeyDown={(e) => {
          elRef.current = e.currentTarget;
          if (!trigger) return;
          if (e.key === "Escape") {
            setTrigger(null);
            return;
          }
          if (!matches.length) return;
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const step = e.key === "ArrowDown" ? 1 : -1;
            setActive((i) => (i + step + matches.length) % matches.length);
            return;
          }
          // Enter / Tab 选中：Tab 不跳焦点，Enter 不换行（换行是 Ctrl+Enter 提交之外的自由）
          if (e.key === "Enter" || e.key === "Tab") {
            e.preventDefault();
            const target = matches[active] ?? matches[0];
            if (target) insert(target);
          }
        }}
      />

      {trigger ? (
        <div
          ref={listRef}
          role="listbox"
          aria-label="选择要提及的同事"
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: "calc(100% + 6px)",
            zIndex: 20,
            maxHeight: PANEL_MAX_H,
            overflowY: "auto",
            padding: 4,
            background: token.colorBgElevated,
            border: "1px solid var(--line)",
            borderRadius: 8,
            boxShadow: token.boxShadowSecondary,
          }}
        >
          {selectable.isPending ? (
            <PanelNote>读取中…</PanelNote>
          ) : matches.length === 0 ? (
            <PanelNote>没有匹配的同事</PanelNote>
          ) : (
            matches.map((u, i) => (
              <button
                key={u.id}
                type="button"
                role="option"
                aria-selected={i === active}
                data-idx={i}
                // 鼠标按下就选中，但不能让 textarea 丢焦点 —— 丢了就看不见光标插到哪
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => insert(u)}
                style={{
                  display: "block",
                  width: "100%",
                  height: 28,
                  padding: "0 8px",
                  border: "none",
                  borderRadius: 4,
                  background: i === active ? token.controlItemBgHover : "transparent",
                  color: "inherit",
                  font: "inherit",
                  fontSize: 13,
                  textAlign: "left",
                  cursor: "pointer",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {u.displayName}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

function PanelNote({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: "6px 8px", fontSize: 12, color: "var(--ink3)" }}>{children}</div>;
}
