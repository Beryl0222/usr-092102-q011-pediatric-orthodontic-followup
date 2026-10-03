import assert from "node:assert/strict";
import test from "node:test";

import { FollowupService } from "../src/application.js";
import { DomainValidationError, EventStore } from "../src/store.js";
import { validateEvent } from "../src/validator.js";

const T0 = "2026-09-01T09:00:00+08:00";
const T1 = "2026-09-01T09:30:00+08:00";

// 搭好一条最小且合法的“观察方案已确认”主线，各用例在其上分叉。
function seed() {
  const svc = new FollowupService(undefined, () => T1);
  const ids = { child: "C1", episode: "EP1", guardian: "G1", evidence: "EV1", plan: "PL1", proposal: "PR1", window: "W1", consent: "CS1" };
  svc.registerChild({ child_id: ids.child, birth_year_month: "2022-03", registered_campus_id: "east" }, { occurred_at: T0 });
  svc.linkGuardian({ child_id: ids.child, guardian_id: ids.guardian, relationship: "PARENT", legal_basis: "户口" }, { occurred_at: T0 });
  svc.openEpisode({ episode_id: ids.episode, child_id: ids.child, campus_id: "east", reason: "咨询" }, { occurred_at: T0, event_id: "e-episode" });
  svc.grantConsent({ child_id: ids.child, guardian_id: ids.guardian, purposes: ["TREATMENT", "TEACHING", "RESEARCH", "CROSS_CAMPUS_CONTINUITY"], granted_at: T1 }, { event_id: ids.consent });
  svc.captureEvidence({ child_id: ids.child, episode_id: ids.episode, evidence_id: ids.evidence, kind: "INTRAORAL_PHOTO", exam_source: "CAMPUS_VISIT", campus_id: "east", captured_at: T1, dentition_stage: "PRIMARY_DENTITION", permissions: { TREATMENT: true, TEACHING: true, RESEARCH: true, CROSS_CAMPUS_CONTINUITY: true } });
  svc.issueOpinion({ child_id: ids.child, episode_id: ids.episode, opinion_id: "OP1", evidence_refs: [ids.evidence], clinician_id: "D1", stance: "OBSERVE", rationale: "观察" });
  svc.proposePlan({ child_id: ids.child, episode_id: ids.episode, plan_id: ids.plan, proposal_id: ids.proposal, clinician_id: "D1", items: [{ item_id: "IT1", type: "OBSERVE", note: "3 个月复诊" }], rationale: "无骨性异常", evidence_refs: [ids.evidence] });
  svc.scheduleWindow({ child_id: ids.child, episode_id: ids.episode, window_id: ids.window, due_from: "2026-12-01", due_to: "2026-12-15", reason: "OBSERVATION" });
  svc.confirmPlan({ child_id: ids.child, plan_id: ids.plan, proposal_id: ids.proposal, consent_ref: ids.consent, window_ref: ids.window, decided_by_guardian_id: ids.guardian });
  return { svc, ids };
}

function reject(fn, match) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof DomainValidationError, `期望 DomainValidationError，收到 ${err}`);
    if (match) {
      const text = err.errors.join("；");
      assert.ok(match.test(text), `错误信息不匹配 ${match}，实际：${text}`);
    }
    return true;
  });
}

// —— 结构与版本 ——

test("拒绝：未知事件类型 / 错误聚合归属", () => {
  assert.ok(validateEvent({ event_type: "NOPE" }).length > 0);
  seed(); // 合法基线
  const raw = {
    event_id: "x1", event_type: "CHILD_REGISTERED", aggregate_type: "care_plan",
    aggregate_id: "child:C1", subject_id: "C1", occurred_at: T0, version: 1,
    summary: "x", payload: { child_id: "C1", birth_year_month: "2022-03", registered_campus_id: "east" },
  };
  assert.deepEqual(validateEvent(raw).filter((m) => m.includes("aggregate_type")), ["CHILD_REGISTERED 的 aggregate_type 必须是 child_record，收到：care_plan"]);
});

test("拒绝：version 跳跃与 event_id 重复", () => {
  const store = new EventStore();
  const base = {
    event_type: "CHILD_REGISTERED", aggregate_type: "child_record", aggregate_id: "child:C9",
    subject_id: "C9", occurred_at: T0, summary: "x",
    payload: { child_id: "C9", birth_year_month: "2022-03", registered_campus_id: "east" },
  };
  reject(() => store.append({ ...base, event_id: "A", version: 2 }), /version 必须连续/);
  store.append({ ...base, event_id: "A", version: 1 });
  reject(() => store.append({ ...base, event_id: "A", version: 2, occurred_at: T1 }), /event_id 重复/);
});

test("拒绝：subject_id 与 payload.child_id 不一致", () => {
  const { svc } = seed();
  const raw = svc.store.events()[0];
  const store2 = new EventStore();
  reject(() => store2.append({ ...raw, event_id: "dup", subject_id: "OTHER", version: 1 }), /subject_id 必须与 payload.child_id/);
});

test("拒绝：同聚合时间倒流（历史只能追加）", () => {
  const store = new EventStore();
  const mk = (id, at, v) => ({
    event_id: id, event_type: "CHILD_REGISTERED", aggregate_type: "child_record", aggregate_id: "child:C8",
    subject_id: "C8", occurred_at: at, version: v, summary: "x",
    payload: { child_id: "C8", birth_year_month: "2022-03", registered_campus_id: "east" },
  });
  store.append(mk("k1", T1, 1));
  reject(() => store.append({ ...mk("k2", T0, 2) }), /不得早于上一事件/);
});

// —— 双升级路径 ——

test("拒绝：急性牙痛走常规通道 / 口呼吸走急诊通道", () => {
  const { svc, ids } = seed();
  reject(() => svc.escalateRisk({ child_id: ids.child, episode_id: ids.episode, risk_id: "RA", signal: "ACUTE_DENTAL_PAIN", channel: "ROUTINE_ORTHODONTIC", severity: "URGENT" }, { occurred_at: "2026-12-01T10:00:00+08:00" }), /URGENT_DENTAL/);
  reject(() => svc.escalateRisk({ child_id: ids.child, episode_id: ids.episode, risk_id: "RB", signal: "MOUTH_BREATHING", channel: "URGENT_DENTAL", severity: "HIGH" }, { occurred_at: "2026-12-01T10:00:00+08:00" }), /ROUTINE_ORTHODONTIC/);
});

test("拒绝：急诊通道 severity 不够", () => {
  const { svc, ids } = seed();
  reject(() => svc.escalateRisk({ child_id: ids.child, episode_id: ids.episode, risk_id: "RC", signal: "FACIAL_SWELLING", channel: "URGENT_DENTAL", severity: "MODERATE" }, { occurred_at: "2026-12-01T10:00:00+08:00" }), /severity 必须是 HIGH 或 URGENT/);
});

test("拒绝：重复升级与重复关闭风险", () => {
  const { svc, ids } = seed();
  const p = { child_id: ids.child, episode_id: ids.episode, risk_id: "RD", signal: "CROSSBITE", channel: "ROUTINE_ORTHODONTIC", severity: "MODERATE" };
  svc.escalateRisk(p, { occurred_at: "2026-12-01T10:00:00+08:00" });
  reject(() => svc.escalateRisk(p, { occurred_at: "2026-12-02T10:00:00+08:00" }), /已在升级队列/);
  reject(() => svc.resolveRisk({ child_id: ids.child, episode_id: ids.episode, risk_id: "NOPE", resolution: "x" }, { occurred_at: "2026-12-03T10:00:00+08:00" }), /风险 NOPE 不存在/);
  svc.resolveRisk({ child_id: ids.child, episode_id: ids.episode, risk_id: "RD", resolution: "处理" }, { occurred_at: "2026-12-03T10:00:00+08:00" });
  reject(() => svc.resolveRisk({ child_id: ids.child, episode_id: ids.episode, risk_id: "RD", resolution: "再关" }, { occurred_at: "2026-12-04T10:00:00+08:00" }), /不能重复关闭/);
});

// —— 证据与观察 ——

test("拒绝：证据标科研用途但无对应知情同意", () => {
  const svc = new FollowupService(undefined, () => T1);
  svc.registerChild({ child_id: "C2", birth_year_month: "2022-03", registered_campus_id: "east" }, { occurred_at: T0 });
  svc.linkGuardian({ child_id: "C2", guardian_id: "G2", relationship: "PARENT", legal_basis: "户口" }, { occurred_at: T0 });
  svc.openEpisode({ episode_id: "EP2", child_id: "C2", campus_id: "east", reason: "x" }, { occurred_at: T0 });
  svc.grantConsent({ child_id: "C2", guardian_id: "G2", purposes: ["TREATMENT"], granted_at: T1 }, { event_id: "only-treatment" });
  reject(() => svc.captureEvidence({ child_id: "C2", episode_id: "EP2", evidence_id: "EVX", kind: "FACIAL_PHOTO", exam_source: "CAMPUS_VISIT", campus_id: "east", captured_at: T1, dentition_stage: "PRIMARY_DENTITION", permissions: { TREATMENT: true, RESEARCH: true } }), /RESEARCH/);
});

test("拒绝：证据关闭诊疗用途", () => {
  const errors = validateEvent({
    event_id: "e", event_type: "EVIDENCE_CAPTURED", aggregate_type: "clinical_observation",
    aggregate_id: "x", subject_id: "C1", occurred_at: T1, version: 1, summary: "x",
    payload: { child_id: "C1", episode_id: "EP1", evidence_id: "E", kind: "FACIAL_PHOTO", exam_source: "CAMPUS_VISIT", campus_id: "east", captured_at: T1, dentition_stage: "PRIMARY_DENTITION", permissions: { TREATMENT: false } },
  });
  assert.ok(errors.some((m) => m.includes("TREATMENT")));
});

test("拒绝：意见引用不存在或其他儿童的证据", () => {
  const { svc, ids } = seed();
  reject(() => svc.issueOpinion({ child_id: ids.child, episode_id: ids.episode, opinion_id: "OPX1", evidence_refs: ["GHOST"], clinician_id: "D1", stance: "OBSERVE", rationale: "x" }), /不存在的证据/);
  // 第二个儿童
  svc.registerChild({ child_id: "C3", birth_year_month: "2021-01", registered_campus_id: "east" }, { occurred_at: "2026-10-01T09:00:00+08:00" });
  reject(() => svc.issueOpinion({ child_id: "C3", episode_id: ids.episode, opinion_id: "OPX2", evidence_refs: [ids.evidence], clinician_id: "D1", stance: "OBSERVE", rationale: "x" }), /不属于儿童 C3/);
});

test("拒绝：观察发现缺类别或 present 非布尔", () => {
  const { svc, ids } = seed();
  reject(() => svc.recordObservation({ child_id: ids.child, episode_id: ids.episode, dentition_stage: "PRIMARY_DENTITION", findings: [], observer_id: "D1", campus_id: "east" }), /findings 必须是非空数组/);
  reject(() => svc.recordObservation({ child_id: ids.child, episode_id: ids.episode, dentition_stage: "PRIMARY_DENTITION", findings: [{ category: "NOT_A_CATEGORY", present: true, detail: "x" }], observer_id: "D1", campus_id: "east" }), /category 必须是/);
});

// —— 方案与知情决定 ——

test("拒绝：无证据的方案（防止按年龄出治疗）", () => {
  const { svc, ids } = seed();
  reject(() => svc.proposePlan({ child_id: ids.child, episode_id: ids.episode, plan_id: "PLX", proposal_id: "PRX", clinician_id: "D1", items: [{ item_id: "I", type: "FIXED_APPLIANCE" }], rationale: "家长要求", evidence_refs: [] }), /evidence_refs/);
});

test("拒绝：确认方案缺知情同意 / 缺复诊窗 / 监护人不合格", () => {
  const { svc, ids } = seed();
  svc.proposePlan({ child_id: ids.child, episode_id: ids.episode, plan_id: "PL2", proposal_id: "PR2", clinician_id: "D1", items: [{ item_id: "I2", type: "REMOVABLE_APPLIANCE" }], rationale: "x", evidence_refs: [ids.evidence] }, { event_id: "prop2" });
  reject(() => svc.confirmPlan({ child_id: ids.child, plan_id: "PL2", proposal_id: "PR2", consent_ref: "GHOST", window_ref: ids.window, decided_by_guardian_id: ids.guardian }), /知情同意/);
  reject(() => svc.confirmPlan({ child_id: ids.child, plan_id: "PL2", proposal_id: "PR2", consent_ref: ids.consent, window_ref: "GHOST-W", decided_by_guardian_id: ids.guardian }), /复诊窗/);
  reject(() => svc.confirmPlan({ child_id: ids.child, plan_id: "PL2", proposal_id: "PR2", consent_ref: ids.consent, window_ref: ids.window, decided_by_guardian_id: "STRANGER" }), /监护关系/);
});

test("拒绝：绑定已结束的复诊窗确认方案（先观察也要有未来节点）", () => {
  const { svc, ids } = seed();
  const T2 = "2026-12-10T10:00:00+08:00";
  svc.completeFollowup({ child_id: ids.child, episode_id: ids.episode, window_ref: ids.window, completed_at: T2, outcome: "KEPT" }, { occurred_at: T2 });
  svc.proposePlan({ child_id: ids.child, episode_id: ids.episode, plan_id: "PL3", proposal_id: "PR3", clinician_id: "D1", items: [{ item_id: "I3", type: "OBSERVE" }], rationale: "x", evidence_refs: [ids.evidence] }, { occurred_at: T2 });
  reject(() => svc.confirmPlan({ child_id: ids.child, plan_id: "PL3", proposal_id: "PR3", consent_ref: ids.consent, window_ref: ids.window, decided_by_guardian_id: ids.guardian }), /复诊窗已结束/);
  reject(() => svc.completeFollowup({ child_id: ids.child, episode_id: ids.episode, window_ref: ids.window, completed_at: T2, outcome: "KEPT" }, { occurred_at: "2026-12-11T10:00:00+08:00" }), /不能重复完成/);
});

test("拒绝：修订未确认方案 / revision_of 指错 / 无新同意", () => {
  const { svc, ids } = seed();
  svc.proposePlan({ child_id: ids.child, episode_id: ids.episode, plan_id: "PL4", proposal_id: "PR4", clinician_id: "D1", items: [{ item_id: "I4", type: "OBSERVE" }], rationale: "x", evidence_refs: [ids.evidence] });
  reject(() => svc.revisePlan({ child_id: ids.child, plan_id: "PL4", revision_of: "PR4", revision_proposal_id: "RV4", reason: "GROWTH_CHANGE", changes: { add: [], remove: [], adjust: [] }, window_ref: ids.window, decided_by_guardian_id: ids.guardian, consent_ref: ids.consent }), /只能修订已确认/);
  // 已确认方案上 revision_of 错误
  reject(() => svc.revisePlan({ child_id: ids.child, plan_id: ids.plan, revision_of: "WRONG", revision_proposal_id: "RVX", reason: "GUARDIAN_REQUEST", changes: { add: [], remove: [], adjust: [{ item_id: "IT1" }] }, window_ref: ids.window, decided_by_guardian_id: ids.guardian, consent_ref: ids.consent }), /revision_of 必须指向当前生效提案/);
});

test("拒绝：以不良反应为由修订但没有不良反应事件；生长变化引用确认前证据", () => {
  const { svc, ids } = seed();
  reject(() => svc.revisePlan({ child_id: ids.child, plan_id: ids.plan, revision_of: ids.proposal, revision_proposal_id: "RVA", reason: "ADVERSE_REACTION", changes: { add: [], remove: [], adjust: [{ item_id: "IT1" }] }, window_ref: ids.window, decided_by_guardian_id: ids.guardian, consent_ref: ids.consent }), /ADVERSE_REACTION_REPORTED/);
  reject(() => svc.revisePlan({ child_id: ids.child, plan_id: ids.plan, revision_of: ids.proposal, revision_proposal_id: "RVG", reason: "GROWTH_CHANGE", changes: { add: [], remove: ["IT1"], adjust: [] }, evidence_refs: [ids.evidence], window_ref: ids.window, decided_by_guardian_id: ids.guardian, consent_ref: ids.consent }), /采集于方案确认之前/);
});

test("拒绝：对未确认方案报告器械不良反应，或 device_ref 不属于方案", () => {
  const { svc, ids } = seed();
  reject(() => svc.reportAdverseReaction({ child_id: ids.child, plan_id: "GHOST", device_ref: "X", severity: "HIGH", detail: "x" }), /方案 GHOST 不存在/);
  reject(() => svc.reportAdverseReaction({ child_id: ids.child, plan_id: ids.plan, device_ref: "NOT-AN-ITEM", severity: "HIGH", detail: "x" }), /device_ref NOT-AN-ITEM 不在当前生效方案/);
});

test("拒绝：复诊窗未完成就复评", () => {
  const { svc, ids } = seed();
  reject(() => svc.reassessPlan({ child_id: ids.child, plan_id: ids.plan, window_ref: ids.window, outcome: "CONTINUE", summary: "x" }), /复评必须在对应复诊窗完成/);
});

// —— 监护、撤回、转诊 ——

test("拒绝：已有现任监护人时直接 LINK 他人，必须走 CHANGED", () => {
  const { svc, ids } = seed();
  reject(() => svc.linkGuardian({ child_id: ids.child, guardian_id: "G2", relationship: "GRANDPARENT", legal_basis: "x" }, { occurred_at: "2027-01-01T00:00:00+08:00" }), /GUARDIAN_CHANGED/);
  reject(() => svc.changeGuardian({ child_id: ids.child, previous_guardian_id: "WRONG", new_guardian_id: "G2", relationship: "PARENT", legal_basis: "x", continuity_note: "y" }, { occurred_at: "2027-01-01T00:00:00+08:00" }), /现任监护人应为/);
});

test("拒绝：撤回 TREATMENT 用途；撤回未声明 future_use_only；撤回从未授予的用途", () => {
  const { svc, ids } = seed();
  reject(() => svc.withdrawConsent({ child_id: ids.child, guardian_id: ids.guardian, purposes: ["TREATMENT"], scope: { evidence_ids: [ids.evidence] }, future_use_only: true }, { occurred_at: "2027-01-01T00:00:00+08:00" }), /不得撤回 TREATMENT/);
  reject(() => svc.withdrawConsent({ child_id: ids.child, guardian_id: ids.guardian, purposes: ["RESEARCH"], scope: { evidence_ids: [ids.evidence] }, future_use_only: false }, { occurred_at: "2027-01-01T00:00:00+08:00" }), /future_use_only/);

  // 只授予 TREATMENT 的儿童：撤回教学/科研属于“从未授予”
  svc.registerChild({ child_id: "C7", birth_year_month: "2022-03", registered_campus_id: "east" }, { occurred_at: T0 });
  svc.linkGuardian({ child_id: "C7", guardian_id: "G7", relationship: "PARENT", legal_basis: "户口" }, { occurred_at: T0 });
  svc.grantConsent({ child_id: "C7", guardian_id: "G7", purposes: ["TREATMENT"], granted_at: T1 }, { event_id: "cs7" });
  reject(() => svc.withdrawConsent({ child_id: "C7", guardian_id: "G7", purposes: ["TEACHING"], scope: { evidence_ids: ["whatever"] }, future_use_only: true }), /从未被授予/);
});

test("拒绝：更换监护人后，旧监护人不能再作出撤回", () => {
  const { svc, ids } = seed();
  svc.changeGuardian({ child_id: ids.child, previous_guardian_id: ids.guardian, new_guardian_id: "G2", relationship: "PARENT", legal_basis: "公证", continuity_note: "连续" }, { occurred_at: "2027-01-01T00:00:00+08:00" });
  reject(() => svc.withdrawConsent({ child_id: ids.child, guardian_id: ids.guardian, purposes: ["RESEARCH"], scope: { evidence_ids: [ids.evidence] }, future_use_only: true }, { occurred_at: "2027-01-02T00:00:00+08:00" }), /不具有有效监护关系/);
  // 新监护人可以撤回
  svc.withdrawConsent({ child_id: ids.child, guardian_id: "G2", purposes: ["RESEARCH"], scope: { evidence_ids: [ids.evidence] }, future_use_only: true }, { occurred_at: "2027-01-02T00:00:00+08:00" });
});

test("拒绝：转诊缺跨院同意 / consent_ref 指错 / 纳入未授权证据 / 同院转诊", () => {
  const { svc, ids } = seed();
  const T = "2027-02-01T00:00:00+08:00";
  const base = { child_id: ids.child, episode_id: ids.episode, from_campus_id: "east", to_campus_id: "west", continuity_package: [ids.evidence], purpose_restrictions: ["TREATMENT", "CROSS_CAMPUS_CONTINUITY"] };
  reject(() => svc.issueReferral({ ...base, consent_ref: "GHOST" }, { occurred_at: T }), /consent_ref/);
  reject(() => svc.issueReferral({ ...base, to_campus_id: "east", consent_ref: ids.consent }, { occurred_at: T }), /院区不能相同/);
  // 一条仅诊疗授权的证据不得进入转诊包
  svc.captureEvidence({ child_id: ids.child, episode_id: ids.episode, evidence_id: "EV-LOCAL", kind: "PANORAMIC_XRAY", exam_source: "CAMPUS_VISIT", campus_id: "east", captured_at: "2026-10-01T00:00:00+08:00", dentition_stage: "PRIMARY_DENTITION", permissions: { TREATMENT: true } }, { occurred_at: "2026-10-01T00:00:00+08:00" });
  reject(() => svc.issueReferral({ ...base, consent_ref: ids.consent, continuity_package: ["EV-LOCAL"] }, { occurred_at: T }), /未授权 CROSS_CAMPUS_CONTINUITY/);
  // 合法转诊应通过
  svc.issueReferral({ ...base, consent_ref: ids.consent }, { occurred_at: T });
});
