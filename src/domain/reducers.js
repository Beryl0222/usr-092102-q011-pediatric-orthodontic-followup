// 聚合状态重建：从事件流折叠出当前状态，同时保留全部历史。
// 关键不变量：
// - 原始判断永不被覆盖：方案修订追加新版本，原方案留在 history；
// - 同一影像多位医生意见并存：opinions 只增不改；
// - 授权按 scope × purpose 独立生效，撤回只关闭对应用途，不删除诊疗资料；
// - 监护人更换保留完整监护史与既有用途限制。

import { KIND } from "./codes.js";

export function initialState() {
  return null;
}

function requireKind(state, event, expected) {
  if (event.payload.kind !== expected) throw new Error(`意外事件：${event.payload.kind}`);
}

// ---------- growth_episode ----------

export function reduceEpisode(state, event) {
  const p = event.payload;
  switch (p.kind) {
    case KIND.EPISODE_OPENED: {
      if (state) throw new Error("随访档案已建立，不能重复建档");
      return {
        episode_id: p.episode_id,
        child: p.child,
        site_id: p.site_id,
        guardians: [
          {
            guardian_id: p.guardian.guardian_id,
            name: p.guardian.name,
            relationship: p.guardian.relationship,
            since: event.occurred_at,
            until: null,
          },
        ],
        observations: [],
        status: "OPEN",
        referral: null,
        created_at: event.occurred_at,
        version: event.version,
      };
    }
    case KIND.GUARDIAN_CHANGED: {
      requireKind(state, event, KIND.GUARDIAN_CHANGED);
      const guardians = state.guardians.map((g) =>
        g.guardian_id === p.previous_guardian_id && g.until === null
          ? { ...g, until: event.occurred_at }
          : g,
      );
      guardians.push({
        guardian_id: p.new_guardian.guardian_id,
        name: p.new_guardian.name,
        relationship: p.new_guardian.relationship,
        since: event.occurred_at,
        until: null,
      });
      // 既有 consent_scope 与用途限制不随监护人更换而重置（由 consent 聚合自身维护）
      return { ...state, guardians, version: event.version };
    }
    case KIND.EXAM_RECORDED: {
      if (!state.observations.includes(p.observation_id)) {
        return { ...state, observations: [...state.observations, p.observation_id], version: event.version };
      }
      return { ...state, version: event.version };
    }
    case KIND.REFERRAL_TRANSFERRED: {
      return {
        ...state,
        status: "REFERRED_OUT",
        referral: {
          to_site_id: p.to_site_id,
          reason: p.reason,
          transferred_at: event.occurred_at,
          // 用途限制随档案一并带走，接收方只能看到授权允许的资料（在读模型过滤）
          carries_consent_restrictions: true,
          packet_event_ids: p.packet_event_ids ?? [],
        },
        version: event.version,
      };
    }
    case KIND.VISIT_COMPLETED: {
      return { ...state, last_visit_at: event.occurred_at, version: event.version };
    }
    default:
      return { ...state, version: event.version };
  }
}

export const activeGuardians = (episode) =>
  episode ? episode.guardians.filter((g) => g.until === null) : [];

// ---------- clinical_observation（一次检查/复诊遭遇） ----------

export function reduceObservation(state, event) {
  const p = event.payload;
  switch (p.kind) {
    case KIND.EXAM_RECORDED: {
      if (state) throw new Error("检查记录已存在");
      return {
        observation_id: p.observation_id,
        episode_id: p.episode_id,
        site_id: p.site_id,
        examined_at: p.examined_at,
        child_age_months: p.child_age_months,
        dentition_stage: p.dentition_stage,
        examiner_id: p.examiner_id,
        source: p.source, // 门诊检查 / 转诊带入 / 远程随访
        images: [],
        findings: null,
        opinions: [], // 多位医生意见并存，只增不改
        escalations: [],
        created_at: event.occurred_at,
        version: event.version,
      };
    }
    case KIND.IMAGE_CAPTURED: {
      return {
        ...state,
        images: [
          ...state.images,
          {
            image_id: p.image_id,
            image_type: p.image_type, // 口内照 / 面相 / 模型 / X 线
            taken_at: p.taken_at,
            consent_scope_id: p.consent_scope_id,
          },
        ],
        version: event.version,
      };
    }
    case KIND.FINDING_RECORDED: {
      // 发现以事件为证据来源长期保留；同一检查可补充记录，按 event 时间排序
      return {
        ...state,
        findings: {
          caries: [...(state.findings?.caries ?? []), ...(p.caries ?? [])],
          habits: [...(state.findings?.habits ?? []), ...(p.habits ?? [])],
          growth: [...(state.findings?.growth ?? []), ...(p.growth ?? [])],
        },
        version: event.version,
      };
    }
    case KIND.OPINION_ISSUED: {
      return {
        ...state,
        opinions: [
          ...state.opinions,
          {
            opinion_id: p.opinion_id,
            physician_id: p.physician_id,
            image_ids: p.image_ids ?? [],
            assessment: p.assessment,
            decision: p.decision, // TREAT / OBSERVE / REFER
            rationale: p.rationale,
            observation_reason: p.observation_reason ?? null,
            followup_window: p.followup_window ?? null,
            issued_at: event.occurred_at,
          },
        ],
        version: event.version,
      };
    }
    case KIND.RISK_ESCALATED: {
      // 同一 escalation_id 的后续事件是处置状态更新（如 RESOLVED），事件原件仍在日志中
      const existing = state.escalations.find((x) => x.escalation_id === p.escalation_id);
      if (existing && existing.status === "OPEN" && p.status !== "OPEN") {
        return {
          ...state,
          escalations: state.escalations.map((x) =>
            x.escalation_id === p.escalation_id
              ? { ...x, status: p.status, resolved_at: event.occurred_at }
              : x,
          ),
          version: event.version,
        };
      }
      if (existing) throw new Error(`升级记录 ${p.escalation_id} 已完结或重复`);
      return {
        ...state,
        escalations: [
          ...state.escalations,
          {
            escalation_id: p.escalation_id,
            risk_codes: p.risk_codes,
            path: p.path, // URGENT_DENTAL / ROUTINE_ORTHO
            sla_hours: p.sla_hours ?? null,
            status: p.status,
            note: p.note ?? null,
            escalated_at: event.occurred_at,
          },
        ],
        version: event.version,
      };
    }
    default:
      return { ...state, version: event.version };
  }
}

// ---------- care_plan ----------

export function reducePlan(state, event) {
  const p = event.payload;
  if (p.kind !== KIND.PLAN_CONFIRMED) throw new Error(`care_plan 不接受事件：${p.kind}`);
  const record = {
    plan_id: p.plan_id,
    episode_id: p.episode_id,
    decision: p.decision,
    appliance: p.appliance ?? null, // 仅在医生确认治疗时出现，系统不按年龄推荐
    rationale: p.rationale,
    observation_reason: p.observation_reason ?? null,
    plan_items: p.plan_items ?? [],
    followup_window: p.followup_window ?? null,
    consent_event_ids: p.consent_event_ids ?? [],
    confirming_guardian_id: p.confirming_guardian_id,
    physician_id: p.physician_id,
    revises_plan_id: p.revises_plan_id ?? null,
    revision_trigger: p.revision_trigger ?? null, // 发育变化 / 依从困难 / 器械不良反应
    reassessment_opinion_ids: p.reassessment_opinion_ids ?? [],
    confirmed_at: event.occurred_at,
    event_id: event.event_id,
  };
  if (!state) {
    return {
      care_plan_id: event.aggregate_id,
      episode_id: p.episode_id,
      current: record,
      history: [],
      version: event.version,
    };
  }
  // 修订：原判断完整保留在 history，current 指向新版本
  return {
    ...state,
    current: record,
    history: [...state.history, state.current],
    version: event.version,
  };
}

// ---------- consent_scope（用途限制） ----------

export function reduceConsent(state, event) {
  const p = event.payload;
  const base =
    state ?? {
      consent_scope_id: event.aggregate_id,
      episode_id: p.episode_id,
      child_id: p.child_id,
      // matrix[scope][purpose] = {status, decided_by, at, note}
      matrix: {},
      version: event.version,
    };
  const applyMatrix = (status) => {
    const next = p.scopes.reduce(
      (acc, scope) =>
        p.purposes.reduce(
          (a, purpose) =>
            setMatrixOn(a, scope, purpose, {
              status,
              decided_by: p.guardian_id,
              at: event.occurred_at,
              note: p.note ?? null,
            }),
          acc,
        ),
      base,
    );
    return { ...next, version: event.version };
  };
  if (p.kind === KIND.CONSENT_GRANTED) return applyMatrix("GRANTED");
  if (p.kind === KIND.CONSENT_WITHDRAWN) return applyMatrix("WITHDRAWN");
  throw new Error(`consent_scope 不接受事件：${p.kind}`);
}

function setMatrixOn(state, scope, purpose, entry) {
  const row = { ...(state.matrix[scope] ?? {}) };
  row[purpose] = entry;
  return { ...state, matrix: { ...state.matrix, [scope]: row } };
}

/** 查询某 scope×purpose 当前是否授权（默认未授权） */
export function isPurposeAllowed(consent, scope, purpose) {
  return consent?.matrix?.[scope]?.[purpose]?.status === "GRANTED";
}
