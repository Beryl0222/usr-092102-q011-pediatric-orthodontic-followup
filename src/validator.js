// 契约信封基础校验：对应 contracts/domain.schema.json 的硬约束。
// 只校验契约字段，不约束 payload（契约允许 additionalProperties）。
// 业务细分校验见 domain/events.js 的 checkEnvelope。

const required = [
  "event_id",
  "event_type",
  "aggregate_type",
  "aggregate_id",
  "occurred_at",
  "version",
  "summary",
];

const eventTypes = new Set([
  "OBSERVATION_RECORDED",
  "OPINION_ISSUED",
  "PLAN_CONFIRMED",
  "RISK_ESCALATED",
  "FOLLOWUP_COMPLETED",
]);

const aggregateTypes = new Set([
  "growth_episode",
  "clinical_observation",
  "care_plan",
  "consent_scope",
]);

export function validateEvent(record) {
  const errors = required
    .filter((name) => !(name in record))
    .map((name) => `缺少字段：${name}`);

  if (record && typeof record === "object") {
    if ("version" in record && (!Number.isInteger(record.version) || record.version < 1))
      errors.push("version 必须是正整数");
    if ("event_type" in record && !eventTypes.has(record.event_type))
      errors.push(`event_type 不在契约枚举内：${record.event_type}`);
    if ("aggregate_type" in record && !aggregateTypes.has(record.aggregate_type))
      errors.push(`aggregate_type 不在契约枚举内：${record.aggregate_type}`);
    if ("event_id" in record && (typeof record.event_id !== "string" || record.event_id.length === 0))
      errors.push("event_id 必须是非空字符串");
    if ("aggregate_id" in record && (typeof record.aggregate_id !== "string" || record.aggregate_id.length === 0))
      errors.push("aggregate_id 必须是非空字符串");
    if ("summary" in record && (typeof record.summary !== "string" || record.summary.length === 0))
      errors.push("summary 必须是非空字符串");
    if ("occurred_at" in record && Number.isNaN(Date.parse(record.occurred_at)))
      errors.push("occurred_at 必须是合法时间");
  }
  return errors;
}
