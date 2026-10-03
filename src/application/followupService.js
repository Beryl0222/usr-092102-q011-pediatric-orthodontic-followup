// 应用服务：儿童正畸生长随访的全部写操作。
// 边界（与医疗质量团队约定）：
// - 系统只整理证据、管理观察窗口与提醒，不自动诊断、不按年龄给治疗；
//   矫治器只能出现在医生确认的 TREAT 方案中，服务不提供任何年龄→治疗规则。
// - “先观察”必须带观察理由与复诊窗口，防止被理解为无需复诊。
// - 急性牙痛/肿胀等与常规正畸评估走两条互斥升级路径。
// - 一切变化通过追加事件表达；方案修订保留原判断，复评意见单独留存。

import {
  AGGREGATE,
  CONSENT_SCOPE,
  CARIES_STATUS,
  DECISION,
  DENTITION_STAGE,
  EVENT_TYPE,
  HABIT,
  KIND,
  PURPOSE,
  REVISION_TRIGGER,
  RISK_CODE,
  RISK_PATH,
  URGENT_SLA_HOURS,
} from "../domain/codes.js";
import { makeEvent } from "../domain/events.js";
import {
  activeGuardians,
  isPurposeAllowed,
  reduceConsent,
  reduceEpisode,
  reduceObservation,
  reducePlan,
} from "../domain/reducers.js";
import { EventStore, EventValidationError } from "../infrastructure/eventStore.js";

export class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const planAggregateId = (episodeId) => `careplan-${episodeId}`;
const consentAggregateId = (episodeId) => `consent-${episodeId}`;

let seq = 0;
const rid = (prefix) => `${prefix}_${Date.now().toString(36)}_${(seq++).toString(36)}`;

export class FollowupService {
  constructor(store = new EventStore()) {
    this.store = store;
  }

  // ---- 仓储辅助 ----

  #replay(aggregateType, aggregateId, reducer) {
    return this.store.loadAggregate(aggregateType, aggregateId).reduce(reducer, null);
  }

  #loadEpisode(episodeId) {
    const episode = this.#replay(AGGREGATE.GROWTH_EPISODE, episodeId, reduceEpisode);
    if (!episode) throw new DomainError("EPISODE_NOT_FOUND", `随访档案不存在：${episodeId}`);
    return episode;
  }

  #loadConsent(episodeId) {
    return this.#replay(AGGREGATE.CONSENT_SCOPE, consentAggregateId(episodeId), reduceConsent);
  }

  #loadObservation(observationId) {
    const obs = this.#replay(AGGREGATE.CLINICAL_OBSERVATION, observationId, reduceObservation);
    if (!obs) throw new DomainError("OBSERVATION_NOT_FOUND", `检查记录不存在：${observationId}`);
    return obs;
  }

  #loadPlan(episodeId) {
    return this.#replay(AGGREGATE.CARE_PLAN, planAggregateId(episodeId), reducePlan);
  }

  #append(event, expectedVersion) {
    try {
      return this.store.append(event, { expectedVersion });
    } catch (e) {
      if (e instanceof EventValidationError) throw new DomainError("BAD_EVENT", e.message);
      throw e;
    }
  }

  #requireActiveGuardian(episode, guardianId) {
    if (!activeGuardians(episode).some((g) => g.guardian_id === guardianId))
      throw new DomainError("GUARDIAN_NOT_ACTIVE", `该监护人当前无监护关系：${guardianId}`);
  }

  // ---- 建档 / 监护关系 ----

  openEpisode({ episode_id = rid("ep"), child, guardian, site_id, occurred_at }) {
    if (!child?.child_id || !child?.name)
      throw new DomainError("BAD_COMMAND", "child.child_id 与 child.name 必填");
    if (!guardian?.guardian_id || !guardian?.name || !guardian?.relationship)
      throw new DomainError("BAD_COMMAND", "监护人身份、姓名与关系必填");
    if (!site_id) throw new DomainError("BAD_COMMAND", "site_id 必填");

    const event = makeEvent({
      event_type: EVENT_TYPE.OBSERVATION_RECORDED,
      aggregate_type: AGGREGATE.GROWTH_EPISODE,
      aggregate_id: episode_id,
      payload_kind: KIND.EPISODE_OPENED,
      payload: {
        episode_id,
        child,
        guardian,
        site_id,
        summary: `${site_id} 为 ${child.name} 建立正畸生长随访档案`,
      },
      occurred_at,
    });
    return this.#append(event, 0);
  }

  changeGuardian(episodeId, { previous_guardian_id, new_guardian, occurred_at }) {
    const episode = this.#loadEpisode(episodeId);
    if (!episode.guardians.some((g) => g.guardian_id === previous_guardian_id && g.until === null))
      throw new DomainError("GUARDIAN_NOT_ACTIVE", "被更换的监护人不在当前监护关系中");
    if (!new_guardian?.guardian_id || !new_guardian?.name || !new_guardian?.relationship)
      throw new DomainError("BAD_COMMAND", "新监护人身份、姓名与关系必填");
    if (new_guardian.guardian_id === previous_guardian_id)
      throw new DomainError("BAD_COMMAND", "新旧监护人不能相同");

    // 注意：不重置 consent_scope——既有用途限制继续有效（临床连续性与用途限制都保留）
    const event = makeEvent({
      event_type: EVENT_TYPE.OBSERVATION_RECORDED,
      aggregate_type: AGGREGATE.GROWTH_EPISODE,
      aggregate_id: episodeId,
      payload_kind: KIND.GUARDIAN_CHANGED,
      payload: {
        episode_id: episodeId,
        previous_guardian_id,
        new_guardian,
        summary: `监护人由 ${previous_guardian_id} 更换为 ${new_guardian.name}；既有用途限制继续有效`,
      },
      occurred_at,
    });
    return this.#append(event, episode.version);
  }

  // ---- 知情同意与用途限制 ----

  #recordConsent(episodeId, kind, { scopes, purposes, guardian_id, note, occurred_at }) {
    const episode = this.#loadEpisode(episodeId);
    this.#requireActiveGuardian(episode, guardian_id);
    const validScopes = Object.values(CONSENT_SCOPE);
    const validPurposes = Object.values(PURPOSE);
    const badScopes = (scopes ?? []).filter((s) => !validScopes.includes(s));
    const badPurposes = (purposes ?? []).filter((p) => !validPurposes.includes(p));
    if (!scopes?.length || !purposes?.length)
      throw new DomainError("BAD_COMMAND", "scopes 与 purposes 均不能为空");
    if (badScopes.length || badPurposes.length)
      throw new DomainError("BAD_COMMAND", `非法授权范围：${[...badScopes, ...badPurposes].join(",")}`);

    const consentId = consentAggregateId(episodeId);
    const consent = this.#loadConsent(episodeId);
    const event = makeEvent({
      event_type: EVENT_TYPE.OBSERVATION_RECORDED,
      aggregate_type: AGGREGATE.CONSENT_SCOPE,
      aggregate_id: consentId,
      payload_kind: kind,
      payload: {
        episode_id: episodeId,
        child_id: episode.child.child_id,
        scopes,
        purposes,
        guardian_id,
        note: note ?? null,
        summary:
          kind === KIND.CONSENT_GRANTED
            ? `监护人授予 ${purposes.join("/")} 用途`
            : `监护人撤回 ${purposes.join("/")} 用途（资料保留、用途关闭）`,
      },
      occurred_at,
    });
    return this.#append(event, consent?.version ?? 0);
  }

  grantConsent(episodeId, cmd) {
    return this.#recordConsent(episodeId, KIND.CONSENT_GRANTED, cmd);
  }

  withdrawConsent(episodeId, cmd) {
    return this.#recordConsent(episodeId, KIND.CONSENT_WITHDRAWN, cmd);
  }

  // ---- 检查来源 / 影像 / 发现 ----

  recordExam({
    observation_id = rid("obs"),
    episode_id,
    site_id,
    examined_at,
    child_age_months,
    dentition_stage,
    examiner_id,
    source,
  }) {
    const episode = this.#loadEpisode(episode_id);
    if (episode.status === "REFERRED_OUT")
      throw new DomainError("EPISODE_REFERRED_OUT", "档案已转出，不能在本院继续登记检查");
    if (!Object.values(DENTITION_STAGE).includes(dentition_stage))
      throw new DomainError("BAD_COMMAND", `牙列阶段非法：${dentition_stage}`);
    if (!Number.isInteger(child_age_months) || child_age_months < 0)
      throw new DomainError("BAD_COMMAND", "child_age_months 必须是非负整数（月龄仅作记录，不触发治疗规则）");
    if (!examiner_id || !examined_at || !source)
      throw new DomainError("BAD_COMMAND", "examiner_id、examined_at、source 必填");

    const payload = {
      episode_id,
      observation_id,
      site_id: site_id ?? episode.site_id,
      examined_at,
      child_age_months,
      dentition_stage,
      examiner_id,
      source,
    };
    // 检查事件落在 clinical_observation 聚合
    const obsEvent = makeEvent({
      event_type: EVENT_TYPE.OBSERVATION_RECORDED,
      aggregate_type: AGGREGATE.CLINICAL_OBSERVATION,
      aggregate_id: observation_id,
      payload_kind: KIND.EXAM_RECORDED,
      payload: { ...payload, summary: `${source}：${dentition_stage} 阶段检查` },
    });
    this.#append(obsEvent, 0);

    // 在 episode 上留一条引用事件，形成连续档案索引
    const linkEvent = makeEvent({
      event_type: EVENT_TYPE.OBSERVATION_RECORDED,
      aggregate_type: AGGREGATE.GROWTH_EPISODE,
      aggregate_id: episode_id,
      payload_kind: KIND.EXAM_RECORDED,
      payload: { ...payload, summary: `登记检查 ${observation_id}（${dentition_stage}）` },
    });
    this.#append(linkEvent, this.store.versionOf(AGGREGATE.GROWTH_EPISODE, episode_id));
    return obsEvent;
  }

  captureImage({ observation_id, image_id = rid("img"), image_type, taken_at, consent_scope_id }) {
    const obs = this.#loadObservation(observation_id);
    if (!image_type || !taken_at) throw new DomainError("BAD_COMMAND", "image_type、taken_at 必填");
    if (!consent_scope_id) throw new DomainError("BAD_COMMAND", "影像必须挂接 consent_scope 以承接用途限制");
    if (obs.images.some((i) => i.image_id === image_id))
      throw new DomainError("DUPLICATE_IMAGE", `影像已存在：${image_id}`);

    const event = makeEvent({
      event_type: EVENT_TYPE.OBSERVATION_RECORDED,
      aggregate_type: AGGREGATE.CLINICAL_OBSERVATION,
      aggregate_id: observation_id,
      payload_kind: KIND.IMAGE_CAPTURED,
      payload: {
        episode_id: obs.episode_id,
        observation_id,
        image_id,
        image_type,
        taken_at,
        consent_scope_id,
        summary: `采集影像 ${image_id}（${image_type}），用途以 ${consent_scope_id} 为准`,
      },
    });
    return this.#append(event, obs.version);
  }

  recordFindings({ observation_id, caries = [], habits = [], growth = [] }) {
    const obs = this.#loadObservation(observation_id);
    if (!caries.length && !habits.length && !growth.length)
      throw new DomainError("BAD_COMMAND", "至少记录一项发现");
    for (const c of caries) {
      if (!c.tooth_code || !Object.values(CARIES_STATUS).includes(c.status))
        throw new DomainError("BAD_COMMAND", `龋病结论非法：${c.status}`);
    }
    for (const h of habits)
      if (!Object.values(HABIT).includes(h.code))
        throw new DomainError("BAD_COMMAND", `不良习惯非法：${h.code}`);

    const event = makeEvent({
      event_type: EVENT_TYPE.OBSERVATION_RECORDED,
      aggregate_type: AGGREGATE.CLINICAL_OBSERVATION,
      aggregate_id: observation_id,
      payload_kind: KIND.FINDING_RECORDED,
      payload: {
        episode_id: obs.episode_id,
        observation_id,
        caries,
        habits,
        growth,
        recorder_id: obs.examiner_id,
        summary: `记录发现：龋病 ${caries.length} 项、习惯 ${habits.length} 项、生长观察 ${growth.length} 项`,
      },
    });
    return this.#append(event, obs.version);
  }

  // ---- 医生意见（同一影像多意见并存） ----

  issueOpinion({
    observation_id,
    opinion_id = rid("opn"),
    physician_id,
    image_ids = [],
    assessment,
    decision,
    rationale,
    observation_reason,
    followup_window,
    occurred_at,
  }) {
    const obs = this.#loadObservation(observation_id);
    if (!physician_id || !assessment || !rationale)
      throw new DomainError("BAD_COMMAND", "physician_id、assessment、rationale 必填");
    if (!Object.values(DECISION).includes(decision))
      throw new DomainError("BAD_COMMAND", `医生决定非法：${decision}`);

    for (const id of image_ids)
      if (!obs.images.some((i) => i.image_id === id))
        throw new DomainError("IMAGE_NOT_IN_OBSERVATION", `意见引用的影像不属于本次检查：${id}`);

    if (decision === DECISION.OBSERVE) {
      if (!observation_reason)
        throw new DomainError("OBSERVE_NEEDS_REASON", "“先观察”必须写明观察理由，避免被误解为无需处理");
      if (!followup_window?.due_date || Number.isNaN(Date.parse(followup_window.due_date)))
        throw new DomainError("OBSERVE_NEEDS_WINDOW", "“先观察”必须给出复诊窗口（due_date）");
    }

    // 不做任何去重/覆盖：不同医生对同一影像的意见全部保留
    const event = makeEvent({
      event_type: EVENT_TYPE.OPINION_ISSUED,
      aggregate_type: AGGREGATE.CLINICAL_OBSERVATION,
      aggregate_id: observation_id,
      payload_kind: KIND.OPINION_ISSUED,
      payload: {
        episode_id: obs.episode_id,
        observation_id,
        opinion_id,
        physician_id,
        image_ids,
        assessment,
        decision,
        rationale,
        observation_reason: observation_reason ?? null,
        followup_window: followup_window ?? null,
        summary: `${physician_id} 意见：${decision}${decision === "OBSERVE" ? `（${observation_reason}）` : ""}`,
      },
      occurred_at,
    });
    return this.#append(event, obs.version);
  }

  // ---- 风险信号与双升级路径 ----

  escalateRisk({ observation_id, escalation_id = rid("esc"), risk_codes, note, occurred_at }) {
    const obs = this.#loadObservation(observation_id);
    if (!Array.isArray(risk_codes) || risk_codes.length === 0)
      throw new DomainError("BAD_COMMAND", "risk_codes 不能为空");
    const resolved = risk_codes.map((c) => RISK_CODE[c]);
    if (resolved.some((r) => !r))
      throw new DomainError("BAD_COMMAND", `未登记的风险信号：${risk_codes.find((c) => !RISK_CODE[c])}`);

    const paths = new Set(resolved.map((r) => r.path));
    if (paths.size > 1)
      throw new DomainError(
        "MIXED_ESCALATION_PATH",
        "紧急齿科与常规正畸评估不能合并为一次升级，请分别升级",
      );
    const path = [...paths][0];
    const sla_hours = path === RISK_PATH.URGENT_DENTAL ? URGENT_SLA_HOURS : null;

    const event = makeEvent({
      event_type: EVENT_TYPE.RISK_ESCALATED,
      aggregate_type: AGGREGATE.CLINICAL_OBSERVATION,
      aggregate_id: observation_id,
      payload_kind: KIND.RISK_ESCALATED,
      payload: {
        episode_id: obs.episode_id,
        observation_id,
        escalation_id,
        risk_codes,
        path,
        sla_hours,
        status: "OPEN",
        note: note ?? null,
        summary:
          path === RISK_PATH.URGENT_DENTAL
            ? `紧急齿科升级（${URGENT_SLA_HOURS} 小时内）：${risk_codes.join("、")}`
            : `常规正畸评估：${risk_codes.join("、")}，进入复诊窗口管理`,
      },
      occurred_at,
    });
    return this.#append(event, obs.version);
  }

  /** 升级处置完结（仅改变处置状态，临床判断仍以事件留存） */
  resolveEscalation(observationId, escalationId, { status = "RESOLVED", occurred_at } = {}) {
    const obs = this.#loadObservation(observationId);
    const prev = obs.escalations.find((e) => e.escalation_id === escalationId);
    if (!prev) throw new DomainError("ESCALATION_NOT_FOUND", `升级记录不存在：${escalationId}`);
    if (prev.status !== "OPEN") throw new DomainError("ESCALATION_NOT_OPEN", "升级已完结");

    const event = makeEvent({
      event_type: EVENT_TYPE.RISK_ESCALATED,
      aggregate_type: AGGREGATE.CLINICAL_OBSERVATION,
      aggregate_id: observationId,
      payload_kind: KIND.RISK_ESCALATED,
      payload: {
        episode_id: obs.episode_id,
        observation_id: observationId,
        escalation_id: escalationId,
        risk_codes: prev.risk_codes,
        path: prev.path,
        sla_hours: prev.sla_hours,
        status,
        note: null,
        summary: `升级 ${escalationId} 处置完结：${status}`,
      },
      occurred_at,
    });
    const stored = this.#append(event, obs.version);
    // 状态机补记到内存投影：直接由 reducer 再次折叠即可，此处返回事件
    return stored;
  }

  // ---- 方案确认 / 修订与复评 ----

  confirmPlan(cmd) {
    const {
      episode_id,
      plan_id = rid("plan"),
      decision,
      appliance = null,
      rationale,
      observation_reason = null,
      plan_items = [],
      followup_window = null,
      consent_event_ids = [],
      confirming_guardian_id,
      physician_id,
      revises_plan_id = null,
      revision_trigger = null,
      reassessment_opinion_ids = [],
      occurred_at,
    } = cmd;

    const episode = this.#loadEpisode(episode_id);
    this.#requireActiveGuardian(episode, confirming_guardian_id);
    if (!Object.values(DECISION).includes(decision))
      throw new DomainError("BAD_COMMAND", `方案决定非法：${decision}`);
    if (!physician_id || !rationale) throw new DomainError("BAD_COMMAND", "physician_id、rationale 必填");

    if (decision === DECISION.OBSERVE) {
      if (!observation_reason)
        throw new DomainError("PLAN_OBSERVE_NEEDS_REASON", "观察方案必须写明观察理由");
      if (!followup_window?.due_date)
        throw new DomainError("PLAN_OBSERVE_NEEDS_WINDOW", "观察方案必须给出下一复诊节点");
    }
    // 矫治器只能来自医生的治疗决定；服务自身绝无年龄推导
    if (appliance && decision !== DECISION.TREAT)
      throw new DomainError("APPLIANCE_ONLY_WITH_TREAT", "只有 TREAT 方案才能包含矫治器");
    if (decision === DECISION.TREAT && appliance && consent_event_ids.length === 0)
      throw new DomainError("TREAT_NEEDS_INFORMED_CONSENT", "矫治治疗方案必须附知情决定事件");

    const plan = this.#loadPlan(episode_id);
    if (revises_plan_id || revision_trigger) {
      if (!plan) throw new DomainError("NO_PLAN_TO_REVISE", "尚无已确认方案，不能修订");
      if (plan.current.plan_id !== revises_plan_id)
        throw new DomainError("REVISE_STALE_PLAN", "只能修订当前生效方案");
      if (!Object.values(REVISION_TRIGGER).includes(revision_trigger))
        throw new DomainError("BAD_COMMAND", `修订触发原因非法：${revision_trigger}`);
      if (reassessment_opinion_ids.length === 0)
        throw new DomainError("REVISION_NEEDS_REASSESSMENT", "修订必须附复评意见，不能直接覆盖原判断");
    } else if (plan) {
      throw new DomainError("PLAN_EXISTS", "方案已确认；后续变化请走修订与复评");
    }

    const event = makeEvent({
      event_type: EVENT_TYPE.PLAN_CONFIRMED,
      aggregate_type: AGGREGATE.CARE_PLAN,
      aggregate_id: planAggregateId(episode_id),
      payload_kind: KIND.PLAN_CONFIRMED,
      payload: {
        episode_id,
        plan_id,
        decision,
        appliance,
        rationale,
        observation_reason,
        plan_items,
        followup_window,
        consent_event_ids,
        confirming_guardian_id,
        physician_id,
        revises_plan_id,
        revision_trigger,
        reassessment_opinion_ids,
        summary: revises_plan_id
          ? `方案修订（${revision_trigger}）：${plan_id}，原方案 ${revises_plan_id} 留存`
          : `确认方案：${decision}${appliance ? `（${appliance}）` : ""}`,
      },
      occurred_at,
    });
    return this.#append(event, plan?.version ?? 0);
  }

  // ---- 复诊完成 ----

  completeVisit({ episode_id, visit_at, note = null }) {
    const episode = this.#loadEpisode(episode_id);
    if (!visit_at) throw new DomainError("BAD_COMMAND", "visit_at 必填");
    const event = makeEvent({
      event_type: EVENT_TYPE.FOLLOWUP_COMPLETED,
      aggregate_type: AGGREGATE.GROWTH_EPISODE,
      aggregate_id: episode_id,
      payload_kind: KIND.VISIT_COMPLETED,
      payload: { episode_id, visit_at, note, summary: `完成复诊（${visit_at}）` },
    });
    return this.#append(event, episode.version);
  }

  // ---- 跨院转诊：临床连续性 + 用途限制同时保留 ----

  transferReferral({ episode_id, to_site_id, reason, occurred_at }) {
    const episode = this.#loadEpisode(episode_id);
    const consent = this.#loadConsent(episode_id);
    if (episode.status === "REFERRED_OUT")
      throw new DomainError("ALREADY_REFERRED", "档案已转出");
    if (!to_site_id || !reason) throw new DomainError("BAD_COMMAND", "to_site_id、reason 必填");

    // 转诊包：为连续性携带全部诊疗证据；影像仅在 PHOTO×TREATMENT 已授权时随包，
    // 教学/研究授权状态原样随附，接收方必须继续遵守。
    const clinicalEvents = this.store.loadEpisode(episode_id);
    const packet_event_ids = [];
    for (const e of clinicalEvents) {
      if (e.payload.kind === KIND.IMAGE_CAPTURED) {
        if (isPurposeAllowed(consent, CONSENT_SCOPE.PHOTO, PURPOSE.TREATMENT))
          packet_event_ids.push(e.event_id);
        continue;
      }
      packet_event_ids.push(e.event_id);
    }
    const restrictions = {};
    for (const [scope, row] of Object.entries(consent?.matrix ?? {})) {
      for (const [purpose, entry] of Object.entries(row)) {
        if (purpose !== PURPOSE.TREATMENT) restrictions[`${scope}.${purpose}`] = entry.status;
      }
    }

    const event = makeEvent({
      event_type: EVENT_TYPE.FOLLOWUP_COMPLETED,
      aggregate_type: AGGREGATE.GROWTH_EPISODE,
      aggregate_id: episode_id,
      payload_kind: KIND.REFERRAL_TRANSFERRED,
      payload: {
        episode_id,
        from_site_id: episode.site_id,
        to_site_id,
        reason,
        packet_event_ids,
        consent_restrictions: restrictions,
        summary: `跨院转诊至 ${to_site_id}：携带 ${packet_event_ids.length} 条诊疗事件，用途限制随档案保留`,
      },
      occurred_at,
    });
    return this.#append(event, episode.version);
  }
}
