import assert from "node:assert/strict";
import test from "node:test";

import { FollowupService } from "../src/application.js";
import { buildFamilyView, buildClinicianView, buildTriageQueues } from "../src/projections.js";
import { buildScenario, IDS } from "../examples/scenario.js";

const { events } = buildScenario();
const E = IDS.evidence;

test("家长视图：初诊后是“观察中 + 有下一节点”，而非无计划", () => {
  const view = buildFamilyView(events, IDS.child, "2026-09-02T00:00:00+08:00");
  assert.equal(view.current_plan.status, "ACTIVE_OBSERVATION");
  assert.equal(view.next_milestone.window_id, IDS.windows.observe);
  assert.equal(view.next_milestone.overdue, false);
  // 家长能读到“为什么观察”
  assert.ok(view.observation_reasons.some((r) => r.includes("年龄本身不构成")));
});

test("家长视图：观察窗逾期产生提醒（先观察≠无需复诊）", () => {
  // 独立小夹具：确认观察方案后家长误把“先观察”当无需复诊，窗口逾期
  const t0 = "2026-09-01T09:00:00+08:00";
  const svc = new FollowupService(undefined, () => t0);
  svc.registerChild({ child_id: "CO", birth_year_month: "2022-03", registered_campus_id: "east" });
  svc.linkGuardian({ child_id: "CO", guardian_id: "GO", relationship: "PARENT", legal_basis: "户口" });
  svc.openEpisode({ episode_id: "EPO", child_id: "CO", campus_id: "east", reason: "咨询" });
  svc.grantConsent({ child_id: "CO", guardian_id: "GO", purposes: ["TREATMENT"], granted_at: t0 }, { event_id: "cso" });
  svc.captureEvidence({ child_id: "CO", episode_id: "EPO", evidence_id: "EVO", kind: "INTRAORAL_PHOTO", exam_source: "CAMPUS_VISIT", campus_id: "east", captured_at: t0, dentition_stage: "PRIMARY_DENTITION", permissions: { TREATMENT: true } });
  svc.proposePlan({ child_id: "CO", episode_id: "EPO", plan_id: "PLO", proposal_id: "PRO", clinician_id: "D1", items: [{ item_id: "IO", type: "OBSERVE", note: "3 个月复诊" }], rationale: "观察", evidence_refs: ["EVO"] });
  svc.scheduleWindow({ child_id: "CO", episode_id: "EPO", window_id: "WO", due_from: "2026-12-01", due_to: "2026-12-15", reason: "OBSERVATION" });
  svc.confirmPlan({ child_id: "CO", plan_id: "PLO", proposal_id: "PRO", consent_ref: "cso", window_ref: "WO", decided_by_guardian_id: "GO" });

  const queues = buildTriageQueues(svc.store.events(), "2026-12-20T00:00:00+08:00");
  assert.ok(queues.overdue_followups.some((w) => w.window_id === "WO" && w.child_id === "CO"));
  const family = buildFamilyView(svc.store.events(), "CO", "2026-12-20T00:00:00+08:00");
  assert.equal(family.next_milestone.overdue, true);
});

test("分级：急性牙痛当晚进入 URGENT_DENTAL，且不进常规队列", () => {
  const at = "2026-12-10T21:00:00+08:00";
  const q = buildTriageQueues(events, at);
  assert.equal(q.urgent_dental.length, 1);
  assert.equal(q.urgent_dental[0].signal, "ACUTE_DENTAL_PAIN");
  assert.equal(q.routine_orthodontic.length, 0);
});

test("分级：急诊处理后风险关闭，次日两队列都不再含该风险", () => {
  const q = buildTriageQueues(events, "2026-12-12T00:00:00+08:00");
  assert.deepEqual(q.urgent_dental, []);
  assert.deepEqual(q.routine_orthodontic, []);
});

test("医生视图：同一头影测量上两位医生意见并存", () => {
  const view = buildClinicianView(events, IDS.child, "2027-07-01T00:00:00+08:00");
  const mixed = view.evidence_by_stage.find((s) => s.dentition_stage === "MIXED_DENTITION");
  const ceph = mixed.evidence.find((e2) => e2.evidence_id === E.cephalogram);
  const stances = ceph.opinions.map((o) => `${o.clinician_id}:${o.stance}`).sort();
  assert.deepEqual(stances, ["clinician-D1:INVESTIGATE", "clinician-D3:INTERVENE"]);
});

test("医生视图：证据按牙列阶段分组且跨阶段可比", () => {
  const view = buildClinicianView(events, IDS.child, "2027-10-06T00:00:00+08:00");
  const stages = view.evidence_by_stage.map((s) => s.dentition_stage);
  assert.deepEqual(stages, ["PRIMARY_DENTITION", "MIXED_DENTITION"]);
});

test("医生视图：方案修订链保留原判断，当前条目为功能矫治器", () => {
  const view = buildClinicianView(events, IDS.child, "2027-10-06T00:00:00+08:00");
  const plan = view.plans[0];
  assert.equal(plan.revisions.length, 2);
  assert.equal(plan.revisions[0].reason, "GROWTH_CHANGE");
  assert.equal(plan.revisions[0].revision_of, "proposal-initial");
  assert.equal(plan.revisions[1].reason, "ADVERSE_REACTION");
  assert.deepEqual(plan.current_items.map((i) => i.type), ["FUNCTIONAL_APPLIANCE"]);
  // 初版 rationale 仍可追溯
  assert.ok(plan.initial.rationale.includes("不支持即刻矫治"));
});

test("医生视图：不良反应与复评留档", () => {
  const view = buildClinicianView(events, IDS.child, "2027-10-06T00:00:00+08:00");
  const plan = view.plans[0];
  assert.equal(plan.adverse_reactions.length, 1);
  assert.equal(plan.adverse_reactions[0].device_ref, "item-functional");
  assert.deepEqual(plan.reassessments.map((r) => r.outcome), ["REVISE", "CONTINUE"]);
});

test("用途台账：撤回科研后 EV1 仅科研不可用，诊疗/教学/跨院仍可用", () => {
  const view = buildClinicianView(events, IDS.child, "2027-10-06T00:00:00+08:00");
  const primary = view.evidence_by_stage[0];
  const ev1 = primary.evidence.find((e2) => e2.evidence_id === E.initialPhoto);
  assert.deepEqual(ev1.usable_for, {
    TREATMENT: true,
    TEACHING: true,
    RESEARCH: false,
    CROSS_CAMPUS_CONTINUITY: true,
  });
  // 撤回之前（如 2027-09）科研仍可用——撤回不追溯
  const before = buildClinicianView(events, IDS.child, "2027-09-30T00:00:00+08:00");
  const ev1Before = before.evidence_by_stage[0].evidence.find((e2) => e2.evidence_id === E.initialPhoto);
  assert.equal(ev1Before.usable_for.RESEARCH, true);
});

test("用途台账：从未授权科研的面像在任何时点科研均不可用", () => {
  const view = buildClinicianView(events, IDS.child, "2027-10-06T00:00:00+08:00");
  const facial = view.evidence_by_stage[0].evidence.find((e2) => e2.evidence_id === E.initialFacial);
  assert.equal(facial.usable_for.RESEARCH, false);
  assert.equal(facial.usable_for.TREATMENT, true);
});

test("转诊：只携带授权跨院用途的证据，且记录用途限制", () => {
  const view = buildClinicianView(events, IDS.child, "2027-10-06T00:00:00+08:00");
  assert.equal(view.referrals.length, 1);
  const ref = view.referrals[0];
  assert.deepEqual(ref.continuity_package.sort(), [E.cephalogram, E.initialPhoto].sort());
  assert.deepEqual(ref.purpose_restrictions, ["TREATMENT", "CROSS_CAMPUS_CONTINUITY"]);
  assert.notEqual(ref.from_campus_id, ref.to_campus_id);
});

test("监护关系：更换后家长视图现任监护人更新，同意台账保留两任记录", () => {
  const before = buildFamilyView(events, IDS.child, "2027-09-30T00:00:00+08:00");
  const after = buildFamilyView(events, IDS.child, "2027-10-06T00:00:00+08:00");
  assert.equal(before.child.current_guardian_id, IDS.guardianA);
  assert.equal(after.child.current_guardian_id, IDS.guardianB);
  const view = buildClinicianView(events, IDS.child, "2027-10-06T00:00:00+08:00");
  assert.ok(view.consent_ledger.withdrawals.some((w) => w.guardian_id === IDS.guardianB));
});
