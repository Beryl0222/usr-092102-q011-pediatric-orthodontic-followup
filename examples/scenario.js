// 联调场景：一个完整的儿童正畸生长随访故事，供样例生成与测试共用。
//
// 故事线：
// 2026-09  4 岁 6 个月，家长要求立刻戴矫治器 -> 证据与多院区初诊 -> 医生给“先观察”
//          并排定 3 个月复诊窗；家长完成知情决定（含教学/科研/跨院连续授权）。
// 2026-12  夜间急性牙痛 -> URGENT_DENTAL 通道升级 -> 急诊检查、龋病治疗后关闭；
//          同期完成观察窗复诊。
// 2027-06  进入混合牙列期，头影测量显示生长变化 -> 两位医生意见并存（介入 / 再观察）
//          -> 监护人知情后以功能矫治器修订方案（原“观察”判断保留，不被覆盖）。
// 2027-09  佩戴后黏膜不良反应 -> 上报 -> 复诊窗完成后复评 REVISE。
// 2027-10  监护人更换；新监护人撤回 EV1 的科研用途（仅未来用途）；
//          随后跨院转诊，连续性资料包只携带授权用途。
import { FollowupService } from "../src/application.js";

export const IDS = Object.freeze({
  child: "child-2022-0007",
  episode: "ep-2026-0007",
  guardianA: "guardian-1001",
  guardianB: "guardian-1002",
  consentInitial: "evt-consent-initial",
  consentRevision: "evt-consent-revision",
  evidence: {
    initialPhoto: "ev-2026-09-intraoral",
    initialFacial: "ev-2026-09-facial",
    emergencyPhoto: "ev-2026-12-emergency",
    cephalogram: "ev-2027-06-ceph",
  },
  opinions: {
    observe: "op-d1-observe",
    intervene: "op-d3-intervene",
    investigate: "op-d1-investigate",
  },
  plan: "plan-0007",
  windows: { observe: "win-2026-12", postFit: "win-2027-09" },
  risk: "risk-acute-pain-001",
  referral: "referral-2027-10",
});

export function buildScenario() {
  let now = "2026-09-01T09:00:00+08:00";
  const service = new FollowupService(undefined, () => now);
  const E = IDS.evidence;
  const O = IDS.opinions;

  service.registerChild(
    { child_id: IDS.child, birth_year_month: "2022-03", registered_campus_id: "campus-east" },
    { event_id: "evt-child-registered", summary: "建档：4 岁 6 个月儿童首次正畸咨询" },
  );
  service.linkGuardian(
    { child_id: IDS.child, guardian_id: IDS.guardianA, relationship: "PARENT", legal_basis: "户口登记" },
    { event_id: "evt-guardian-a-linked", summary: "登记监护人 A" },
  );
  service.openEpisode(
    { episode_id: IDS.episode, child_id: IDS.child, campus_id: "campus-east", reason: "家长要求 4 岁即刻戴矫治器，医生需评估" },
    { event_id: "evt-episode-opened", summary: "开启生长随访主线" },
  );

  now = "2026-09-01T09:20:00+08:00";
  service.grantConsent(
    {
      child_id: IDS.child,
      guardian_id: IDS.guardianA,
      purposes: ["TREATMENT", "TEACHING", "RESEARCH", "CROSS_CAMPUS_CONTINUITY"],
      granted_at: now,
    },
    { event_id: IDS.consentInitial, summary: "监护人 A 授予诊疗/教学/科研/跨院连续用途" },
  );

  now = "2026-09-01T09:40:00+08:00";
  service.captureEvidence({
    child_id: IDS.child,
    episode_id: IDS.episode,
    evidence_id: E.initialPhoto,
    kind: "INTRAORAL_PHOTO",
    exam_source: "CAMPUS_VISIT",
    campus_id: "campus-east",
    captured_at: now,
    dentition_stage: "PRIMARY_DENTITION",
    permissions: { TREATMENT: true, TEACHING: true, RESEARCH: true, CROSS_CAMPUS_CONTINUITY: true },
  }, { event_id: "evt-ev-intraoral", summary: "初诊口内照（全用途授权）" });

  service.captureEvidence({
    child_id: IDS.child,
    episode_id: IDS.episode,
    evidence_id: E.initialFacial,
    kind: "FACIAL_PHOTO",
    exam_source: "CAMPUS_VISIT",
    campus_id: "campus-east",
    captured_at: now,
    dentition_stage: "PRIMARY_DENTITION",
    permissions: { TREATMENT: true, TEACHING: true, RESEARCH: false, CROSS_CAMPUS_CONTINUITY: false },
  }, { event_id: "evt-ev-facial", summary: "初诊面像（仅诊疗/教学）" });

  service.recordObservation({
    child_id: IDS.child,
    episode_id: IDS.episode,
    dentition_stage: "PRIMARY_DENTITION",
    findings: [
      { category: "CARIES", present: false, detail: "未见明显龋坏，建议保持涂氟" },
      { category: "ORAL_HABIT", present: true, detail: "夜间安抚剂依赖，无明显腭盖高拱" },
      { category: "MOUTH_BREATHING", present: false, detail: "鼻通气可，张口呼吸阴性" },
      { category: "SKELETAL", present: false, detail: "侧貌协调，未见骨性 III 类或下颌偏斜" },
    ],
    observer_id: "clinician-D1",
    campus_id: "campus-east",
  }, { event_id: "evt-obs-initial", summary: "初诊观察：无骨性异常信号" });

  service.issueOpinion({
    child_id: IDS.child,
    episode_id: IDS.episode,
    opinion_id: O.observe,
    evidence_refs: [E.initialPhoto, E.initialFacial],
    clinician_id: "clinician-D1",
    stance: "OBSERVE",
    rationale: "乳牙列期、无骨性异常与功能损害，年龄本身不构成矫治指征；3 个月后复诊比较生长变化。",
  }, { event_id: "evt-op-observe", summary: "医生意见：先观察并明确复诊节点" });

  service.proposePlan({
    child_id: IDS.child,
    episode_id: IDS.episode,
    plan_id: IDS.plan,
    proposal_id: "proposal-initial",
    clinician_id: "clinician-D1",
    items: [{ item_id: "item-observe", type: "OBSERVE", note: "观察替牙进程与口呼吸/习惯变化，安排 3 个月复诊窗" }],
    rationale: "现有证据不支持即刻矫治；持续观察可在混合牙列早期及时介入。",
    evidence_refs: [E.initialPhoto, E.initialFacial],
  }, { event_id: "evt-plan-proposed", summary: "提出观察方案（非按年龄自动生成）" });

  service.scheduleWindow({
    child_id: IDS.child,
    episode_id: IDS.episode,
    window_id: IDS.windows.observe,
    due_from: "2026-12-01",
    due_to: "2026-12-15",
    reason: "OBSERVATION",
  }, { event_id: "evt-win-observe", summary: "排定 3 个月观察复诊窗" });

  service.confirmPlan({
    child_id: IDS.child,
    plan_id: IDS.plan,
    proposal_id: "proposal-initial",
    consent_ref: IDS.consentInitial,
    window_ref: IDS.windows.observe,
    decided_by_guardian_id: IDS.guardianA,
  }, { event_id: "evt-plan-confirmed", summary: "监护人 A 知情确认观察方案与复诊安排" });

  // —— 12 月：急性牙痛走急诊通道 ——
  now = "2026-12-10T20:15:00+08:00";
  service.escalateRisk({
    child_id: IDS.child,
    episode_id: IDS.episode,
    risk_id: IDS.risk,
    signal: "ACUTE_DENTAL_PAIN",
    channel: "URGENT_DENTAL",
    severity: "URGENT",
    detail: "右下后牙夜间痛、冷刺激痛，需急诊处理",
  }, { event_id: "evt-risk-escalated", summary: "急性牙痛 -> URGENT_DENTAL 升级" });

  now = "2026-12-11T10:05:00+08:00";
  service.captureEvidence({
    child_id: IDS.child,
    episode_id: IDS.episode,
    evidence_id: E.emergencyPhoto,
    kind: "INTRAORAL_PHOTO",
    exam_source: "EMERGENCY_VISIT",
    campus_id: "campus-east",
    captured_at: now,
    dentition_stage: "PRIMARY_DENTITION",
    permissions: { TREATMENT: true },
  }, { event_id: "evt-ev-emergency", summary: "急诊口内照（仅诊疗用途）" });

  service.recordObservation({
    child_id: IDS.child,
    episode_id: IDS.episode,
    dentition_stage: "PRIMARY_DENTITION",
    findings: [{ category: "CARIES", present: true, detail: "85 深龋近髓，叩诊轻度不适" }],
    observer_id: "clinician-D2",
    campus_id: "campus-east",
  }, { event_id: "evt-obs-emergency", summary: "急诊观察：85 深龋" });

  service.resolveRisk({
    child_id: IDS.child,
    episode_id: IDS.episode,
    risk_id: IDS.risk,
    resolution: "牙髓切断术 + 预成冠，疼痛解除；急诊通道关闭",
  }, { event_id: "evt-risk-resolved", summary: "龋病急症处理后关闭风险" });

  service.completeFollowup({
    child_id: IDS.child,
    episode_id: IDS.episode,
    window_ref: IDS.windows.observe,
    completed_at: now,
    outcome: "KEPT",
  }, { event_id: "evt-win-observe-done", summary: "观察窗复诊完成（与急诊同期）" });

  // —— 次年 6 月：生长变化 + 多医生意见 + 修订 ——
  now = "2027-06-15T09:30:00+08:00";
  service.captureEvidence({
    child_id: IDS.child,
    episode_id: IDS.episode,
    evidence_id: E.cephalogram,
    kind: "CEPHALOGRAM",
    exam_source: "CAMPUS_VISIT",
    campus_id: "campus-east",
    captured_at: now,
    dentition_stage: "MIXED_DENTITION",
    permissions: { TREATMENT: true, CROSS_CAMPUS_CONTINUITY: true },
  }, { event_id: "evt-ev-ceph", summary: "混合牙列期头影测量" });

  service.recordObservation({
    child_id: IDS.child,
    episode_id: IDS.episode,
    dentition_stage: "MIXED_DENTITION",
    findings: [
      { category: "OCCLUSAL", present: true, detail: "双侧第一恒磨牙远中关系，前牙深覆合 II°" },
      { category: "SKELETAL", present: true, detail: "下颌后缩趋势，ANB 增大" },
    ],
    observer_id: "clinician-D3",
    campus_id: "campus-east",
  }, { event_id: "evt-obs-mixed", summary: "混合牙列期观察：II 类趋势" });

  service.issueOpinion({
    child_id: IDS.child,
    episode_id: IDS.episode,
    opinion_id: O.intervene,
    evidence_refs: [E.cephalogram],
    clinician_id: "clinician-D3",
    stance: "INTERVENE",
    rationale: "生长高峰前期、下颌后缩，建议功能矫治器引导颌骨生长。",
  }, { event_id: "evt-op-intervene", summary: "医生 D3：建议介入" });

  service.issueOpinion({
    child_id: IDS.child,
    episode_id: IDS.episode,
    opinion_id: O.investigate,
    evidence_refs: [E.cephalogram, E.initialPhoto],
    clinician_id: "clinician-D1",
    stance: "INVESTIGATE",
    rationale: "建议补 6 个月生长资料后再定；两意见并存，由监护人参与决定。",
  }, { event_id: "evt-op-investigate", summary: "医生 D1：建议再观察（意见并存，不覆盖 D3）" });

  service.grantConsent(
    { child_id: IDS.child, guardian_id: IDS.guardianA, purposes: ["TREATMENT"], granted_at: now },
    { event_id: IDS.consentRevision, summary: "修订前再次知情同意（治疗用途）" },
  );

  service.scheduleWindow({
    child_id: IDS.child,
    episode_id: IDS.episode,
    window_id: IDS.windows.postFit,
    due_from: "2027-09-01",
    due_to: "2027-09-15",
    reason: "POST_DEVICE_FIT",
  }, { event_id: "evt-win-postfit", summary: "排定戴牙后复诊窗" });

  service.revisePlan({
    child_id: IDS.child,
    plan_id: IDS.plan,
    revision_of: "proposal-initial",
    revision_proposal_id: "proposal-growth-revision",
    reason: "GROWTH_CHANGE",
    changes: {
      add: [{ item_id: "item-functional", type: "FUNCTIONAL_APPLIANCE", note: "Twin-block 夜间佩戴，逐月加量" }],
      remove: ["item-observe"],
      adjust: [],
    },
    evidence_refs: [E.cephalogram],
    window_ref: IDS.windows.postFit,
    decided_by_guardian_id: IDS.guardianA,
    consent_ref: IDS.consentRevision,
  }, { event_id: "evt-plan-revised", summary: "基于生长变化修订为功能矫治（原观察判断保留）" });

  // —— 9 月：不良反应 -> 复评建议修订 -> 知情修订（调磨）-> 再复评继续 ——
  now = "2027-09-05T10:00:00+08:00";
  service.reportAdverseReaction({
    child_id: IDS.child,
    plan_id: IDS.plan,
    device_ref: "item-functional",
    severity: "MODERATE",
    detail: "下颌翼缘黏膜压疮，进食疼痛",
  }, { event_id: "evt-adverse", summary: "器械不良反应：黏膜压疮" });

  service.completeFollowup({
    child_id: IDS.child,
    episode_id: IDS.episode,
    window_ref: IDS.windows.postFit,
    completed_at: now,
    outcome: "KEPT",
  }, { event_id: "evt-win-postfit-done", summary: "戴牙后复诊窗完成" });

  service.reassessPlan({
    child_id: IDS.child,
    plan_id: IDS.plan,
    window_ref: IDS.windows.postFit,
    outcome: "REVISE",
    summary: "压疮与翼缘形态、佩戴时长有关，建议调磨器械并缩短过渡时长后复评。",
  }, { event_id: "evt-plan-reassessed", summary: "复评结论：REVISE（原修订判断保留，另开修订）" });

  const consentAdjust = service.grantConsent({
    child_id: IDS.child,
    guardian_id: IDS.guardianA,
    purposes: ["TREATMENT"],
    granted_at: now,
  }, { event_id: "evt-consent-adjust", summary: "调磨修订前知情同意" });

  service.scheduleWindow({
    child_id: IDS.child,
    episode_id: IDS.episode,
    window_id: "win-2027-09-adjust",
    due_from: "2027-09-19",
    due_to: "2027-09-30",
    reason: "ADVERSE_REACTION_MONITOR",
  }, { event_id: "evt-win-adjust", summary: "排定不良反应监测窗" });

  service.revisePlan({
    child_id: IDS.child,
    plan_id: IDS.plan,
    revision_of: "proposal-growth-revision",
    revision_proposal_id: "proposal-adverse-adjust",
    reason: "ADVERSE_REACTION",
    changes: {
      add: [],
      remove: [],
      adjust: [{ item_id: "item-functional", note: "调磨下颌翼缘；前 2 周仅夜间佩戴 6 小时，适应后恢复" }],
    },
    window_ref: "win-2027-09-adjust",
    decided_by_guardian_id: IDS.guardianA,
    consent_ref: consentAdjust.event_id,
  }, { event_id: "evt-plan-revised-adjust", summary: "因不良反应修订：调磨+过渡佩戴（不覆盖原修订）" });

  now = "2027-09-24T10:00:00+08:00";
  service.completeFollowup({
    child_id: IDS.child,
    episode_id: IDS.episode,
    window_ref: "win-2027-09-adjust",
    completed_at: now,
    outcome: "KEPT",
  }, { event_id: "evt-win-adjust-done", summary: "不良反应监测窗完成" });

  service.reassessPlan({
    child_id: IDS.child,
    plan_id: IDS.plan,
    window_ref: "win-2027-09-adjust",
    outcome: "CONTINUE",
    summary: "压疮愈合，佩戴适应，按功能矫治方案继续。",
  }, { event_id: "evt-plan-reassessed-continue", summary: "复评结论：CONTINUE" });

  service.scheduleWindow({
    child_id: IDS.child,
    episode_id: IDS.episode,
    window_id: "win-2027-12-routine",
    due_from: "2027-12-10",
    due_to: "2027-12-24",
    reason: "ROUTINE_ASSESSMENT",
  }, { event_id: "evt-win-routine", summary: "排定常规评估窗（保证始终有下一节点）" });

  // —— 10 月：监护人更换、科研撤回、跨院转诊 ——
  now = "2027-10-01T11:00:00+08:00";
  service.changeGuardian({
    child_id: IDS.child,
    previous_guardian_id: IDS.guardianA,
    new_guardian_id: IDS.guardianB,
    relationship: "PARENT",
    legal_basis: "监护权变更公证书",
    continuity_note: "向新监护人完整交付既有方案、证据与授权台账；临床连续，既往授权继续有效至被明确撤回。",
  }, { event_id: "evt-guardian-changed", summary: "监护人 A -> B，保留连续性说明" });

  now = "2027-10-02T15:00:00+08:00";
  service.withdrawConsent({
    child_id: IDS.child,
    guardian_id: IDS.guardianB,
    purposes: ["RESEARCH"],
    scope: { evidence_ids: [E.initialPhoto] },
    future_use_only: true,
  }, { event_id: "evt-consent-research-withdrawn", summary: "新监护人撤回初诊口内照的科研用途（仅未来用途）" });

  now = "2027-10-05T09:00:00+08:00";
  service.issueReferral({
    child_id: IDS.child,
    episode_id: IDS.episode,
    from_campus_id: "campus-east",
    to_campus_id: "campus-west",
    consent_ref: IDS.consentInitial,
    continuity_package: [E.initialPhoto, E.cephalogram],
    purpose_restrictions: ["TREATMENT", "CROSS_CAMPUS_CONTINUITY"],
  }, { event_id: "evt-referral", summary: "跨院转诊：仅携带授权资料，用途受限" });

  return { service, events: service.store.events() };
}
