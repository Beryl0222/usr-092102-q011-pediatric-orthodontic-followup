// 应用层：把领域动作翻译成事件并写入 EventStore。
// 统一负责 aggregate_id 归属与 version 递增；业务不变量仍由 store 把关。
//
// 本层不做任何“按年龄出治疗”的判断：治疗类动作必须由调用方（医生/监护人决定）
// 显式给出证据、意见与知情同意。
import { EventStore } from "./store.js";

let seq = 0;
function newId(prefix) {
  seq += 1;
  return `${prefix}-${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}-${seq}`;
}

export class FollowupService {
  constructor(store = new EventStore(), clock = () => new Date().toISOString()) {
    this.store = store;
    this.clock = clock;
  }

  #aggId(kind, ref) {
    return {
      child: `child:${ref}`,
      episode: ref,
      clinical: `clinical:${ref}`,
      plan: `plan:${ref}`,
      consent: `consent:${ref}`,
    }[kind];
  }

  #append(kind, ref, eventType, payload, opts = {}) {
    const aggregateId = this.#aggId(kind, ref);
    const version = this.store.events().filter((e) => e.aggregate_id === aggregateId).length + 1;
    const event = {
      event_id: opts.event_id ?? newId("evt"),
      event_type: eventType,
      aggregate_type: {
        child: "child_record",
        episode: "growth_episode",
        clinical: "clinical_observation",
        plan: "care_plan",
        consent: "consent_scope",
      }[kind],
      aggregate_id: aggregateId,
      subject_id: payload?.child_id,
      occurred_at: opts.occurred_at ?? this.clock(),
      version,
      summary: opts.summary ?? eventType,
      ...(payload ? { payload } : {}),
    };
    this.store.append(event);
    return event;
  }

  // —— 身份与监护 ——
  registerChild({ child_id, birth_year_month, registered_campus_id }, opts) {
    return this.#append("child", child_id, "CHILD_REGISTERED", { child_id, birth_year_month, registered_campus_id }, opts);
  }

  linkGuardian(p, opts) {
    return this.#append("child", p.child_id, "GUARDIAN_LINKED", p, opts);
  }

  changeGuardian(p, opts) {
    return this.#append("child", p.child_id, "GUARDIAN_CHANGED", p, opts);
  }

  // —— 随访主线 ——
  openEpisode({ episode_id, child_id, campus_id, reason }, opts) {
    return this.#append("episode", episode_id, "EPISODE_OPENED", { child_id, campus_id, reason }, opts);
  }

  escalateRisk(p, opts) {
    return this.#append("episode", p.episode_id, "RISK_ESCALATED", p, opts);
  }

  resolveRisk(p, opts) {
    return this.#append("episode", p.episode_id, "RISK_RESOLVED", p, opts);
  }

  scheduleWindow(p, opts) {
    return this.#append("episode", p.episode_id, "FOLLOWUP_WINDOW_SCHEDULED", p, opts);
  }

  completeFollowup(p, opts) {
    return this.#append("episode", p.episode_id, "FOLLOWUP_COMPLETED", p, opts);
  }

  issueReferral(p, opts) {
    return this.#append("episode", p.episode_id, "REFERRAL_ISSUED", p, opts);
  }

  // —— 检查与证据 ——
  captureEvidence(p, opts) {
    return this.#append("clinical", p.episode_id, "EVIDENCE_CAPTURED", p, opts);
  }

  recordObservation(p, opts) {
    return this.#append("clinical", p.episode_id, "OBSERVATION_RECORDED", p, opts);
  }

  issueOpinion(p, opts) {
    return this.#append("clinical", p.episode_id, "OPINION_ISSUED", p, opts);
  }

  // —— 知情决定 ——
  grantConsent(p, opts) {
    return this.#append("consent", p.child_id, "CONSENT_GRANTED", p, opts);
  }

  withdrawConsent(p, opts) {
    return this.#append("consent", p.child_id, "CONSENT_WITHDRAWN", p, opts);
  }

  // —— 方案 ——
  proposePlan(p, opts) {
    return this.#append("plan", p.plan_id, "PLAN_PROPOSED", p, opts);
  }

  confirmPlan(p, opts) {
    return this.#append("plan", p.plan_id, "PLAN_CONFIRMED", p, opts);
  }

  revisePlan(p, opts) {
    return this.#append("plan", p.plan_id, "PLAN_REVISED", p, opts);
  }

  reassessPlan(p, opts) {
    return this.#append("plan", p.plan_id, "PLAN_REASSESSED", p, opts);
  }

  reportAdverseReaction(p, opts) {
    return this.#append("plan", p.plan_id, "ADVERSE_REACTION_REPORTED", p, opts);
  }

  reportComplianceIssue(p, opts) {
    return this.#append("plan", p.plan_id, "COMPLIANCE_ISSUE_REPORTED", p, opts);
  }
}
