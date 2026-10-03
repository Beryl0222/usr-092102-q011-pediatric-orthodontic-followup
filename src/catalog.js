// 儿童正畸生长随访——领域事件目录（单一事实来源）
//
// 设计原则：
// 1. 事件只描述“发生了什么”，不包含自动诊断结论；任何治疗都必须经过
//    PLAN_PROPOSED -> CONSENT_GRANTED(TREATMENT) -> PLAN_CONFIRMED 的人工路径，
//    系统不得仅凭年龄生成治疗方案。
// 2. 事件流仅追加（append-only）。发育变化、依从困难、器械不良反应通过
//    PLAN_REVISED / PLAN_REASSESSED 追加处理，原判断事件永不修改、不删除。
// 3. 同一证据可承载多位医生的意见（OPINION_ISSUED 可多次出现，互不覆盖）。
// 4. 用途授权（诊疗 / 教学 / 科研 / 跨院连续）按证据粒度记账，撤回仅对
//    未来用途生效；临床连续性义务不因撤回而中断。

export const SCHEMA_VERSION = 2;

export const AGGREGATES = Object.freeze({
  GROWTH_EPISODE: "growth_episode",
  CLINICAL_OBSERVATION: "clinical_observation",
  CARE_PLAN: "care_plan",
  CONSENT_SCOPE: "consent_scope",
  CHILD_RECORD: "child_record",
});

export const EVENT_TYPES = Object.freeze({
  // —— growth_episode：一次连续随访主线 ——
  EPISODE_OPENED: "EPISODE_OPENED",
  RISK_ESCALATED: "RISK_ESCALATED",
  RISK_RESOLVED: "RISK_RESOLVED",
  FOLLOWUP_WINDOW_SCHEDULED: "FOLLOWUP_WINDOW_SCHEDULED",
  FOLLOWUP_COMPLETED: "FOLLOWUP_COMPLETED",
  REFERRAL_ISSUED: "REFERRAL_ISSUED",

  // —— child_record：儿童身份与监护关系 ——
  CHILD_REGISTERED: "CHILD_REGISTERED",
  GUARDIAN_LINKED: "GUARDIAN_LINKED",
  GUARDIAN_CHANGED: "GUARDIAN_CHANGED",

  // —— clinical_observation：检查来源、证据、观察、多医生意见 ——
  EVIDENCE_CAPTURED: "EVIDENCE_CAPTURED",
  OBSERVATION_RECORDED: "OBSERVATION_RECORDED",
  OPINION_ISSUED: "OPINION_ISSUED",

  // —— care_plan：方案提出 / 确认 / 修订 / 复评 / 治疗期事件 ——
  PLAN_PROPOSED: "PLAN_PROPOSED",
  PLAN_CONFIRMED: "PLAN_CONFIRMED",
  PLAN_REVISED: "PLAN_REVISED",
  PLAN_REASSESSED: "PLAN_REASSESSED",
  ADVERSE_REACTION_REPORTED: "ADVERSE_REACTION_REPORTED",
  COMPLIANCE_ISSUE_REPORTED: "COMPLIANCE_ISSUE_REPORTED",

  // —— consent_scope：知情决定与用途限制 ——
  CONSENT_GRANTED: "CONSENT_GRANTED",
  CONSENT_WITHDRAWN: "CONSENT_WITHDRAWN",
});

// 事件 -> 聚合归属
export const EVENT_AGGREGATE = Object.freeze({
  EPISODE_OPENED: AGGREGATES.GROWTH_EPISODE,
  RISK_ESCALATED: AGGREGATES.GROWTH_EPISODE,
  RISK_RESOLVED: AGGREGATES.GROWTH_EPISODE,
  FOLLOWUP_WINDOW_SCHEDULED: AGGREGATES.GROWTH_EPISODE,
  FOLLOWUP_COMPLETED: AGGREGATES.GROWTH_EPISODE,
  REFERRAL_ISSUED: AGGREGATES.GROWTH_EPISODE,

  CHILD_REGISTERED: AGGREGATES.CHILD_RECORD,
  GUARDIAN_LINKED: AGGREGATES.CHILD_RECORD,
  GUARDIAN_CHANGED: AGGREGATES.CHILD_RECORD,

  EVIDENCE_CAPTURED: AGGREGATES.CLINICAL_OBSERVATION,
  OBSERVATION_RECORDED: AGGREGATES.CLINICAL_OBSERVATION,
  OPINION_ISSUED: AGGREGATES.CLINICAL_OBSERVATION,

  PLAN_PROPOSED: AGGREGATES.CARE_PLAN,
  PLAN_CONFIRMED: AGGREGATES.CARE_PLAN,
  PLAN_REVISED: AGGREGATES.CARE_PLAN,
  PLAN_REASSESSED: AGGREGATES.CARE_PLAN,
  ADVERSE_REACTION_REPORTED: AGGREGATES.CARE_PLAN,
  COMPLIANCE_ISSUE_REPORTED: AGGREGATES.CARE_PLAN,

  CONSENT_GRANTED: AGGREGATES.CONSENT_SCOPE,
  CONSENT_WITHDRAWN: AGGREGATES.CONSENT_SCOPE,
});

// v1 已存在的事件：payload 为可选，保证旧事件仍可通过 schema。
// v2 新增事件必须携带 payload 与 subject_id（接入网关强校验）。
export const V1_EVENT_TYPES = Object.freeze(
  new Set(["OBSERVATION_RECORDED", "OPINION_ISSUED", "PLAN_CONFIRMED", "RISK_ESCALATED", "FOLLOWUP_COMPLETED"]),
);

// 每种事件 payload 的必填键
export const PAYLOAD_REQUIRED = Object.freeze({
  EPISODE_OPENED: ["child_id", "campus_id", "reason"],
  RISK_ESCALATED: ["child_id", "episode_id", "risk_id", "signal", "channel", "severity"],
  RISK_RESOLVED: ["child_id", "risk_id", "resolution"],
  FOLLOWUP_WINDOW_SCHEDULED: ["child_id", "episode_id", "window_id", "due_from", "due_to", "reason"],
  FOLLOWUP_COMPLETED: ["child_id", "window_ref", "completed_at", "outcome"],
  REFERRAL_ISSUED: [
    "child_id",
    "episode_id",
    "from_campus_id",
    "to_campus_id",
    "consent_ref",
    "continuity_package",
    "purpose_restrictions",
  ],

  CHILD_REGISTERED: ["child_id", "birth_year_month", "registered_campus_id"],
  GUARDIAN_LINKED: ["child_id", "guardian_id", "relationship", "legal_basis"],
  GUARDIAN_CHANGED: ["child_id", "previous_guardian_id", "new_guardian_id", "relationship", "legal_basis", "continuity_note"],

  EVIDENCE_CAPTURED: [
    "child_id",
    "episode_id",
    "evidence_id",
    "kind",
    "exam_source",
    "campus_id",
    "captured_at",
    "dentition_stage",
    "permissions",
  ],
  OBSERVATION_RECORDED: ["child_id", "episode_id", "dentition_stage", "findings", "observer_id", "campus_id"],
  OPINION_ISSUED: ["child_id", "episode_id", "opinion_id", "evidence_refs", "clinician_id", "stance", "rationale"],

  PLAN_PROPOSED: ["child_id", "episode_id", "plan_id", "proposal_id", "clinician_id", "items", "rationale", "evidence_refs"],
  PLAN_CONFIRMED: ["child_id", "plan_id", "proposal_id", "consent_ref", "window_ref", "decided_by_guardian_id"],
  PLAN_REVISED: ["child_id", "plan_id", "revision_of", "revision_proposal_id", "reason", "changes", "window_ref", "decided_by_guardian_id", "consent_ref"],
  PLAN_REASSESSED: ["child_id", "plan_id", "window_ref", "outcome", "summary"],
  ADVERSE_REACTION_REPORTED: ["child_id", "plan_id", "device_ref", "severity", "detail"],
  COMPLIANCE_ISSUE_REPORTED: ["child_id", "plan_id", "detail", "reported_by"],

  CONSENT_GRANTED: ["child_id", "guardian_id", "purposes", "granted_at"],
  CONSENT_WITHDRAWN: ["child_id", "guardian_id", "purposes", "scope", "future_use_only"],
});

// —— 稳定枚举（核心语义闭合；临床发现类型等可扩展编码不入枚举）——

export const DENTITION_STAGES = Object.freeze(["PRIMARY_DENTITION", "MIXED_DENTITION", "PERMANENT_DENTITION"]);

export const EVIDENCE_KINDS = Object.freeze([
  "FACIAL_PHOTO",
  "INTRAORAL_PHOTO",
  "PANORAMIC_XRAY",
  "CEPHALOGRAM",
  "STUDY_MODEL",
]);

export const EXAM_SOURCES = Object.freeze([
  "CAMPUS_VISIT",
  "SCHOOL_SCREENING",
  "EMERGENCY_VISIT",
  "CROSS_CAMPUS_REFERRAL",
]);

export const PURPOSES = Object.freeze(["TREATMENT", "TEACHING", "RESEARCH", "CROSS_CAMPUS_CONTINUITY"]);

// 紧急龋痛 / 常规正畸评估两条互不混同的升级路径
export const ESCALATION_CHANNELS = Object.freeze(["URGENT_DENTAL", "ROUTINE_ORTHODONTIC"]);

export const RISK_SIGNALS = Object.freeze([
  "ACUTE_DENTAL_PAIN",
  "FACIAL_SWELLING",
  "DENTAL_TRAUMA",
  "PROGRESSIVE_CARIES",
  "MOUTH_BREATHING",
  "JAW_ASYMMETRY",
  "CLASS_III_TREND",
  "CROSSBITE",
  "PERSISTENT_HABIT",
]);

// 风险信号 -> 升级通道（急症通道信号禁止走常规队列）
export const SIGNAL_CHANNEL = Object.freeze({
  ACUTE_DENTAL_PAIN: "URGENT_DENTAL",
  FACIAL_SWELLING: "URGENT_DENTAL",
  DENTAL_TRAUMA: "URGENT_DENTAL",
  PROGRESSIVE_CARIES: "ROUTINE_ORTHODONTIC",
  MOUTH_BREATHING: "ROUTINE_ORTHODONTIC",
  JAW_ASYMMETRY: "ROUTINE_ORTHODONTIC",
  CLASS_III_TREND: "ROUTINE_ORTHODONTIC",
  CROSSBITE: "ROUTINE_ORTHODONTIC",
  PERSISTENT_HABIT: "ROUTINE_ORTHODONTIC",
});

export const OPINION_STANCES = Object.freeze(["OBSERVE", "INVESTIGATE", "INTERVENE", "URGENT_CARE", "REFER"]);

export const PLAN_ITEM_TYPES = Object.freeze([
  "OBSERVE",
  "HABIT_INTERCEPTION",
  "SPACE_MAINTAINER",
  "REMOVABLE_APPLIANCE",
  "FUNCTIONAL_APPLIANCE",
  "FIXED_APPLIANCE",
  "CARIES_TREATMENT",
]);

export const REVISION_REASONS = Object.freeze([
  "GROWTH_CHANGE",
  "NEW_EVIDENCE",
  "COMPLIANCE_DIFFICULTY",
  "ADVERSE_REACTION",
  "GUARDIAN_REQUEST",
]);

export const REASSESSMENT_OUTCOMES = Object.freeze(["CONTINUE", "REVISE", "PAUSE", "COMPLETE"]);

export const FOLLOWUP_REASONS = Object.freeze([
  "OBSERVATION",
  "ROUTINE_ASSESSMENT",
  "CARIES_SURVEILLANCE",
  "POST_DEVICE_FIT",
  "ADVERSE_REACTION_MONITOR",
  "COMPLIANCE_SUPPORT",
]);

export const FOLLOWUP_OUTCOMES = Object.freeze(["KEPT", "LATE", "RESCHEDULED", "CANCELLED"]);

// 临床发现类别：只做归类，不承载自动诊断
export const FINDING_CATEGORIES = Object.freeze([
  "CARIES",
  "ORAL_HABIT",
  "MOUTH_BREATHING",
  "OCCLUSAL",
  "SKELETAL",
  "DENTAL_DEVELOPMENT",
]);
