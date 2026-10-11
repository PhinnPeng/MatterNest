/**
 * 业务分类（枚举表 §2：E11–E22、E26–E28，以及复用 E12 的 E06、布尔的 E07）。
 * 权威源：`docs/PRD-phase1-enums-and-schemas.md` §2；中文名逐值取自该表「说明」列，
 * 该表没给中文名的（E17/E18/E20/E22 的部分值）列在 `DERIVED_LABELS` 里显式承认是推导，不装成权威叫法。
 *
 * 三条容易写错的口径写在值旁边，因为它们都参与代码分支：
 *   · E12 **禁止缩写 `risk`**；`respondent` 与 `respondent_petition` 是两个不同位置（前者=被申请人，
 *     后者=再审被申请人），中文名相同但值不能合并 —— 转案件字段映射按值分支。
 *   · E20 第一期**无审批流**，所以没有 `approved`；把 `approved` 加进来就是给二期挖坑。
 *   · E28 是 `smallint` 不是枚举语义（修订稿 §3.4「已转案件」与状态位正交），故 label 挂在数字上。
 */

/** E10 ∩ E08 共用值域见 `./targets`；E11 `node_type_config.time_type` */
export const TIME_TYPES = ["point", "range"] as const;
export type TimeType = (typeof TIME_TYPES)[number];
export const DEFAULT_TIME_TYPE: TimeType = "point";
export const TIME_TYPE_LABELS: Record<TimeType, string> = {
  point: "时间点",
  range: "时间段",
};

/** E12 `matter.litigation_role` / E06 `*_party.party_role`（复用同一值域，不另建第二份） */
export const LITIGATION_ROLES = [
  "plaintiff",
  "defendant",
  "third_party",
  "applicant",
  "respondent",
  "appellant",
  "appellee",
  "petitioner",
  "respondent_petition",
  "executant",
  "other",
] as const;
export type LitigationRole = (typeof LITIGATION_ROLES)[number];
export const LITIGATION_ROLE_LABELS: Record<LitigationRole, string> = {
  plaintiff: "原告",
  defendant: "被告",
  third_party: "第三人",
  applicant: "申请人",
  respondent: "被申请人",
  appellant: "上诉人",
  appellee: "被上诉人",
  petitioner: "再审申请人",
  respondent_petition: "被申请人（再审）",
  executant: "被执行人",
  other: "其他",
};

/**
 * E07 `*_party.represented` 是布尔，**不是枚举**（枚举表写明"与 party_role 正交"）。
 * 登记在此只为让覆盖性测试承认这一行已被处理，防止有人把它做成 `role+represented` 的合并枚举。
 *
 * ⚠ **软作废（IQ-15）**：列留库不删，但 DTO / 服务层 / 前端不再读写。
 */
export const REPRESENTED_IS_BOOLEAN = {
  id: "E07",
  field: "*_party.represented",
  note: "布尔，❌ 已随 IQ-15 软作废（企业口径下我方永不入 party 表，代理参照系消失）：列留库不删，DTO/服务层/前端不再读写；我方立场改由案件 litigation_role 表达",
} as const;

/**
 * E13 `matter.case_type`
 *
 * `non_litigation` 是**作废值**：案件 = 正式法律程序（诉讼/仲裁/执行），
 * "非诉"不作案件分类，非诉事务归风险事项（E15，IQ-6/Q25）。
 * 按枚举表 §5.3 废弃流程——常量与 CHECK 都保留（历史行仍需反查中文名），
 * 但**禁止新写入、前端不展示**。新写入请用 `CASE_TYPES_WRITABLE`。
 */
export const CASE_TYPES = [
  "civil_commercial",
  "criminal",
  "administrative",
  "non_litigation",
] as const;
export type CaseType = (typeof CASE_TYPES)[number];
export const CASE_TYPE_LABELS: Record<CaseType, string> = {
  civil_commercial: "民商事",
  criminal: "刑事",
  administrative: "行政",
  non_litigation: "非诉",
};

/** 可写入 / 可展示的案件类型 = 全集去掉作废值。写路径与下拉一律用它，不要用 `CASE_TYPES` */
export const CASE_TYPES_WRITABLE = CASE_TYPES.filter((v) => v !== "non_litigation");

/** E14 `matter.procedure`（修订稿 §6.3：把原文"…等"的开放表述换成闭集白名单） */
export const PROCEDURES = [
  "first_instance",
  "second_instance",
  "retrial_review",
  "retrial",
  "arbitration",
  "execution",
  "execution_objection",
  "bankruptcy",
  "other",
] as const;
export type Procedure = (typeof PROCEDURES)[number];
export const PROCEDURE_LABELS: Record<Procedure, string> = {
  first_instance: "一审",
  second_instance: "二审",
  retrial_review: "再审审查",
  retrial: "再审",
  arbitration: "仲裁",
  execution: "执行",
  execution_objection: "执行异议",
  bankruptcy: "破产",
  other: "其他",
};

/** E15 `risk_matter.type` */
export const RISK_MATTER_TYPES = [
  "contract",
  "labor_dispute",
  "ip",
  "corporate_governance",
  "debt",
  "compliance",
  "litigation_derived",
  "other",
] as const;
export type RiskMatterType = (typeof RISK_MATTER_TYPES)[number];
export const RISK_MATTER_TYPE_LABELS: Record<RiskMatterType, string> = {
  contract: "合同",
  labor_dispute: "劳动争议",
  ip: "知识产权",
  corporate_governance: "公司治理",
  debt: "债权债务",
  compliance: "合规",
  litigation_derived: "诉讼衍生",
  other: "其他",
};

/**
 * E16 `risk_matter.source`（选填）
 *
 * IQ-5 偏差5：`customer_complaint`（"客户投诉"）是律所代理口径——企业当事方
 * 没有客户，新值名为 `external_dispute`（对外纠纷/投诉）。按枚举表 §5.3 废弃流程，
 * 旧值保留在数组与 CHECK 里（历史行仍需反查中文名）但**禁止新写入、前端不展示**；
 * 新写入与下拉一律用 `RISK_MATTER_SOURCES_WRITABLE`。
 */
export const RISK_MATTER_SOURCES = [
  "business_report",
  "external_dispute",
  "customer_complaint",
  "lawyer_letter",
  "internal_check",
  "other",
] as const;
export type RiskMatterSource = (typeof RISK_MATTER_SOURCES)[number];
export const RISK_MATTER_SOURCE_LABELS: Record<RiskMatterSource, string> = {
  business_report: "业务报备",
  external_dispute: "对外纠纷/投诉",
  /** @deprecated 律所残留值，见上。历史行反查用，勿用于新写入 */
  customer_complaint: "客户投诉",
  lawyer_letter: "收到对方当事人律师函",
  internal_check: "内部检查",
  other: "其他",
};

/** 可写入 / 可展示的来源 = 全集去掉作废值。写路径与下拉一律用它，不要用 `RISK_MATTER_SOURCES` */
export const RISK_MATTER_SOURCES_WRITABLE = RISK_MATTER_SOURCES.filter(
  (v) => v !== "customer_complaint",
);

/** E17 `party.type`：决定 E18 与 `id_number` 的校验规则 */
export const PARTY_TYPES = ["natural_person", "legal_person", "unincorporated_org"] as const;
export type PartyType = (typeof PARTY_TYPES)[number];
export const PARTY_TYPE_LABELS: Record<PartyType, string> = {
  natural_person: "自然人",
  legal_person: "法人",
  unincorporated_org: "非法人组织",
};

/** E18 `party.id_type`（选填；按 E17 时期望不同子集） */
export const ID_TYPES = [
  "id_card",
  "unified_social_credit",
  "passport",
  "hk_mo_tw_permit",
  "military_id",
  "foreign_residence",
  "other",
] as const;
export type IdType = (typeof ID_TYPES)[number];
export const ID_TYPE_LABELS: Record<IdType, string> = {
  id_card: "居民身份证",
  unified_social_credit: "统一社会信用代码",
  passport: "护照",
  hk_mo_tw_permit: "港澳台通行证",
  military_id: "军官证",
  foreign_residence: "外国人居留证",
  other: "其他",
};
/** 枚举表 E18 说明：自然人时期望证件子集，法人时期望 `unified_social_credit` */
export const ID_TYPES_BY_PARTY: Record<PartyType, readonly IdType[]> = {
  natural_person: [
    "id_card",
    "passport",
    "hk_mo_tw_permit",
    "military_id",
    "foreign_residence",
    "other",
  ],
  legal_person: ["unified_social_credit", "other"],
  unincorporated_org: ["unified_social_credit", "other"],
};

/** E19 `matter_progress.progress_type`（修订稿 §6.3 闭合） */
export const PROGRESS_TYPES = [
  "routine",
  "court_action",
  "counterparty",
  "client_feedback",
  "internal_decision",
  "material_filing",
] as const;
export type ProgressType = (typeof PROGRESS_TYPES)[number];
export const PROGRESS_TYPE_LABELS: Record<ProgressType, string> = {
  routine: "日常推进",
  court_action: "法院动作",
  counterparty: "对方动作",
  client_feedback: "客户反馈",
  internal_decision: "内部决议",
  material_filing: "材料提交",
};

/** E20 `matter_expense.status`：第一期**无审批**，不含 `approved` */
export const EXPENSE_STATUSES = ["pending_pay", "paid", "void"] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];
export const EXPENSE_STATUS_LABELS: Record<ExpenseStatus, string> = {
  pending_pay: "待支付",
  paid: "已支付",
  void: "作废",
};

/** E21 `matter_node.status` / `risk_matter_node.status`（修订稿 §3.5 生命周期） */
export const NODE_STATUSES = ["not_started", "in_progress", "completed", "cancelled"] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];
export const NODE_STATUS_LABELS: Record<NodeStatus, string> = {
  not_started: "未开始",
  in_progress: "进行中",
  completed: "已完成",
  cancelled: "已取消",
};
export const DEFAULT_NODE_STATUS: NodeStatus = "not_started";
/** E21 与 E31/E23 的区别写在值上：节点"已取消"是用户动作，投递层没有这个值 */
export const NODE_OPEN_STATUSES: readonly NodeStatus[] = ["not_started", "in_progress"];

/** E22 `*_node.source_kind`：原 `preset_p1`/`rule_p2` 命名作废，P1/P2 路径由 `source_ref` 区分 */
export const NODE_SOURCE_KINDS = ["manual", "preset", "rule"] as const;
export type NodeSourceKind = (typeof NODE_SOURCE_KINDS)[number];
export const NODE_SOURCE_KIND_LABELS: Record<NodeSourceKind, string> = {
  manual: "手工添加",
  preset: "创建时预设",
  rule: "规则生成",
};
export const DEFAULT_NODE_SOURCE_KIND: NodeSourceKind = "manual";

/** E26 `attachment.category`（第一期不做配置表） */
export const ATTACHMENT_CATEGORIES = [
  "evidence",
  "complaint",
  "judgment",
  "contract",
  "internal_doc",
  "other",
] as const;
export type AttachmentCategory = (typeof ATTACHMENT_CATEGORIES)[number];
export const ATTACHMENT_CATEGORY_LABELS: Record<AttachmentCategory, string> = {
  evidence: "证据",
  complaint: "起诉状",
  judgment: "判决书",
  contract: "合同",
  internal_doc: "内部文书",
  other: "其他",
};

/** E27 通用 `currency`：`char(3)`，列先留、值锁死（避免日后加币种时改 numeric 精度） */
export const CURRENCIES = ["CNY"] as const;
export type Currency = (typeof CURRENCIES)[number];
export const CURRENCY_LABELS: Record<Currency, string> = { CNY: "人民币" };
export const DEFAULT_CURRENCY: Currency = "CNY";

/** E28 `risk_matter.conversion_status`：`smallint` 而非枚举语义（修订稿 §3.4） */
export const CONVERSION_STATUSES = [0, 1] as const;
export type ConversionStatus = (typeof CONVERSION_STATUSES)[number];
export const CONVERSION_STATUS_LABELS: Record<ConversionStatus, string> = {
  0: "未转案件",
  1: "已转案件",
};
export const DEFAULT_CONVERSION_STATUS: ConversionStatus = 0;

/**
 * 中文名非文档原词的值（枚举表只给了 code，或只给了半句说明）。
 * 单列出来是防止将来有人把这些 label 当"权威术语"去改文档。
 */
export const DERIVED_LABELS: readonly string[] = [
  "E17 三项（自然人/法人/非法人组织）",
  "E18 全部",
  "E20 三项（待支付/已支付/作废）",
  "E22 三项（手工添加/创建时预设/规则生成）",
];
