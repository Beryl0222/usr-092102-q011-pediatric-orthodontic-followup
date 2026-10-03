// 读模型：从仅追加事件流重放，面向三类使用场景。
// - 家长视图：当前计划、观察理由、下一节点、活跃风险（不含诊断码）。
// - 接诊医生视图：按牙列阶段比较证据、多医生意见并存、方案修订链、资料用途台账。
// - 分级处置：紧急龋痛 / 常规正畸评估两个不重叠队列，以及逾期复诊提醒。
//
// 所有函数都是纯函数：输入已校验事件数组，输出普通对象，不修改事件。

function byTime(a, b) {
  return (a.occurred_at < b.occurred_at ? -1 : 1) || (a.event_id < b.event_id ? -1 : 1);
}

function replay(events, asOf = null) {
  const children = new Map();
  const episodes = new Map();
  const evidence = new Map();
  const opinions = [];
  const risks = [];
  const windows = [];
  const plans = new Map();
  const consentLedgers = new Map();
  const referrals = [];

  for (const e of [...events].sort(byTime)) {
    if (asOf && e.occurred_at > asOf) continue;
    const p = e.payload;
    if (!p) continue;

    switch (e.event_type) {
      case "CHILD_REGISTERED":
        children.set(p.child_id, { child_id: p.child_id, birth_year_month: p.birth_year_month, guardians: [] });
        consentLedgers.set(p.child_id, { grants: [], withdrawals: [] });
        break;

      case "GUARDIAN_LINKED": {
        const c = children.get(p.child_id);
        const open = c?.guardians.find((g) => g.to === null);
        if (open) open.to = e.occurred_at;
        c?.guardians.push({ guardian_id: p.guardian_id, relationship: p.relationship, from: e.occurred_at, to: null });
        break;
      }

      case "GUARDIAN_CHANGED": {
        const c = children.get(p.child_id);
        const open = c?.guardians.find((g) => g.guardian_id === p.previous_guardian_id && g.to === null);
        if (open) open.to = e.occurred_at;
        c?.guardians.push({ guardian_id: p.new_guardian_id, relationship: p.relationship, from: e.occurred_at, to: null, note: p.continuity_note });
        break;
      }

      case "EPISODE_OPENED":
        episodes.set(e.aggregate_id, { episode_id: e.aggregate_id, child_id: p.child_id, opened_at: e.occurred_at, reason: p.reason });
        break;

      case "EVIDENCE_CAPTURED":
        evidence.set(p.evidence_id, { ...p, recorded_at: e.occurred_at, opinions: [] });
        break;

      case "OBSERVATION_RECORDED":
        opinions.push({ kind: "observation", ...p, recorded_at: e.occurred_at });
        break;

      case "OPINION_ISSUED":
        opinions.push({ kind: "opinion", opinion_id: p.opinion_id, ...p, issued_at: e.occurred_at });
        for (const ref of p.evidence_refs ?? []) evidence.get(ref)?.opinions.push(p.opinion_id);
        break;

      case "RISK_ESCALATED":
        risks.push({
          risk_id: p.risk_id,
          child_id: p.child_id,
          episode_id: p.episode_id,
          signal: p.signal,
          channel: p.channel,
          severity: p.severity,
          detail: p.detail ?? null,
          escalated_at: e.occurred_at,
          active: true,
          resolved_at: null,
          resolution: null,
        });
        break;

      case "RISK_RESOLVED": {
        const r = risks.find((x) => x.risk_id === p.risk_id);
        if (r) {
          r.active = false;
          r.resolved_at = e.occurred_at;
          r.resolution = p.resolution;
        }
        break;
      }

      case "FOLLOWUP_WINDOW_SCHEDULED":
        windows.push({
          window_id: p.window_id,
          child_id: p.child_id,
          episode_id: p.episode_id,
          due_from: p.due_from,
          due_to: p.due_to,
          reason: p.reason,
          scheduled_at: e.occurred_at,
          completed_at: null,
          outcome: null,
        });
        break;

      case "FOLLOWUP_COMPLETED": {
        const w = windows.find((x) => x.window_id === p.window_ref);
        if (w) {
          w.completed_at = p.completed_at;
          w.outcome = p.outcome;
        }
        break;
      }

      case "PLAN_PROPOSED": {
        plans.set(p.plan_id, {
          plan_id: p.plan_id,
          child_id: p.child_id,
          episode_id: p.episode_id,
          initial_rationale: p.rationale,
          proposed_at: e.occurred_at,
          proposal_id: p.proposal_id,
          confirmed_at: null,
          revisions: [],
          reassessments: [],
          items: new Map(p.items.map((it) => [it.item_id, { ...it, added_in: "initial" }])),
          adverse_reactions: [],
          compliance_issues: [],
        });
        break;
      }

      case "PLAN_CONFIRMED": {
        const plan = plans.get(p.plan_id);
        if (plan && p.proposal_id === plan.proposal_id) {
          plan.confirmed_at = e.occurred_at;
          plan.consent_ref = p.consent_ref;
          plan.window_ref = p.window_ref;
        }
        break;
      }

      case "PLAN_REVISED": {
        const plan = plans.get(p.plan_id);
        if (!plan) break;
        plan.revisions.push({
          at: e.occurred_at,
          reason: p.reason,
          revision_of: p.revision_of,
          revision_proposal_id: p.revision_proposal_id,
          changes: p.changes,
          evidence_refs: p.evidence_refs ?? [],
          consent_ref: p.consent_ref,
          window_ref: p.window_ref,
          event_id: e.event_id,
        });
        for (const it of p.changes.add ?? []) plan.items.set(it.item_id, { ...it, added_in: e.event_id });
        for (const ref of p.changes.remove ?? []) plan.items.delete(ref);
        for (const adj of p.changes.adjust ?? []) {
          const cur = plan.items.get(adj.item_id);
          if (cur) plan.items.set(adj.item_id, { ...cur, ...adj, adjusted_in: e.event_id });
        }
        plan.consent_ref = p.consent_ref;
        plan.window_ref = p.window_ref;
        break;
      }

      case "PLAN_REASSESSED": {
        plans.get(p.plan_id)?.reassessments.push({
          at: e.occurred_at,
          window_ref: p.window_ref,
          outcome: p.outcome,
          summary: p.summary,
        });
        break;
      }

      case "ADVERSE_REACTION_REPORTED":
        plans.get(p.plan_id)?.adverse_reactions.push({ ...p, at: e.occurred_at });
        break;

      case "COMPLIANCE_ISSUE_REPORTED":
        plans.get(p.plan_id)?.compliance_issues.push({ ...p, at: e.occurred_at });
        break;

      case "CONSENT_GRANTED":
        consentLedgers.get(p.child_id)?.grants.push({
          event_id: e.event_id,
          guardian_id: p.guardian_id,
          purposes: p.purposes.slice(),
          granted_at: p.granted_at,
        });
        break;

      case "CONSENT_WITHDRAWN":
        consentLedgers.get(p.child_id)?.withdrawals.push({
          event_id: e.event_id,
          guardian_id: p.guardian_id,
          purposes: p.purposes.slice(),
          scope: p.scope,
          at: e.occurred_at,
        });
        break;

      case "REFERRAL_ISSUED":
        referrals.push({ ...p, issued_at: e.occurred_at, event_id: e.event_id });
        break;

      default:
        break;
    }
  }

  return { children, episodes, evidence, opinions, risks, windows, plans, consentLedgers, referrals };
}

function currentGuardian(child, at) {
  let g = null;
  for (const x of child?.guardians ?? []) {
    if (x.from <= at && (x.to === null || x.to > at)) g = x;
  }
  return g;
}

// 某条证据在 at 时点对某用途是否仍可用：
// 采集时权限标记 AND 有效授权 AND 未被（面向未来的）撤回排除。
function purposeUsable(ledger, purpose, evidenceRecord, at) {
  if (purpose === "TREATMENT") return true;
  if (evidenceRecord.permissions?.[purpose] === false) return false;
  const granted = (ledger?.grants ?? []).some(
    (g) => g.granted_at <= evidenceRecord.captured_at && g.purposes.includes(purpose),
  );
  if (!granted) return false;
  for (const w of ledger?.withdrawals ?? []) {
    if (w.at > at || !w.purposes.includes(purpose)) continue;
    if (w.scope.evidence_ids?.includes(evidenceRecord.evidence_id)) return false;
    if (w.scope.all_capture_sources?.includes(evidenceRecord.exam_source)) return false;
  }
  return true;
}

const PURPOSE_LABELS = {
  TREATMENT: "诊疗",
  TEACHING: "教学",
  RESEARCH: "科研",
  CROSS_CAMPUS_CONTINUITY: "跨院连续",
};

const REVISION_REASON_LABELS = {
  GROWTH_CHANGE: "发育变化",
  NEW_EVIDENCE: "新证据",
  COMPLIANCE_DIFFICULTY: "依从困难",
  ADVERSE_REACTION: "器械不良反应",
  GUARDIAN_REQUEST: "监护人要求",
};

// —— 家长视图 -----------------------------------------------------

export function buildFamilyView(events, childId, at = new Date().toISOString()) {
  const s = replay(events, at);
  const child = s.children.get(childId);
  if (!child) throw new Error(`未知儿童：${childId}`);
  const guardian = currentGuardian(child, at);

  const childPlans = [...s.plans.values()].filter((p) => p.child_id === childId).sort((a, b) => byTime({ occurred_at: a.proposed_at }, { occurred_at: b.proposed_at }));
  const plan = childPlans.at(-1) ?? null;

  let currentPlan = null;
  const observationReasons = [];
  if (plan) {
    const items = [...plan.items.values()].map((it) => ({ item_id: it.item_id, type: it.type, note: it.note ?? null }));
    const lastReass = plan.reassessments.at(-1);
    let status;
    if (!plan.confirmed_at) status = "PROPOSED_PENDING_CONSENT";
    else if (lastReass?.outcome === "COMPLETE") status = "COMPLETED";
    else if (lastReass?.outcome === "PAUSE") status = "PAUSED";
    else if (items.every((it) => it.type === "OBSERVE")) status = "ACTIVE_OBSERVATION";
    else status = "ACTIVE_TREATMENT";

    currentPlan = {
      plan_id: plan.plan_id,
      status,
      confirmed_at: plan.confirmed_at,
      items,
      rationale: plan.initial_rationale,
      latest_revision: plan.revisions.at(-1)
        ? { reason: plan.revisions.at(-1).reason, at: plan.revisions.at(-1).at }
        : null,
      latest_reassessment: lastReass
        ? { outcome: lastReass.outcome, summary: lastReass.summary, at: lastReass.at }
        : null,
    };

    for (const it of items) if (it.type === "OBSERVE" && it.note) observationReasons.push(it.note);
    if (status === "ACTIVE_OBSERVATION" || items.some((it) => it.type === "OBSERVE")) {
      observationReasons.push(plan.initial_rationale);
    }
    for (const r of plan.revisions) {
      const notes = [
        ...(r.changes.add ?? []).map((x) => x.note),
        ...(r.changes.adjust ?? []).map((x) => x.note),
      ].filter(Boolean);
      if (notes.length) observationReasons.push(`修订（${REVISION_REASON_LABELS[r.reason] ?? r.reason}）：${notes.join("；")}`);
    }
  }

  // 接诊医生中最近的“观察/进一步检查”意见，作为家长可读的观察理由
  const observeOpinions = s.opinions
    .filter((o) => o.kind === "opinion" && o.child_id === childId && (o.stance === "OBSERVE" || o.stance === "INVESTIGATE"))
    .sort((a, b) => byTime({ occurred_at: a.issued_at }, { occurred_at: b.issued_at }));
  const latestObserve = observeOpinions.at(-1);
  if (latestObserve) observationReasons.push(latestObserve.rationale);

  const childWindows = s.windows
    .filter((w) => w.child_id === childId)
    .sort((a, b) => (a.due_to < b.due_to ? -1 : 1));
  const openWindow = childWindows.filter((w) => !w.completed_at).at(-1) ?? null;
  let nextMilestone = null;
  if (openWindow) {
    nextMilestone = {
      window_id: openWindow.window_id,
      due_from: openWindow.due_from,
      due_to: openWindow.due_to,
      reason: openWindow.reason,
      overdue: Date.parse(at) > Date.parse(`${openWindow.due_to}T23:59:59`),
    };
  }

  const activeRisks = s.risks
    .filter((r) => r.child_id === childId && r.active)
    .map((r) => ({ risk_id: r.risk_id, signal: r.signal, channel: r.channel, severity: r.severity, escalated_at: r.escalated_at }));

  return {
    child: {
      child_id: child.child_id,
      birth_year_month: child.birth_year_month,
      current_guardian_id: guardian?.guardian_id ?? null,
    },
    current_plan: currentPlan,
    observation_reasons: [...new Set(observationReasons.filter(Boolean))],
    next_milestone: nextMilestone,
    active_risks: activeRisks,
    as_of: at,
  };
}

// —— 接诊医生视图 --------------------------------------------------

export function buildClinicianView(events, childId, at = new Date().toISOString()) {
  const s = replay(events, at);
  const child = s.children.get(childId);
  if (!child) throw new Error(`未知儿童：${childId}`);
  const ledger = s.consentLedgers.get(childId);

  const childEvidence = [...s.evidence.values()]
    .filter((e) => e.child_id === childId)
    .sort((a, b) => (a.captured_at < b.captured_at ? -1 : 1));

  const opinionById = new Map(s.opinions.filter((o) => o.kind === "opinion").map((o) => [o.opinion_id, o]));

  const evidenceByStage = [];
  for (const stage of ["PRIMARY_DENTITION", "MIXED_DENTITION", "PERMANENT_DENTITION"]) {
    const rows = childEvidence.filter((e) => e.dentition_stage === stage).map((e) => ({
      evidence_id: e.evidence_id,
      kind: e.kind,
      exam_source: e.exam_source,
      campus_id: e.campus_id,
      captured_at: e.captured_at,
      opinions: e.opinions.map((id) => {
        const o = opinionById.get(id);
        return o ? { opinion_id: o.opinion_id, clinician_id: o.clinician_id, stance: o.stance, rationale: o.rationale, issued_at: o.issued_at } : null;
      }).filter(Boolean),
      usable_for: Object.fromEntries(
        ["TREATMENT", "TEACHING", "RESEARCH", "CROSS_CAMPUS_CONTINUITY"].map((purpose) => [
          purpose,
          purposeUsable(ledger, purpose, e, at),
        ]),
      ),
    }));
    if (rows.length) evidenceByStage.push({ dentition_stage: stage, label: stageLabel(stage), evidence: rows });
  }

  const plans = [...s.plans.values()]
    .filter((p) => p.child_id === childId)
    .sort((a, b) => (a.proposed_at < b.proposed_at ? -1 : 1))
    .map((p) => ({
      plan_id: p.plan_id,
      episode_id: p.episode_id,
      proposed_at: p.proposed_at,
      confirmed_at: p.confirmed_at,
      initial: { proposal_id: p.proposal_id, rationale: p.initial_rationale, items: [...p.items.values()].map((it) => ({ item_id: it.item_id, type: it.type })) },
      revisions: p.revisions.map((r) => ({
        at: r.at,
        reason: r.reason,
        revision_of: r.revision_of,
        added: (r.changes.add ?? []).map((it) => it.item_id),
        removed: r.changes.remove ?? [],
        adjusted: (r.changes.adjust ?? []).map((a) => a.item_id),
        evidence_refs: r.evidence_refs,
      })),
      current_items: [...p.items.values()].map((it) => ({ item_id: it.item_id, type: it.type, note: it.note ?? null })),
      reassessments: p.reassessments,
      adverse_reactions: p.adverse_reactions,
      compliance_issues: p.compliance_issues,
    }));

  const ledgerView = {
    grants: ledger?.grants ?? [],
    withdrawals: ledger?.withdrawals ?? [],
  };

  const usableCatalog = Object.fromEntries(
    ["TREATMENT", "TEACHING", "RESEARCH", "CROSS_CAMPUS_CONTINUITY"].map((purpose) => [
      purpose,
      childEvidence.filter((e) => purposeUsable(ledger, purpose, e, at)).map((e) => e.evidence_id),
    ]),
  );

  return {
    child: { child_id: child.child_id, birth_year_month: child.birth_year_month },
    episodes: [...s.episodes.values()].filter((ep) => ep.child_id === childId),
    evidence_by_stage: evidenceByStage,
    observations: s.opinions.filter((o) => o.kind === "observation" && o.child_id === childId),
    plans,
    risks: s.risks.filter((r) => r.child_id === childId),
    referrals: s.referrals.filter((r) => r.child_id === childId),
    consent_ledger: ledgerView,
    usable_evidence: usableCatalog,
    purpose_labels: PURPOSE_LABELS,
    as_of: at,
  };
}

function stageLabel(stage) {
  return { PRIMARY_DENTITION: "乳牙列期", MIXED_DENTITION: "混合牙列期", PERMANENT_DENTITION: "恒牙列期" }[stage];
}

// —— 双通道分级处置 ------------------------------------------------

export function buildTriageQueues(events, at = new Date().toISOString()) {
  const s = replay(events, at);
  const urgent = [];
  const routine = [];
  for (const r of s.risks.filter((x) => x.active)) {
    const row = {
      child_id: r.child_id,
      risk_id: r.risk_id,
      episode_id: r.episode_id,
      signal: r.signal,
      severity: r.severity,
      escalated_at: r.escalated_at,
      days_open: Math.floor((Date.parse(at) - Date.parse(r.escalated_at)) / 86400000),
    };
    (r.channel === "URGENT_DENTAL" ? urgent : routine).push(row);
  }

  // “先观察”不等于无需复诊：到窗未完成进入提醒队列。
  const overdueFollowups = s.windows
    .filter((w) => !w.completed_at && Date.parse(at) > Date.parse(`${w.due_to}T23:59:59`))
    .map((w) => ({
      child_id: w.child_id,
      window_id: w.window_id,
      episode_id: w.episode_id,
      due_to: w.due_to,
      reason: w.reason,
      days_overdue: Math.floor((Date.parse(at) - Date.parse(`${w.due_to}T23:59:59`)) / 86400000),
    }));

  const overlap = urgent.filter((u) => routine.some((r) => r.risk_id === u.risk_id));
  if (overlap.length) throw new Error("分级队列出现重叠，违反双通道路由不变量");

  return {
    urgent_dental: urgent.sort((a, b) => (a.escalated_at < b.escalated_at ? -1 : 1)),
    routine_orthodontic: routine.sort((a, b) => (a.escalated_at < b.escalated_at ? -1 : 1)),
    overdue_followups: overdueFollowups.sort((a, b) => (a.due_to < b.due_to ? -1 : 1)),
    as_of: at,
  };
}
