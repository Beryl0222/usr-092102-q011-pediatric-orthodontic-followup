// 单事件结构校验：信封字段 + 目录枚举 + payload 必填键。
// 跨事件不变量（引用完整性、授权、版本流）见 store.js。
import {
  DENTITION_STAGES,
  ESCALATION_CHANNELS,
  EVENT_AGGREGATE,
  EVIDENCE_KINDS,
  EXAM_SOURCES,
  FOLLOWUP_REASONS,
  OPINION_STANCES,
  PAYLOAD_REQUIRED,
  PLAN_ITEM_TYPES,
  PURPOSES,
  REASSESSMENT_OUTCOMES,
  REVISION_REASONS,
  RISK_SIGNALS,
  SIGNAL_CHANNEL,
  V1_EVENT_TYPES,
} from "./catalog.js";

const envelopeRequired = [
  "event_id",
  "event_type",
  "aggregate_type",
  "aggregate_id",
  "occurred_at",
  "version",
  "summary",
];

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})$/;
const YEAR_MONTH = /^\d{4}-\d{2}$/;
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

function checkEnum(value, allowed, label, errors) {
  if (!allowed.includes(value)) errors.push(`${label} 必须是 ${allowed.join(" / ")} 之一，收到：${String(value)}`);
}

function checkPurposes(purposes, errors, label) {
  if (!Array.isArray(purposes) || purposes.length === 0) {
    errors.push(`${label} 必须是非空数组`);
    return;
  }
  if (new Set(purposes).size !== purposes.length) errors.push(`${label} 不得重复`);
  for (const p of purposes) checkEnum(p, PURPOSES, label);
}

// 校验单个事件记录，返回中文错误信息数组；[] 表示通过。
// v1 五类事件允许没有 subject_id / payload（向后兼容）。
export function validateEvent(record) {
  const errors = [];
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return ["事件必须是对象"];
  }

  for (const name of envelopeRequired) {
    if (!(name in record)) errors.push(`缺少字段：${name}`);
  }
  if (errors.length) return errors; // 信封不全就不继续，避免噪声

  if (typeof record.event_id !== "string" || !record.event_id) errors.push("event_id 必须是非空字符串");
  if (typeof record.aggregate_id !== "string" || !record.aggregate_id) errors.push("aggregate_id 必须是非空字符串");
  if (typeof record.summary !== "string" || !record.summary.trim()) errors.push("summary 必须是非空字符串");
  if (!Number.isInteger(record.version) || record.version < 1) errors.push("version 必须是正整数");
  if (typeof record.occurred_at !== "string" || !DATE_TIME.test(record.occurred_at)) {
    errors.push("occurred_at 必须是 RFC3339 日期时间");
  }

  const type = record.event_type;
  const knownTypes = Object.keys(PAYLOAD_REQUIRED);
  if (!knownTypes.includes(type)) {
    errors.push(`未知 event_type：${String(type)}`);
    return errors;
  }

  const isV1 = V1_EVENT_TYPES.has(type);
  const hasPayload = "payload" in record;

  // 仅对携带 payload 的事件强制“事件类型 -> 聚合”配对。
  // v1 无 payload 的遗留事件只约束信封，保留其历史 aggregate_type 取值自由。
  if (hasPayload && record.aggregate_type !== EVENT_AGGREGATE[type]) {
    errors.push(`${type} 的 aggregate_type 必须是 ${EVENT_AGGREGATE[type]}，收到：${record.aggregate_type}`);
  }

  if (!isV1 && !hasPayload) errors.push(`${type} 必须携带 payload`);
  if (hasPayload) {
    if (record.payload === null || typeof record.payload !== "object" || Array.isArray(record.payload)) {
      errors.push("payload 必须是对象");
    } else {
      validatePayload(type, record.payload, errors);
    }
    // 任何携带 payload 的事件都必须可归属到具体儿童
    if (typeof record.subject_id !== "string" || !record.subject_id) {
      errors.push("携带 payload 的事件必须填写 subject_id");
    } else if (record.payload?.child_id && record.subject_id !== record.payload.child_id) {
      errors.push("subject_id 必须与 payload.child_id 一致");
    }
  }

  return errors;
}

function validatePayload(type, p, errors) {
  for (const key of PAYLOAD_REQUIRED[type]) {
    if (!(key in p) || p[key] === undefined || p[key] === null || p[key] === "") {
      errors.push(`${type}.payload 缺少必填键：${key}`);
    }
  }

  if (p.child_id !== undefined && (typeof p.child_id !== "string" || !p.child_id)) {
    errors.push("payload.child_id 必须是非空字符串");
  }
  if (p.dentition_stage !== undefined) checkEnum(p.dentition_stage, DENTITION_STAGES, "dentition_stage", errors);
  if (p.kind !== undefined) checkEnum(p.kind, EVIDENCE_KINDS, "kind", errors);
  if (p.exam_source !== undefined) checkEnum(p.exam_source, EXAM_SOURCES, "exam_source", errors);
  if (p.stance !== undefined) checkEnum(p.stance, OPINION_STANCES, "stance", errors);
  if (p.severity !== undefined) checkEnum(p.severity, ["LOW", "MODERATE", "HIGH", "URGENT"], "severity", errors);
  if (p.reason !== undefined && type === "FOLLOWUP_WINDOW_SCHEDULED") {
    checkEnum(p.reason, FOLLOWUP_REASONS, "reason", errors);
  }
  if (p.outcome !== undefined && type === "PLAN_REASSESSED") {
    checkEnum(p.outcome, REASSESSMENT_OUTCOMES, "outcome", errors);
  }

  if (p.birth_year_month !== undefined && !YEAR_MONTH.test(p.birth_year_month)) {
    errors.push("birth_year_month 格式必须是 YYYY-MM");
  }

  if (type === "RISK_ESCALATED") {
    checkEnum(p.signal, RISK_SIGNALS, "signal", errors);
    checkEnum(p.channel, ESCALATION_CHANNELS, "channel", errors);
    if (RISK_SIGNALS.includes(p.signal) && SIGNAL_CHANNEL[p.signal] !== p.channel) {
      errors.push(`信号 ${p.signal} 必须走 ${SIGNAL_CHANNEL[p.signal]} 通道，不能走 ${p.channel}`);
    }
    if (p.channel === "URGENT_DENTAL" && !["HIGH", "URGENT"].includes(p.severity)) {
      errors.push("URGENT_DENTAL 通道的 severity 必须是 HIGH 或 URGENT");
    }
  }

  if (type === "FOLLOWUP_WINDOW_SCHEDULED") {
    for (const key of ["due_from", "due_to"]) {
      if (typeof p[key] === "string" && !CALENDAR_DATE.test(p[key])) {
        errors.push(`${key} 格式必须是 YYYY-MM-DD`);
      }
    }
    if (CALENDAR_DATE.test(p.due_from) && CALENDAR_DATE.test(p.due_to) && p.due_from > p.due_to) {
      errors.push("due_from 不得晚于 due_to");
    }
  }

  if (type === "EVIDENCE_CAPTURED") {
    if (p.permissions === null || typeof p.permissions !== "object") {
      errors.push("permissions 必须是对象");
    } else {
      if (p.permissions.TREATMENT !== true) {
        errors.push("证据的 TREATMENT（诊疗）用途必须为 true：临床连续性用途不可关闭");
      }
      for (const key of Object.keys(p.permissions)) {
        if (!PURPOSES.includes(key)) errors.push(`permissions 含未知用途：${key}`);
        if (typeof p.permissions[key] !== "boolean") errors.push(`permissions.${key} 必须是布尔值`);
      }
    }
    if (p.captured_at !== undefined && !DATE_TIME.test(p.captured_at)) {
      errors.push("captured_at 必须是 RFC3339 日期时间");
    }
  }

  if (type === "CONSENT_GRANTED") {
    checkPurposes(p.purposes, errors, "purposes");
    if (p.granted_at !== undefined && !DATE_TIME.test(p.granted_at)) errors.push("granted_at 必须是 RFC3339 日期时间");
  }
  if (type === "CONSENT_WITHDRAWN") {
    checkPurposes(p.purposes, errors, "purposes");
    if (Array.isArray(p.purposes) && p.purposes.includes("TREATMENT")) {
      errors.push("不得撤回 TREATMENT（诊疗）用途：拒绝或终止治疗应通过方案决定表达，临床连续性不受用途撤回影响");
    }
    if (p.future_use_only !== true) {
      errors.push("用途撤回必须声明 future_use_only=true：撤回只影响未来使用，不追溯改写已发生的诊疗记录");
    }
    if (p.scope === null || typeof p.scope !== "object" || Object.keys(p.scope).length === 0) {
      errors.push("撤回必须给出 scope（evidence_ids 或 all_capture_sources）");
    } else {
      if (p.scope.evidence_ids !== undefined && !Array.isArray(p.scope.evidence_ids)) {
        errors.push("scope.evidence_ids 必须是数组");
      }
      if (p.scope.all_capture_sources !== undefined && !Array.isArray(p.scope.all_capture_sources)) {
        errors.push("scope.all_capture_sources 必须是数组");
      }
    }
  }

  if (type === "OPINION_ISSUED") {
    if (!Array.isArray(p.evidence_refs)) errors.push("evidence_refs 必须是数组");
    else if (p.evidence_refs.length === 0) errors.push("OPINION_ISSUED 必须基于至少一条证据");
    else if (new Set(p.evidence_refs).size !== p.evidence_refs.length) errors.push("evidence_refs 不得重复");
  }

  if (type === "PLAN_PROPOSED") {
    if (!Array.isArray(p.items) || p.items.length === 0) {
      errors.push("方案 items 必须是非空数组（观察也是一项明确方案）");
    } else {
      for (const [i, item] of p.items.entries()) {
        if (item === null || typeof item !== "object") {
          errors.push(`items[${i}] 必须是对象`);
          continue;
        }
        if (typeof item.item_id !== "string" || !item.item_id) {
          errors.push(`items[${i}].item_id 必须是非空字符串（修订与不良反应按 item_id 定位）`);
        }
        checkEnum(item.type, PLAN_ITEM_TYPES, `items[${i}].type`, errors);
      }
      const ids = (p.items ?? []).map((it) => it?.item_id).filter(Boolean);
      if (new Set(ids).size !== ids.length) errors.push("同一方案内 item_id 不得重复");
    }
    if (!Array.isArray(p.evidence_refs) || p.evidence_refs.length === 0) {
      errors.push("方案必须引用证据 evidence_refs；系统不接受无证据、仅凭年龄的方案");
    }
  }

  if (type === "PLAN_REVISED") {
    checkEnum(p.reason, REVISION_REASONS, "reason", errors);
    const c = p.changes;
    if (c === null || typeof c !== "object" || !Array.isArray(c.add) || !Array.isArray(c.remove) || !Array.isArray(c.adjust)) {
      errors.push("changes 必须包含 add / remove / adjust 三个数组");
    } else {
      for (const [i, item] of c.add.entries()) {
        if (item === null || typeof item !== "object" || typeof item.item_id !== "string" || !item.item_id) {
          errors.push(`changes.add[${i}] 必须是带 item_id 的条目对象`);
        } else {
          checkEnum(item.type, PLAN_ITEM_TYPES, `changes.add[${i}].type`, errors);
        }
      }
      for (const [i, ref] of c.remove.entries()) {
        if (typeof ref !== "string" || !ref) errors.push(`changes.remove[${i}] 必须是 item_id 字符串`);
      }
      for (const [i, adj] of c.adjust.entries()) {
        if (adj === null || typeof adj !== "object" || typeof adj.item_id !== "string" || !adj.item_id) {
          errors.push(`changes.adjust[${i}] 必须带 item_id`);
        }
      }
    }
  }

  if (type === "REFERRAL_ISSUED") {
    if (!Array.isArray(p.continuity_package)) errors.push("continuity_package 必须是数组");
    else if (p.continuity_package.length === 0) errors.push("转诊 continuity_package 不能为空");
    checkPurposes(p.purpose_restrictions, errors, "purpose_restrictions");
  }
}
