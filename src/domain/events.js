// 事件信封工厂：所有业务事件都必须符合 contracts/domain.schema.json。
// 契约只约束信封字段且 additionalProperties=true，业务细节统一放进 payload。
// payload.kind 是本服务对信封 event_type 的稳定细分（见 docs/domain-model.md）。

import { AGGREGATE, EVENT_TYPE, KIND } from "./codes.js";

// 信封 event_type → 允许的 payload.kind
const KIND_BY_EVENT_TYPE = Object.freeze({
  [EVENT_TYPE.OBSERVATION_RECORDED]: [
    KIND.EPISODE_OPENED,
    KIND.GUARDIAN_CHANGED,
    KIND.EXAM_RECORDED,
    KIND.IMAGE_CAPTURED,
    KIND.FINDING_RECORDED,
    KIND.CONSENT_GRANTED,
    KIND.CONSENT_WITHDRAWN,
  ],
  [EVENT_TYPE.OPINION_ISSUED]: [KIND.OPINION_ISSUED],
  [EVENT_TYPE.PLAN_CONFIRMED]: [KIND.PLAN_CONFIRMED],
  [EVENT_TYPE.RISK_ESCALATED]: [KIND.RISK_ESCALATED],
  [EVENT_TYPE.FOLLOWUP_COMPLETED]: [
    KIND.VISIT_COMPLETED,
    KIND.REFERRAL_TRANSFERRED,
  ],
});

// 信封 aggregate_type → 允许的 payload.kind
const KIND_BY_AGGREGATE = Object.freeze({
  [AGGREGATE.GROWTH_EPISODE]: [
    KIND.EPISODE_OPENED,
    KIND.GUARDIAN_CHANGED,
    KIND.EXAM_RECORDED, // episode 上仅作检查索引，检查事实本体在 clinical_observation 聚合
    KIND.REFERRAL_TRANSFERRED,
    KIND.VISIT_COMPLETED,
  ],
  [AGGREGATE.CLINICAL_OBSERVATION]: [
    KIND.EXAM_RECORDED,
    KIND.IMAGE_CAPTURED,
    KIND.FINDING_RECORDED,
    KIND.OPINION_ISSUED,
    KIND.RISK_ESCALATED,
  ],
  [AGGREGATE.CARE_PLAN]: [KIND.PLAN_CONFIRMED],
  [AGGREGATE.CONSENT_SCOPE]: [KIND.CONSENT_GRANTED, KIND.CONSENT_WITHDRAWN],
});

let counter = 0;

function nextId(prefix) {
  counter = (counter + 1) % 1e6;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}

/**
 * 构造一条领域事件（不做持久化）。
 * @param {object} input
 * @param {string} input.event_type   契约信封枚举
 * @param {string} input.aggregate_type 契约聚合枚举
 * @param {string} input.aggregate_id
 * @param {string} input.payload_kind  payload.kind（本服务细分）
 * @param {object} input.payload      业务字段
 * @param {string} [input.occurred_at] ISO 时间，默认当前时间
 * @param {string} [input.event_id]
 * @param {object} [input.metadata]    院区、操作者等来源信息
 */
export function makeEvent({
  event_type,
  aggregate_type,
  aggregate_id,
  payload_kind,
  payload = {},
  occurred_at = new Date().toISOString(),
  event_id,
  metadata = {},
}) {
  return {
    event_id: event_id ?? nextId("evt"),
    event_type,
    aggregate_type,
    aggregate_id,
    occurred_at,
    version: 0, // 由 eventStore 按聚合追加时赋正整数版本
    summary: payload.summary ?? defaultSummary(payload_kind),
    payload: { ...payload, kind: payload_kind },
    metadata,
  };
}

function defaultSummary(kind) {
  return `儿童正畸生长随访事件：${kind}`;
}

/** 结构级校验：信封符合契约，且 kind 与 event_type / aggregate_type 匹配 */
export function checkEnvelope(event) {
  const errors = [];
  const envelopeTypes = new Set(Object.values(EVENT_TYPE));
  const aggregateTypes = new Set(Object.values(AGGREGATE));

  if (!event || typeof event !== "object") return ["事件必须是对象"];
  if (!envelopeTypes.has(event.event_type)) errors.push(`非法 event_type：${event.event_type}`);
  if (!aggregateTypes.has(event.aggregate_type)) errors.push(`非法 aggregate_type：${event.aggregate_type}`);
  if (typeof event.aggregate_id !== "string" || event.aggregate_id.length === 0)
    errors.push("aggregate_id 不能为空");
  if (typeof event.event_id !== "string" || event.event_id.length === 0) errors.push("event_id 不能为空");
  if (Number.isNaN(Date.parse(event.occurred_at))) errors.push("occurred_at 必须是合法时间");
  if (!Number.isInteger(event.version) || event.version < 1)
    errors.push("version 必须由存储赋正整数（当前事件尚未入存储）");
  if (typeof event.summary !== "string" || event.summary.length === 0) errors.push("summary 不能为空");

  const kind = event.payload?.kind;
  const allKinds = Object.values(KIND);
  if (!allKinds.includes(kind)) {
    errors.push(`非法 payload.kind：${kind}`);
    return errors;
  }
  if (!KIND_BY_EVENT_TYPE[event.event_type]?.includes(kind))
    errors.push(`payload.kind ${kind} 不能挂在 event_type ${event.event_type} 下`);
  if (!KIND_BY_AGGREGATE[event.aggregate_type]?.includes(kind))
    errors.push(`payload.kind ${kind} 不能挂在 aggregate_type ${event.aggregate_type} 下`);
  return errors;
}

export { KIND_BY_EVENT_TYPE, KIND_BY_AGGREGATE };
