// 儿童正畸生长随访 —— 稳定领域词汇
// 说明：contracts/domain.schema.json 已固定事件类型与聚合类型枚举，
// 业务细分含义统一放在事件 payload.kind 中，不得新增信封枚举值。

export const EVENT_TYPE = Object.freeze({
  OBSERVATION_RECORDED: "OBSERVATION_RECORDED",
  OPINION_ISSUED: "OPINION_ISSUED",
  PLAN_CONFIRMED: "PLAN_CONFIRMED",
  RISK_ESCALATED: "RISK_ESCALATED",
  FOLLOWUP_COMPLETED: "FOLLOWUP_COMPLETED",
});

export const AGGREGATE = Object.freeze({
  GROWTH_EPISODE: "growth_episode",
  CLINICAL_OBSERVATION: "clinical_observation",
  CARE_PLAN: "care_plan",
  CONSENT_SCOPE: "consent_scope",
});

// payload.kind 与信封枚举的映射是稳定约定，见 docs/domain-model.md
export const KIND = Object.freeze({
  EPISODE_OPENED: "EPISODE_OPENED",
  GUARDIAN_CHANGED: "GUARDIAN_CHANGED",
  EXAM_RECORDED: "EXAM_RECORDED",
  IMAGE_CAPTURED: "IMAGE_CAPTURED",
  FINDING_RECORDED: "FINDING_RECORDED",
  OPINION_ISSUED: "OPINION_ISSUED",
  RISK_ESCALATED: "RISK_ESCALATED",
  PLAN_CONFIRMED: "PLAN_CONFIRMED",
  CONSENT_GRANTED: "CONSENT_GRANTED",
  CONSENT_WITHDRAWN: "CONSENT_WITHDRAWN",
  REFERRAL_TRANSFERRED: "REFERRAL_TRANSFERRED",
  VISIT_COMPLETED: "VISIT_COMPLETED",
});

// 牙列阶段：仅记录事实，系统不据此自动给治疗建议
export const DENTITION_STAGE = Object.freeze({
  PRIMARY: "PRIMARY_DENTITION", // 乳牙列
  MIXED: "MIXED_DENTITION", // 混合牙列
  PERMANENT: "PERMANENT_DENTITION", // 恒牙列
});

// 龋病检查结论（牙位级）
export const CARIES_STATUS = Object.freeze({
  SOUND: "SOUND",
  WHITE_LESION: "WHITE_LESION", // 早期白垩斑
  CARIES_DENTIN: "CARIES_DENTIN", // 龋坏达牙本质
  SEVERE_PAIN: "SEVERE_PAIN", // 急性牙痛
  SWELLING: "SWELLING", // 肿胀
  FILLED: "FILLED", // 已充填
});

// 不良习惯
export const HABIT = Object.freeze({
  MOUTH_BREATHING: "MOUTH_BREATHING", // 口呼吸
  FINGER_SUCKING: "FINGER_SUCKING",
  TONGUE_THRUST: "TONGUE_THRUST",
  LIP_BITING: "LIP_BITING",
  NAIL_BITING: "NAIL_BITING",
});

// 风险信号 → 升级路径。系统强制两条路径分离：
// 急性牙痛等走紧急齿科处置（限 24 小时内响应），常规正畸问题进入下一复诊窗口。
export const RISK_PATH = Object.freeze({
  URGENT_DENTAL: "URGENT_DENTAL",
  ROUTINE_ORTHO: "ROUTINE_ORTHO",
});

export const URGENT_SLA_HOURS = 24;

export const RISK_CODE = Object.freeze({
  SPONTANEOUS_TOOTHACHE: { code: "SPONTANEOUS_TOOTHACHE", path: RISK_PATH.URGENT_DENTAL, label: "自发性牙痛" },
  NOCTURNAL_PAIN: { code: "NOCTURNAL_PAIN", path: RISK_PATH.URGENT_DENTAL, label: "夜间痛" },
  FACIAL_SWELLING: { code: "FACIAL_SWELLING", path: RISK_PATH.URGENT_DENTAL, label: "面部肿胀" },
  DENTAL_TRAUMA: { code: "DENTAL_TRAUMA", path: RISK_PATH.URGENT_DENTAL, label: "牙外伤" },
  CARIES_PROGRESSION: { code: "CARIES_PROGRESSION", path: RISK_PATH.ROUTINE_ORTHO, label: "龋病进展" },
  PERSISTENT_MOUTH_BREATHING: { code: "PERSISTENT_MOUTH_BREATHING", path: RISK_PATH.ROUTINE_ORTHO, label: "持续口呼吸" },
  HABIT_PERSISTENCE: { code: "HABIT_PERSISTENCE", path: RISK_PATH.ROUTINE_ORTHO, label: "不良习惯持续" },
  GROWTH_ASYMMETRY: { code: "GROWTH_ASYMMETRY", path: RISK_PATH.ROUTINE_ORTHO, label: "颌面生长不对称" },
  CROSSBITE_TREND: { code: "CROSSBITE_TREND", path: RISK_PATH.ROUTINE_ORTHO, label: "反𬌗趋势" },
  SPACE_LOSS: { code: "SPACE_LOSS", path: RISK_PATH.ROUTINE_ORTHO, label: "间隙丧失" },
});

// 医生决定：治疗 / 观察 / 转诊。观察必须写明理由与复诊窗口
export const DECISION = Object.freeze({
  TREAT: "TREAT",
  OBSERVE: "OBSERVE",
  REFER: "REFER",
});

// 方案修订触发原因：修订只能追加，不能覆盖原判断
export const REVISION_TRIGGER = Object.freeze({
  DEVELOPMENT_CHANGE: "DEVELOPMENT_CHANGE", // 后续发育变化
  COMPLIANCE_DIFFICULTY: "COMPLIANCE_DIFFICULTY", // 依从困难
  APPLIANCE_REACTION: "APPLIANCE_REACTION", // 器械不良反应
});

// 资料用途与授权范围
export const PURPOSE = Object.freeze({
  TREATMENT: "TREATMENT", // 诊疗
  TEACHING: "TEACHING", // 教学
  RESEARCH: "RESEARCH", // 研究
});

export const CONSENT_SCOPE = Object.freeze({
  PHOTO: "PHOTO", // 面颌/口内照片与影像
  CLINICAL_RECORD: "CLINICAL_RECORD", // 病历记录
});

export const PURPOSE_LABEL = Object.freeze({
  TREATMENT: "诊疗",
  TEACHING: "教学",
  RESEARCH: "研究",
});
