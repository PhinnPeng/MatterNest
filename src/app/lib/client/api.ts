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
  /**
   * `patch` / `del` 单独补上，而不是在 `post` 里塞第二个参数。
   *
   * 之前 `api` 只有 get/post，于是 PATCH/DELETE 只能碰 `request` 那层私有实现，
   * 页面要么绕开（拿 POST 去调改语义的端点）要么各自 fetch 一遍——
   * 后者会让 401 跳转、错误文案这些横切行为各写一遍。禁令⑧：同一处出，校验与错误处理单源。
   */
  patch: <T>(path: string, body?: unknown, init?: Options) =>
    request<T>(path, {
      method: "PATCH",
      body: body === undefined ? undefined : JSON.stringify(body),
      ...init,
    }),
  del: <T>(path: string, init?: Options) => request<T>(path, { method: "DELETE", ...init }),
};

/**
 * 会话查询。`staleTime: Infinity` —— 一次登录里角色/范围不会变，
 * 而每个页面都独立要 actor，不去重的话 /meta 与页面各发一次。
 */
export type Actor = {
  userId: string;
  displayName: string;
  dataScope: "all" | "participating" | "owned";
  /** 系统所有者：一期唯一用法是"能不能进凭据设置"（F6-9）。见服务端 `auth.ts` 的注释 */
  isSystemOwner: boolean;
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

/**
 * `/api/meta` 的状态行。带上 `nextStatusCodes` 是为了让前端与服务层跑**同一个**偏离谓词
 * （`shared/schema/status-transition.ts`）—— 不带就只能"永远显示原因框"或"永远不显示"。
 */
export type StatusRow = {
  code: string;
  name: string;
  semantics: string;
  nextStatusCodes: string[];
};
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

/**
 * 事项详情（T1）。
 *
 * 与 `MatterDetail` **刻意不对称**（IQ-5「事项是台账，案件是战场」），不是抄漏了：
 *   · `ownerId` 可为 null —— 事项的经办人可空，空 = 未指派处理人
 *   · `nodes` 可能是空数组 —— 事项侧无预设节点，节点只能手动加
 *   · 节点只有时间点 —— `timeType` 收窄成字面量 `"point"`、`endTime` 收窄成 `null`，
 *     让「给事项节点加时间段」在**类型层**就写不出来
 *   · 没有 `progress` / `expense` / `attachments` —— 事项核查走**处置记录**
 * `convertedCases` 是事项**独有**的块：事项是转案件的上游，详情页要能反查回去。
 */
export type RiskDetail = {
  id: string;
  code: string;
  name: string;
  type: string;
  level: string;
  source: string | null;
  description: string;
  measure: string | null;
  amount: string;
  currency: string;
  status: string;
  /** 可空：事项侧经办人可空（IQ-5） */
  ownerId: string | null;
  ownerName: string | null;
  /** 关注名单管理权判定的第三档（§6：经办人 / L1 / 创建人） */
  creatorId: string | null;
  discoverDate: string;
  isArchived: boolean;
  archivedAt: string | null;
  conversionStatus: number;
  convertedCaseCount: number;
  convertedAt: string | null;
  createdAt: string;
  updatedAt: string;
  nodes: {
    id: string;
    nodeTypeId: string;
    name: string;
    timeType: "point";
    startTime: string | null;
    endTime: null;
    isTimeConfirmed: boolean;
    deadlineTime: string | null;
    status: string;
    sourceKind: "manual" | "preset" | "rule";
    sortOrder: number;
    cancelReason: string | null;
    completedAt: string | null;
  }[];
  staff: { id: string; userId: string; staffRole: string; name: string }[];
  parties: { id: string; partyId: string; partyRole: string; name: string; type: string }[];
  comments: {
    id: string;
    body: string;
    parentId: string | null;
    isEdited: boolean;
    authorId: string;
    authorName: string;
    createdAt: string;
    updatedAt: string;
  }[];
  activity: {
    id: string;
    action: string;
    reason: string | null;
    operatorId: string;
    createdAt: string;
  }[];
  statuses: StatusRow[];
  /** 可选节点类型，**服务端已过滤掉 range**（事项节点只支持时间点） */
  nodeTypes: { id: string; code: string; name: string }[];
  /** 已转案件反查（T1 详情页的独有块） */
  convertedCases: {
    id: string;
    internalCode: string;
    caseNo: string;
    name: string;
    status: string;
    isArchived: boolean;
  }[];
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

/**
 * 当事人检索的一行。只回**证件号尾四位**用于消歧 —— 明文展示是另一条链路
 * （IQ-12 后展示层全明文，逐次审计已作废；留痕的是**导出**两档：走 `can_read_plain` + `EXPORT` 审计）。
 */
export type PartyHit = { id: string; name: string; type: string; idNumberTail: string };
export type PartySearchResult = { items: PartyHit[]; truncated: boolean };

/**
 * 建案时「引用既有当事人」下拉（F2-15）。
 *
 * 关键字为空**不发请求**：服务端 `partySearchSchema` 的 `min(1)` 也会拒，但把
 * "打开表单就敲一次列举"挡在客户端这一侧更诚实 —— §4.1 拒绝裸 `/users` 列表是同一个理由。
 * `staleTime` 30 秒：同一次建案里反复搜同一家不该反复敲库。
 */
export function usePartySearch(keyword: string) {
  const kw = keyword.trim();
  return useQuery({
    queryKey: ["party-search", kw],
    queryFn: () => api.get<PartySearchResult>(`/api/parties?q=${encodeURIComponent(kw)}`),
    enabled: kw.length > 0,
    staleTime: 30_000,
  });
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
