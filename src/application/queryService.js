// 读模型：同一条事件流向两类角色呈现不同内容。
// - 家长视图：清晰的当前计划、观察理由、下一节点（不暴露教研授权明细以外的内部内容）。
// - 医生视图：各阶段证据并列比较，并按 consent_scope 判断每份资料可用于诊疗/教学/研究中的哪些用途。
// - 复诊提醒：观察窗口与紧急 SLA 都来自事件，逾期即提醒；“先观察”绝不等于无需复诊。

import {
  AGGREGATE,
  CONSENT_SCOPE,
  DECISION,
  KIND,
  PURPOSE,
  PURPOSE_LABEL,
  RISK_PATH,
} from "../domain/codes.js";
import {
  activeGuardians,
  isPurposeAllowed,
  reduceConsent,
  reduceEpisode,
  reduceObservation,
  reducePlan,
} from "../domain/reducers.js";

const MS_DAY = 24 * 60 * 60 * 1000;
const MS_HOUR = 60 * 60 * 1000;

export class FollowupQueries {
  constructor(store) {
    this.store = store;
  }

  #episode(episodeId) {
    const episode = this.store
      .loadAggregate(AGGREGATE.GROWTH_EPISODE, episodeId)
      .reduce(reduceEpisode, null);
    if (!episode) throw new Error(`随访档案不存在：${episodeId}`);
    return episode;
  }

  #consent(episodeId) {
    return this.store
      .loadAggregate(AGGREGATE.CONSENT_SCOPE, `consent-${episodeId}`)
      .reduce(reduceConsent, null);
  }

  #plan(episodeId) {
    return this.store
      .loadAggregate(AGGREGATE.CARE_PLAN, `careplan-${episodeId}`)
      .reduce(reducePlan, null);
  }

  #observations(episode) {
    return episode.observations
      .map((id) =>
        this.store.loadAggregate(AGGREGATE.CLINICAL_OBSERVATION, id).reduce(reduceObservation, null),
      )
      .filter(Boolean)
      .sort((a, b) => a.examined_at.localeCompare(b.examined_at));
  }

  #visitDates(episodeId) {
    return this.store
      .loadAggregate(AGGREGATE.GROWTH_EPISODE, episodeId)
      .filter((e) => e.payload.kind === KIND.VISIT_COMPLETED)
      .map((e) => e.payload.visit_at)
      .sort();
  }

  /** 资料用途矩阵：每份影像/病历资料当前可用的用途列表 */
  #usablePurposes(consent) {
    const matrix = consent?.matrix ?? {};
    const result = {};
    for (const scope of Object.values(CONSENT_SCOPE)) {
      result[scope] = Object.values(PURPOSE).filter((purpose) =>
        isPurposeAllowed(consent, scope, purpose),
      );
    }
    // 病历文本用于诊疗是医疗连续性的固有部分，不依赖额外授权
    result[CONSENT_SCOPE.CLINICAL_RECORD] = [
      ...new Set([PURPOSE.TREATMENT, ...(result[CONSENT_SCOPE.CLINICAL_RECORD] ?? [])]),
    ];
    return result;
  }

  #windows(episode, plan, observations, now) {
    const visits = this.#visitDates(episode.episode_id);
    const windows = [];

    if (plan?.current?.followup_window?.due_date) {
      windows.push({
        due_date: plan.current.followup_window.due_date,
        reason: plan.current.followup_window.reason ?? "当前方案复诊节点",
        source: `care_plan:${plan.current.plan_id}`,
        source_kind: "PLAN",
        issued_at: plan.current.confirmed_at,
      });
    }

    // 观察意见窗口：若该意见之后出现更新的 TREAT/REFER 意见，或已有方案在其后确认，则视为被取代
    for (const obs of observations) {
      for (const op of obs.opinions) {
        if (op.decision !== DECISION.OBSERVE || !op.followup_window?.due_date) continue;
        const supersededOnObs = obs.opinions.some(
          (other) =>
            other.opinion_id !== op.opinion_id &&
            other.issued_at >= op.issued_at &&
            other.decision !== DECISION.OBSERVE,
        );
        const supersededByPlan = plan && plan.current.confirmed_at > op.issued_at;
        windows.push({
          due_date: op.followup_window.due_date,
          reason: op.observation_reason,
          source: `opinion:${op.opinion_id}`,
          source_kind: "OBSERVE_OPINION",
          issued_at: op.issued_at,
          superseded: Boolean(supersededOnObs || supersededByPlan),
        });
      }
    }

    // 紧急升级 SLA 窗口
    for (const obs of observations) {
      for (const esc of obs.escalations) {
        if (esc.status !== "OPEN" || esc.path !== RISK_PATH.URGENT_DENTAL || !esc.sla_hours) continue;
        const due = new Date(new Date(esc.escalated_at).getTime() + esc.sla_hours * MS_HOUR);
        windows.push({
          due_date: due.toISOString(),
          reason: "紧急齿科处置时限",
          source: `escalation:${esc.escalation_id}`,
          source_kind: "URGENT_SLA",
          issued_at: esc.escalated_at,
        });
      }
    }

    for (const w of windows) {
      const visitAfterIssue = visits.some((v) => v >= w.issued_at);
      const dueMs = new Date(w.due_date).getTime();
      if (visitAfterIssue) w.status = "MET";
      else if (now.getTime() > dueMs) w.status = "OVERDUE";
      else if (dueMs - now.getTime() <= 14 * MS_DAY) w.status = "DUE_SOON";
      else w.status = "ON_TRACK";
      if (w.superseded) w.status = "SUPERSEDED";
    }
    return windows;
  }

  // ---------------- 家长视图 ----------------

  buildParentView(episodeId, { now = new Date() } = {}) {
    const episode = this.#episode(episodeId);
    const plan = this.#plan(episodeId);
    const observations = this.#observations(episode);
    const windows = this.#windows(episode, plan, observations, now).filter(
      (w) => w.status !== "SUPERSEDED",
    );

    const openUrgent = observations.flatMap((o) =>
      o.escalations
        .filter((e) => e.status === "OPEN" && e.path === RISK_PATH.URGENT_DENTAL)
        .map((e) => ({
          observation_id: o.observation_id,
          escalation_id: e.escalation_id,
          risk_codes: e.risk_codes,
          due_date: new Date(
            new Date(e.escalated_at).getTime() + (e.sla_hours ?? 0) * MS_HOUR,
          ).toISOString(),
        })),
    );

    const next = windows
      .filter((w) => w.status !== "MET")
      .sort((a, b) => new Date(a.due_date) - new Date(b.due_date))[0];

    const current = plan?.current
      ? {
          plan_id: plan.current.plan_id,
          decision: plan.current.decision,
          appliance: plan.current.appliance,
          rationale: plan.current.rationale,
          observation_reason: plan.current.observation_reason,
          plan_items: plan.current.plan_items,
          confirmed_at: plan.current.confirmed_at,
          revision_of: plan.current.revises_plan_id,
          revision_trigger: plan.current.revision_trigger,
        }
      : null;

    return {
      child: episode.child,
      site_id: episode.site_id,
      guardians: activeGuardians(episode).map((g) => ({ name: g.name, relationship: g.relationship })),
      status: episode.status,
      current_plan: current,
      // 家长明确看到：为什么观察、下次什么时候来——杜绝“观察=不用复诊”的误解
      observation: current?.decision === DECISION.OBSERVE
        ? { reason: current.observation_reason, rationale: current.rationale }
        : null,
      next_milestone: next
        ? { due_date: next.due_date, reason: next.reason, status: next.status, source: next.source }
        : null,
      open_urgent_escalations: openUrgent,
      referral: episode.referral
        ? { to_site_id: episode.referral.to_site_id, reason: episode.referral.reason }
        : null,
      stages_seen: observations.map((o) => ({
        examined_at: o.examined_at,
        dentition_stage: o.dentition_stage,
      })),
    };
  }

  // ---------------- 医生视图 ----------------

  buildPhysicianView(episodeId, { purpose = PURPOSE.TREATMENT, now = new Date() } = {}) {
    const episode = this.#episode(episodeId);
    const consent = this.#consent(episodeId);
    const plan = this.#plan(episodeId);
    const observations = this.#observations(episode);
    const windows = this.#windows(episode, plan, observations, now);
    const usable = this.#usablePurposes(consent);

    const timeline = observations.map((o) => {
      const images = o.images
        .map((img) => ({
          ...img,
          // 该影像在请求用途下是否可用；教研撤回后即从对应用途中消失，但事件仍在档
          usable: isPurposeAllowed(consent, CONSENT_SCOPE.PHOTO, purpose),
          usable_purposes: usable[CONSENT_SCOPE.PHOTO],
        }));
      return {
        observation_id: o.observation_id,
        examined_at: o.examined_at,
        child_age_months: o.child_age_months,
        dentition_stage: o.dentition_stage,
        source: o.source,
        site_id: o.site_id,
        findings: o.findings,
        images,
        // 多位医生对同一影像的意见全部并列，不去重、不覆盖
        opinions: o.opinions,
        escalations: o.escalations,
      };
    });

    return {
      episode_id: episodeId,
      child: episode.child,
      purpose_requested: purpose,
      purpose_label: PURPOSE_LABEL[purpose],
      guardians: episode.guardians,
      stage_timeline: timeline,
      plans: plan
        ? {
            current: plan.current,
            // 修订链：原判断完整可读
            history: plan.history,
          }
        : null,
      followup_windows: windows,
      consent_matrix: Object.fromEntries(
        Object.entries(consent?.matrix ?? {}).map(([scope, row]) => [
          scope,
          Object.fromEntries(
            Object.entries(row).map(([p, e]) => [p, { status: e.status, at: e.at, decided_by: e.decided_by }]),
          ),
        ]),
      ),
      material_usage: Object.fromEntries(
        Object.entries(usable).map(([scope, purposes]) => [
          scope,
          purposes.map((p) => ({ purpose: p, label: PURPOSE_LABEL[p] })),
        ]),
      ),
      referral: episode.referral,
    };
  }

  // ---------------- 全院复诊提醒 ----------------

  listDueWindows({ now = new Date() } = {}) {
    const episodeIds = [
      ...new Set(
        this.store
          .all()
          .filter((e) => e.aggregate_type === AGGREGATE.GROWTH_EPISODE)
          .map((e) => e.aggregate_id),
      ),
    ];
    const reminders = [];
    for (const id of episodeIds) {
      const episode = this.#episode(id);
      if (episode.status === "REFERRED_OUT") continue;
      const plan = this.#plan(id);
      const observations = this.#observations(episode);
      for (const w of this.#windows(episode, plan, observations, now)) {
        if (w.status === "OVERDUE" || w.status === "DUE_SOON") {
          reminders.push({
            episode_id: id,
            child_name: episode.child.name,
            ...w,
          });
        }
      }
    }
    return reminders.sort((a, b) => new Date(a.due_date) - new Date(b.due_date));
  }
}
