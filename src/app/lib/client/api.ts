import { useQuery } from "@tanstack/react-query";

/**
 * 客户端读取层。
 *
 * 这里存在的理由是禁令⑥：**页面壳不得预取业务数据**。所以本项目的 `page.tsx` 全是
 * server component 的空壳，真数据由客户端经 `/api/**` 取（鉴权在 handler 内做，
 * 见 `spec/backend/error-handling.md`）。SSR 阶段一个业务请求都不发 —— N7 spike 已在
 * `/spike/n7` 的 HTML 上验过这点：表头在、业务行 0 条。
 *
 * 401 一律跳登录：会话过期是常态，让用户对着一个空表格猜比直接送他去登录页好。
 * 404 不跳：那可能是权限收窄（默认拒绝给 404 而不是 403），跳登录会掩盖真实原因。
 */
export type ApiError = {
  error: string;
  message: string;
  issues?: { path: string; message: string }[];
};

export class ApiFailure extends Error {
  status: number;
  issues?: { path: string; message: string }[];
  constructor(status: number, payload: ApiError) {
    super(payload.message);
    this.status = status;
    this.issues = payload.issues;
  }
}

type Options = RequestInit & {
  /** 默认 true；登录页自己处理 401，不能再跳一次登录 */ redirectOn401?: boolean;
};

async function request<T>(path: string, init?: Options): Promise<T> {
  const { redirectOn401 = true, ...rest } = init ?? {};
  const res = await fetch(path, {
    ...rest,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  // 已经在 /login 就不再赋值 location：那会整页重载、把刚拿到的错误提示冲掉，
  // 用户看到的是"点了登录没反应"。
  if (
    res.status === 401 &&
    redirectOn401 &&
    typeof window !== "undefined" &&
    window.location.pathname !== "/login"
  ) {
    window.location.href = "/login";
  }
  const text = await res.text();
  const data = text ? (JSON.parse(text) as T & ApiError) : ({} as T & ApiError);
  if (!res.ok) throw new ApiFailure(res.status, data as ApiError);
  return data;
}

export const api = {
  get: <T>(path: string, init?: Options) => request<T>(path, init),
  post: <T>(path: string, body?: unknown, init?: Options) =>
    request<T>(path, {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
      ...init,
    }),
};

/**
 * 会话查询。`staleTime: Infinity` —— 一次登录里角色/范围不会变，
 * 而每个页面都独立要 actor，不去重的话 /meta 与页面各发一次。
 */
export type Actor = {
  userId: string;
  displayName: string;
  dataScope: "all" | "participating" | "owned";
  privileges: {
    canUnarchive: boolean;
    canReadPlain: boolean;
    canManageUser: boolean;
    canManageConfig: boolean;
  };
};

export function useActor() {
  return useQuery({
    queryKey: ["session"],
    queryFn: () => api.get<Actor>("/api/session"),
    staleTime: Infinity,
  });
}

/** 两个宿主。值域与 `mn_status_config.host_type` 的 CHECK 同源（枚举表 E08）。 */
export type HostKind = "matter" | "risk_matter";

export type StatusRow = { code: string; name: string; semantics: string };
export type LevelRow = { code: string; name: string };

/** `/api/meta` 的响应。字典分两半的理由见那个 route handler 的注释。 */
export type Meta = {
  actor: Actor;
  statuses: StatusRow[];
  levels: LevelRow[];
  tags: { id: string; name: string }[];
  enums: {
    caseTypes: Record<string, string>;
    procedures: Record<string, string>;
    litigationRoles: Record<string, string>;
    partyTypes: Record<string, string>;
    idTypes: Record<string, string>;
    riskTypes: Record<string, string>;
    riskSources: Record<string, string>;
    nodeStatuses: Record<string, string>;
    progressTypes: Record<string, string>;
    staffRoles: Record<string, string>;
    nodeSourceKinds: Record<string, string>;
    timeTypes: Record<string, string>;
    auditActions: Record<string, string>;
    semantics: Record<string, string>;
  };
};

/**
 * 详情页响应 = `mn_matter` 一行 + 六个从属数组。
 * 类型写在这里而不是 `page.tsx` 里现取现用：字段名与列名一一对应，
 * 服务层改了 select 列时这里会先红，比页面上 undefined 好找。
 */
export type MatterDetail = {
  id: string;
  internalCode: string;
  caseNo: string;
  name: string;
  cause: string;
  caseType: string;
  procedure: string;
  litigationRole: string;
  court: string | null;
  amount: string;
  currency: string;
  level: string;
  ownerId: string;
  status: string;
  isArchived: boolean;
  archivedAt: string | null;
  filingDate: string | null;
  closingDate: string | null;
  lastProgressAt: string | null;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  nodes: {
    id: string;
    hostId: string;
    nodeTypeId: string;
    nodeType: string;
    name: string;
    timeType: string;
    startTime: string | null;
    endTime: string | null;
    isTimeConfirmed: boolean;
    deadlineTime: string | null;
    status: string;
    sourceKind: string;
    ownerId: string | null;
    ownerName: string | null;
    sortOrder: number;
    remark: string | null;
    completedAt: string | null;
    cancelReason: string | null;
  }[];
  staff: { id: string; staffRole: string; userId: string; displayName: string }[];
  parties: {
    id: string;
    partyRole: string;
    represented: boolean;
    name: string;
    type: string;
    idNumber: string | null;
  }[];
  comments: {
    id: string;
    body: string;
    createdAt: string;
    parentId: string | null;
    author: string;
  }[];
  progress: {
    id: string;
    progressType: string;
    content: string;
    nextPlan: string | null;
    progressDate: string;
    createdAt: string;
    author: string;
  }[];
  activity: {
    id: string;
    action: string;
    reason: string | null;
    createdAt: string;
    operator: string;
  }[];
  statuses: StatusRow[];
};

/** 下拉字典（状态与等级是配置表驱动，必须从服务端读，见 `/api/meta`） */
export function useMeta(host: HostKind) {
  return useQuery({
    queryKey: ["meta", host],
    queryFn: () => api.get<Meta>(`/api/meta?host=${host}`),
    staleTime: 60_000,
  });
}

/** 把枚举字典变成 `<select>` 的选项，避免每个表单自己写一遍 map */
export function toOptions(labels: Record<string, string>) {
  return Object.entries(labels).map(([value, label]) => ({ value, label }));
}

/** 工作台读数（`/api/overview`，口径与列表一致：归档不计入） */
export type Overview = {
  matters: { total: number; byStatus: Record<string, number> };
  nodes: { overdue: number; within7: number; later: number };
  risks: { total: number; converted: number };
  upcoming: {
    id: string;
    name: string;
    status: string;
    deadlineTime: string | null;
    hostId: string;
    hostCode: string;
    hostName: string;
    owner: string | null;
  }[];
  recent: {
    id: string;
    action: string;
    actionLabel: string;
    reason: string | null;
    createdAt: string;
    operator: string;
    hostCode: string | null;
    hostId: string | null;
    kind: HostKind;
  }[];
};

export function useOverview() {
  return useQuery({
    queryKey: ["overview"],
    queryFn: () => api.get<Overview>("/api/overview"),
    // 到期天数是按"现在"算的，隔一分钟数字就可能变档；但工作台不该每 10 秒敲库，
    // 所以只给 60 秒的新鲜度 + 手动刷新按钮。
    staleTime: 60_000,
  });
}
