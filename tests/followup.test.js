import assert from "node:assert/strict";
import test from "node:test";

import {
  CARIES_STATUS,
  CONSENT_SCOPE,
  DECISION,
  DENTITION_STAGE,
  HABIT,
  PURPOSE,
  REVISION_TRIGGER,
  RISK_CODE,
} from "../src/domain/codes.js";
import { checkEnvelope, makeEvent } from "../src/domain/events.js";
import { validateEvent } from "../src/validator.js";
import { ConcurrencyError, EventStore } from "../src/infrastructure/eventStore.js";
import { FollowupService, DomainError } from "../src/application/followupService.js";
import { FollowupQueries } from "../src/application/queryService.js";

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

function iso(d) {
  return new Date(d).toISOString();
}

function buildScenario(now = new Date("2026-10-03T09:00:00+08:00")) {
  const store = new EventStore();
  const svc = new FollowupService(store);
  const q = new FollowupQueries(store);

  const t0 = iso(now.getTime() - 90 * DAY);
  svc.openEpisode({
    episode_id: "ep-1",
    child: { child_id: "child-1", name: "豆豆", birth_date: "2022-05-01" },
    guardian: { guardian_id: "g-mom", name: "豆妈", relationship: "MOTHER" },
    site_id: "site-a",
    occurred_at: t0,
  });
  svc.grantConsent("ep-1", {
    scopes: [CONSENT_SCOPE.PHOTO, CONSENT_SCOPE.CLINICAL_RECORD],
    purposes: [PURPOSE.TREATMENT],
    guardian_id: "g-mom",
    occurred_at: t0,
  });
  return { store, svc, q, now, t0 };
}

test("所有事件信封都符合 domain.schema.json 契约与 kind 挂载约定", () => {
  const { store } = buildScenario();
  for (const e of store.all()) {
    assert.deepEqual(validateEvent(e), [], `契约校验失败：${e.event_id}`);
    assert.deepEqual(checkEnvelope(e), [], `信封细分校验失败：${e.event_id}`);
    assert.ok(e.version >= 1);
  }
});

test("月龄与牙列阶段只记录事实；系统不按年龄给治疗，矫治器只能随医生 TREAT 决定出现", () => {
  const { svc } = buildScenario();
  svc.recordExam({
    observation_id: "obs-1",
    episode_id: "ep-1",
    examined_at: "2026-09-01T10:00:00+08:00",
    child_age_months: 48, // 4 岁
    dentition_stage: DENTITION_STAGE.PRIMARY,
    examiner_id: "doc-ortho",
    source: "门诊检查",
  });

  // 观察方案中夹带矫治器 → 拒绝
  assert.throws(
    () =>
      svc.confirmPlan({
        episode_id: "ep-1",
        decision: DECISION.OBSERVE,
        appliance: "活动矫治器-X",
        rationale: "先观察",
        observation_reason: "乳后牙未替换，反𬌗趋势待混合牙列确认",
        followup_window: { due_date: "2027-03-01", reason: "6 个月后复评" },
        confirming_guardian_id: "g-mom",
        physician_id: "doc-ortho",
      }),
    (e) => e.code === "APPLIANCE_ONLY_WITH_TREAT",
  );

  // 年龄本身不构成治疗或不治疗的门槛：4 岁医生确认治疗也可以，但必须有知情决定
  svc.grantConsent("ep-1", {
    scopes: [CONSENT_SCOPE.PHOTO],
    purposes: [PURPOSE.TEACHING],
    guardian_id: "g-mom",
  });
  assert.throws(
    () =>
      svc.confirmPlan({
        episode_id: "ep-1",
        decision: DECISION.TREAT,
        appliance: "活动矫治器-X",
        rationale: "前牙反𬌗影响功能",
        plan_items: ["试戴活动矫治器"],
        confirming_guardian_id: "g-mom",
        physician_id: "doc-ortho",
      }),
    (e) => e.code === "TREAT_NEEDS_INFORMED_CONSENT",
  );
});

test("“先观察”意见与方案必须写理由和复诊窗口", () => {
  const { svc } = buildScenario();
  svc.recordExam({
    observation_id: "obs-1",
    episode_id: "ep-1",
    examined_at: "2026-09-01T10:00:00+08:00",
    child_age_months: 48,
    dentition_stage: DENTITION_STAGE.PRIMARY,
    examiner_id: "doc-ortho",
    source: "门诊检查",
  });
  assert.throws(
    () =>
      svc.issueOpinion({
        observation_id: "obs-1",
        physician_id: "doc-ortho",
        assessment: "暂无明显骨性问题",
        decision: DECISION.OBSERVE,
        rationale: "暂不处理",
      }),
    (e) => e.code === "OBSERVE_NEEDS_REASON",
  );
  assert.throws(
    () =>
      svc.issueOpinion({
        observation_id: "obs-1",
        physician_id: "doc-ortho",
        assessment: "暂无明显骨性问题",
        decision: DECISION.OBSERVE,
        rationale: "暂不处理",
        observation_reason: "牙列阶段未到",
      }),
    (e) => e.code === "OBSERVE_NEEDS_WINDOW",
  );
});

test("同一影像多位医生意见并存，且观察方案确认后家长看到理由与下一节点", () => {
  const { svc, q } = buildScenario();
  svc.recordExam({
    observation_id: "obs-1",
    episode_id: "ep-1",
    examined_at: "2026-09-01T10:00:00+08:00",
    child_age_months: 48,
    dentition_stage: DENTITION_STAGE.PRIMARY,
    examiner_id: "doc-a",
    source: "门诊检查",
  });
  svc.captureImage({
    observation_id: "obs-1",
    image_id: "img-1",
    image_type: "口内照",
    taken_at: "2026-09-01T10:05:00+08:00",
    consent_scope_id: "consent-ep-1",
  });
  svc.issueOpinion({
    observation_id: "obs-1",
    opinion_id: "opn-a",
    physician_id: "doc-a",
    image_ids: ["img-1"],
    assessment: "乳前牙轻度反𬌗趋势",
    decision: DECISION.OBSERVE,
    rationale: "颌骨仍在快速生长，先行观察",
    observation_reason: "等待切牙替换以判断反𬌗是否持续",
    followup_window: { due_date: "2026-12-01", reason: "切牙替换期复评" },
  });
  svc.issueOpinion({
    observation_id: "obs-1",
    opinion_id: "opn-b",
    physician_id: "doc-b",
    image_ids: ["img-1"],
    assessment: "家族史阳性，建议提前干预",
    decision: DECISION.TREAT,
    rationale: "父系反𬌗家族史",
  });

  svc.confirmPlan({
    episode_id: "ep-1",
    plan_id: "plan-1",
    decision: DECISION.OBSERVE,
    rationale: "两位医生意见并存，主诊综合判断先观察",
    observation_reason: "等待切牙替换以判断反𬌗是否持续",
    followup_window: { due_date: "2026-12-01", reason: "切牙替换期复评" },
    confirming_guardian_id: "g-mom",
    physician_id: "doc-a",
  });

  const view = q.buildPhysicianView("ep-1");
  assert.equal(view.stage_timeline[0].opinions.length, 2);
  assert.deepEqual(
    view.stage_timeline[0].opinions.map((o) => o.physician_id),
    ["doc-a", "doc-b"],
  );

  const parent = q.buildParentView("ep-1", { now: new Date("2026-10-03T09:00:00+08:00") });
  assert.equal(parent.current_plan.decision, "OBSERVE");
  assert.equal(parent.observation.reason, "等待切牙替换以判断反𬌗是否持续");
  assert.equal(parent.next_milestone.due_date, "2026-12-01");
});

test("紧急龋痛与常规正畸评估走互斥升级路径，紧急路径带 24 小时 SLA", () => {
  const { svc, q } = buildScenario();
  svc.recordExam({
    observation_id: "obs-1",
    episode_id: "ep-1",
    examined_at: "2026-10-03T08:00:00+08:00",
    child_age_months: 52,
    dentition_stage: DENTITION_STAGE.PRIMARY,
    examiner_id: "doc-a",
    source: "门诊检查",
  });
  svc.recordFindings({
    observation_id: "obs-1",
    caries: [{ tooth_code: "74", status: CARIES_STATUS.SEVERE_PAIN }],
  });

  const urgent = svc.escalateRisk({
    observation_id: "obs-1",
    escalation_id: "esc-1",
    risk_codes: [RISK_CODE.SPONTANEOUS_TOOTHACHE.code],
    occurred_at: "2026-10-03T08:30:00+08:00",
  });
  assert.equal(urgent.payload.path, "URGENT_DENTAL");
  assert.equal(urgent.payload.sla_hours, 24);

  // 混合升级必须拆开
  assert.throws(
    () =>
      svc.escalateRisk({
        observation_id: "obs-1",
        risk_codes: [RISK_CODE.FACIAL_SWELLING.code, RISK_CODE.CROSSBITE_TREND.code],
      }),
    (e) => e.code === "MIXED_ESCALATION_PATH",
  );

  const routine = svc.escalateRisk({
    observation_id: "obs-1",
    escalation_id: "esc-2",
    risk_codes: [RISK_CODE.CROSSBITE_TREND.code],
  });
  assert.equal(routine.payload.path, "ROUTINE_ORTHO");
  assert.equal(routine.payload.sla_hours, null);

  const parent = q.buildParentView("ep-1", { now: new Date("2026-10-03T09:00:00+08:00") });
  assert.equal(parent.open_urgent_escalations.length, 1);
  assert.equal(parent.open_urgent_escalations[0].escalation_id, "esc-1");
  assert.equal(
    parent.next_milestone.source,
    "escalation:esc-1",
    "紧急时限优先于一切常规节点",
  );

  svc.resolveEscalation("obs-1", "esc-1");
  const after = q.buildParentView("ep-1", { now: new Date("2026-10-03T09:00:00+08:00") });
  assert.equal(after.open_urgent_escalations.length, 0);
});

test("方案修订只能追加：原判断保留在 history，且必须附复评意见", () => {
  const { svc, q } = buildScenario();
  // 初次：观察
  svc.recordExam({
    observation_id: "obs-1",
    episode_id: "ep-1",
    examined_at: "2026-09-01T10:00:00+08:00",
    child_age_months: 48,
    dentition_stage: DENTITION_STAGE.PRIMARY,
    examiner_id: "doc-a",
    source: "门诊检查",
  });
  svc.confirmPlan({
    episode_id: "ep-1",
    plan_id: "plan-observe",
    decision: DECISION.OBSERVE,
    rationale: "反𬌗趋势待确认",
    observation_reason: "等待切牙替换",
    followup_window: { due_date: "2026-12-01", reason: "切牙替换期复评" },
    confirming_guardian_id: "g-mom",
    physician_id: "doc-a",
  });

  // 不能重复确认覆盖
  assert.throws(
    () =>
      svc.confirmPlan({
        episode_id: "ep-1",
        decision: DECISION.OBSERVE,
        rationale: "x",
        observation_reason: "y",
        followup_window: { due_date: "2027-01-01" },
        confirming_guardian_id: "g-mom",
        physician_id: "doc-a",
      }),
    (e) => e.code === "PLAN_EXISTS",
  );

  // 发育变化后的新证据与复评
  svc.recordExam({
    observation_id: "obs-2",
    episode_id: "ep-1",
    examined_at: "2026-12-05T10:00:00+08:00",
    child_age_months: 51,
    dentition_stage: DENTITION_STAGE.MIXED,
    examiner_id: "doc-a",
    source: "门诊检查",
  });
  svc.recordFindings({
    observation_id: "obs-2",
    growth: [{ code: "ANTERIOR_CROSSBITE_CONFIRMED", note: "混合牙列期反𬌗确立" }],
  });
  svc.issueOpinion({
    observation_id: "obs-2",
    opinion_id: "opn-reassess",
    physician_id: "doc-a",
    assessment: "反𬌗确立，具干预指征",
    decision: DECISION.TREAT,
    rationale: "发育变化：切牙替换后反𬌗持续",
  });

  // 无复评意见不能修订
  assert.throws(
    () =>
      svc.confirmPlan({
        episode_id: "ep-1",
        plan_id: "plan-treat",
        decision: DECISION.TREAT,
        appliance: "活动矫治器-X",
        rationale: "反𬌗确立",
        confirming_guardian_id: "g-mom",
        physician_id: "doc-a",
        consent_event_ids: ["evt-consent-1"],
        revises_plan_id: "plan-observe",
        revision_trigger: REVISION_TRIGGER.DEVELOPMENT_CHANGE,
      }),
    (e) => e.code === "REVISION_NEEDS_REASSESSMENT",
  );

  svc.confirmPlan({
    episode_id: "ep-1",
    plan_id: "plan-treat",
    decision: DECISION.TREAT,
    appliance: "活动矫治器-X",
    rationale: "反𬌗确立，具干预指征",
    plan_items: ["试戴活动矫治器", "4 周后复查压痛点"],
    followup_window: { due_date: "2027-01-05", reason: "戴用 4 周复查" },
    confirming_guardian_id: "g-mom",
    physician_id: "doc-a",
    consent_event_ids: ["evt-consent-1"],
    revises_plan_id: "plan-observe",
    revision_trigger: REVISION_TRIGGER.DEVELOPMENT_CHANGE,
    reassessment_opinion_ids: ["opn-reassess"],
    occurred_at: "2026-12-05T11:00:00+08:00",
  });

  const view = q.buildPhysicianView("ep-1");
  assert.equal(view.plans.current.plan_id, "plan-treat");
  assert.equal(view.plans.current.revises_plan_id, "plan-observe");
  assert.equal(view.plans.history.length, 1);
  assert.equal(view.plans.history[0].plan_id, "plan-observe", "原判断必须完整保留");
});

test("器械不良反应也走修订：修订链可多次追加且互不覆盖", () => {
  const { svc, q } = buildScenario();
  svc.recordExam({
    observation_id: "obs-1",
    episode_id: "ep-1",
    examined_at: "2026-09-01T10:00:00+08:00",
    child_age_months: 50,
    dentition_stage: DENTITION_STAGE.MIXED,
    examiner_id: "doc-a",
    source: "门诊检查",
  });
  svc.confirmPlan({
    episode_id: "ep-1",
    plan_id: "p1",
    decision: DECISION.TREAT,
    appliance: "矫治器-A",
    rationale: "反𬌗",
    plan_items: ["戴用"],
    confirming_guardian_id: "g-mom",
    physician_id: "doc-a",
    consent_event_ids: ["c1"],
  });
  svc.recordExam({
    observation_id: "obs-2",
    episode_id: "ep-1",
    examined_at: "2026-10-01T10:00:00+08:00",
    child_age_months: 51,
    dentition_stage: DENTITION_STAGE.MIXED,
    examiner_id: "doc-a",
    source: "门诊检查",
  });
  svc.issueOpinion({
    observation_id: "obs-2",
    opinion_id: "opn-irritation",
    physician_id: "doc-a",
    assessment: "黏膜压疮，需调整器械",
    decision: DECISION.TREAT,
    rationale: "器械不良反应",
  });
  svc.confirmPlan({
    episode_id: "ep-1",
    plan_id: "p2",
    decision: DECISION.TREAT,
    appliance: "矫治器-A-调改",
    rationale: "缓冲压迫点后继续",
    confirming_guardian_id: "g-mom",
    physician_id: "doc-a",
    consent_event_ids: ["c1"],
    revises_plan_id: "p1",
    revision_trigger: REVISION_TRIGGER.APPLIANCE_REACTION,
    reassessment_opinion_ids: ["opn-irritation"],
  });
  const view = q.buildPhysicianView("ep-1");
  assert.deepEqual(view.plans.history.map((p) => p.plan_id), ["p1"]);
  assert.equal(view.plans.current.plan_id, "p2");
});

test("撤回照片科研用途后，研究视图不可见、诊疗仍可用；教学授权独立不受影响", () => {
  const { svc, q } = buildScenario();
  svc.grantConsent("ep-1", {
    scopes: [CONSENT_SCOPE.PHOTO],
    purposes: [PURPOSE.RESEARCH, PURPOSE.TEACHING],
    guardian_id: "g-mom",
  });
  svc.recordExam({
    observation_id: "obs-1",
    episode_id: "ep-1",
    examined_at: "2026-09-01T10:00:00+08:00",
    child_age_months: 48,
    dentition_stage: DENTITION_STAGE.PRIMARY,
    examiner_id: "doc-a",
    source: "门诊检查",
  });
  svc.captureImage({
    observation_id: "obs-1",
    image_id: "img-1",
    image_type: "面相",
    taken_at: "2026-09-01T10:05:00+08:00",
    consent_scope_id: "consent-ep-1",
  });

  const before = q.buildPhysicianView("ep-1", { purpose: PURPOSE.RESEARCH });
  assert.equal(before.stage_timeline[0].images[0].usable, true);

  svc.withdrawConsent("ep-1", {
    scopes: [CONSENT_SCOPE.PHOTO],
    purposes: [PURPOSE.RESEARCH],
    guardian_id: "g-mom",
    note: "家长撤回照片科研用途",
  });

  const researchView = q.buildPhysicianView("ep-1", { purpose: PURPOSE.RESEARCH });
  assert.equal(researchView.stage_timeline[0].images[0].usable, false);
  const teachingView = q.buildPhysicianView("ep-1", { purpose: PURPOSE.TEACHING });
  assert.equal(teachingView.stage_timeline[0].images[0].usable, true);
  const treatmentView = q.buildPhysicianView("ep-1", { purpose: PURPOSE.TREATMENT });
  assert.equal(treatmentView.stage_timeline[0].images[0].usable, true);
  // 事件未被删除，仅用途关闭
  assert.ok(svc.store.all().some((e) => e.payload.image_id === "img-1"));
});

test("监护人更换不重置用途限制", () => {
  const { svc, q } = buildScenario();
  svc.grantConsent("ep-1", {
    scopes: [CONSENT_SCOPE.PHOTO],
    purposes: [PURPOSE.RESEARCH],
    guardian_id: "g-mom",
  });
  svc.changeGuardian("ep-1", {
    previous_guardian_id: "g-mom",
    new_guardian: { guardian_id: "g-dad", name: "豆爸", relationship: "FATHER" },
  });

  const view = q.buildPhysicianView("ep-1", { purpose: PURPOSE.RESEARCH });
  assert.equal(view.consent_matrix.PHOTO.RESEARCH.status, "GRANTED");
  assert.deepEqual(view.guardians.map((g) => g.guardian_id), ["g-mom", "g-dad"]);
  assert.deepEqual(view.guardians[0].until, view.guardians[1].since);

  // 原监护人不能再做授权决定
  assert.throws(
    () =>
      svc.withdrawConsent("ep-1", {
        scopes: [CONSENT_SCOPE.PHOTO],
        purposes: [PURPOSE.RESEARCH],
        guardian_id: "g-mom",
      }),
    (e) => e.code === "GUARDIAN_NOT_ACTIVE",
  );
});

test("跨院转诊保留临床连续性与用途限制，转出后本院不能再登记检查", () => {
  const { svc, q } = buildScenario();
  svc.grantConsent("ep-1", {
    scopes: [CONSENT_SCOPE.PHOTO],
    purposes: [PURPOSE.TEACHING],
    guardian_id: "g-mom",
  });
  svc.recordExam({
    observation_id: "obs-1",
    episode_id: "ep-1",
    examined_at: "2026-09-01T10:00:00+08:00",
    child_age_months: 48,
    dentition_stage: DENTITION_STAGE.PRIMARY,
    examiner_id: "doc-a",
    source: "门诊检查",
  });
  svc.captureImage({
    observation_id: "obs-1",
    image_id: "img-1",
    image_type: "口内照",
    taken_at: "2026-09-01T10:05:00+08:00",
    consent_scope_id: "consent-ep-1",
  });
  // 未授予 PHOTO×RESEARCH：照片不应进入会被二次使用的场景，但诊疗连续性仍随包
  const referral = svc.transferReferral({
    episode_id: "ep-1",
    to_site_id: "site-b",
    reason: "家庭迁居，跨院继续正畸随访",
  });
  assert.ok(referral.payload.packet_event_ids.length >= 3);
  assert.equal(referral.payload.consent_restrictions["PHOTO.TEACHING"], "GRANTED");

  const view = q.buildPhysicianView("ep-1");
  assert.equal(view.referral.to_site_id, "site-b");
  assert.equal(view.referral.carries_consent_restrictions, true);

  assert.throws(
    () =>
      svc.recordExam({
        observation_id: "obs-x",
        episode_id: "ep-1",
        examined_at: "2026-10-01T10:00:00+08:00",
        child_age_months: 49,
        dentition_stage: DENTITION_STAGE.PRIMARY,
        examiner_id: "doc-a",
        source: "门诊检查",
      }),
    (e) => e.code === "EPISODE_REFERRED_OUT",
  );
});

test("逾期复诊进入提醒清单，复诊完成后关闭；紧急 SLA 逾期同样提醒", () => {
  const now = new Date("2026-10-03T09:00:00+08:00");
  const { svc, q } = buildScenario(now);
  svc.recordExam({
    observation_id: "obs-1",
    episode_id: "ep-1",
    examined_at: iso(now.getTime() - 40 * DAY),
    child_age_months: 48,
    dentition_stage: DENTITION_STAGE.PRIMARY,
    examiner_id: "doc-a",
    source: "门诊检查",
  });
  svc.confirmPlan({
    episode_id: "ep-1",
    plan_id: "plan-1",
    decision: DECISION.OBSERVE,
    rationale: "等待替换",
    observation_reason: "切牙未替换",
    followup_window: { due_date: iso(now.getTime() - 5 * DAY), reason: "已过期的复评" },
    confirming_guardian_id: "g-mom",
    physician_id: "doc-a",
    occurred_at: iso(now.getTime() - 40 * DAY),
  });

  const overdue = q.listDueWindows({ now });
  assert.ok(overdue.some((r) => r.episode_id === "ep-1" && r.status === "OVERDUE"));

  svc.completeVisit({ episode_id: "ep-1", visit_at: iso(now.getTime() - 1 * DAY) });
  const cleared = q.listDueWindows({ now });
  assert.equal(cleared.some((r) => r.episode_id === "ep-1" && r.source_kind === "PLAN"), false);
});

test("事件存储按聚合递增版本并做乐观并发控制", () => {
  const { svc } = buildScenario();
  const episodeVersion = svc.store.versionOf("growth_episode", "ep-1");
  const consentVersion = svc.store.versionOf("consent_scope", "consent-ep-1");
  assert.equal(episodeVersion, 1); // 建档事件
  assert.equal(consentVersion, 1); // 授权事件落在 consent_scope 聚合

  // 两个调用方都基于版本 0 向同一新聚合追加，第二个必须收到并发冲突
  const fresh = makeEvent({
    event_type: "OBSERVATION_RECORDED",
    aggregate_type: "growth_episode",
    aggregate_id: "ep-concurrent",
    payload_kind: "EPISODE_OPENED",
    payload: {
      episode_id: "ep-concurrent",
      child: { child_id: "c", name: "测试" },
      guardian: { guardian_id: "g", name: "家长", relationship: "MOTHER" },
      site_id: "site-a",
    },
  });
  const twin = { ...fresh, event_id: "evt-twin" };
  svc.store.append(fresh, { expectedVersion: 0 });
  assert.throws(() => svc.store.append(twin, { expectedVersion: 0 }), ConcurrencyError);
});

test("龋病、口呼吸等发现可跨检查累计，作为各阶段生长比较的证据", () => {
  const { svc, q } = buildScenario();
  svc.recordExam({
    observation_id: "obs-1",
    episode_id: "ep-1",
    examined_at: "2026-09-01T10:00:00+08:00",
    child_age_months: 48,
    dentition_stage: DENTITION_STAGE.PRIMARY,
    examiner_id: "doc-a",
    source: "门诊检查",
  });
  svc.recordFindings({
    observation_id: "obs-1",
    caries: [{ tooth_code: "54", status: CARIES_STATUS.WHITE_LESION }],
    habits: [{ code: HABIT.MOUTH_BREATHING, note: "家长诉夜间张口" }],
  });
  svc.recordExam({
    observation_id: "obs-2",
    episode_id: "ep-1",
    examined_at: "2026-12-01T10:00:00+08:00",
    child_age_months: 51,
    dentition_stage: DENTITION_STAGE.MIXED,
    examiner_id: "doc-a",
    source: "门诊检查",
  });
  svc.recordFindings({
    observation_id: "obs-2",
    caries: [{ tooth_code: "54", status: CARIES_STATUS.CARIES_DENTIN }],
    habits: [{ code: HABIT.MOUTH_BREATHING, note: "仍持续" }],
    growth: [{ code: "MAXILLARY_DEFICIENCY_TREND", note: "面中份发育趋势观察" }],
  });
  const view = q.buildPhysicianView("ep-1");
  assert.deepEqual(view.stage_timeline.map((t) => t.dentition_stage), [
    DENTITION_STAGE.PRIMARY,
    DENTITION_STAGE.MIXED,
  ]);
  assert.equal(view.stage_timeline[0].findings.caries[0].status, CARIES_STATUS.WHITE_LESION);
  assert.equal(view.stage_timeline[1].findings.caries[0].status, CARIES_STATUS.CARIES_DENTIN);
});

test("非法事件不能入存储（契约枚举受保护）", () => {
  const { store } = buildScenario();
  assert.throws(
    () =>
      store.append({
        event_id: "x",
        event_type: "TREAT_BY_AGE",
        aggregate_type: "growth_episode",
        aggregate_id: "ep-1",
        occurred_at: "2026-10-03T09:00:00+08:00",
        version: 1,
        summary: "非法",
        payload: { kind: "EPISODE_OPENED" },
      }),
    (e) => e.code === "EVENT_VALIDATION_ERROR",
  );
});
