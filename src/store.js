// 仅追加事件存储：结构校验之外的跨事件不变量都在这里。
//
// 关键约束：
// - 每个聚合的 version 必须从 1 连续递增；event_id 全局唯一；事件只追加，不改写。
// - 引用必须存在且指向同一儿童：证据、意见、方案、复诊窗、同意、转诊。
// - 方案确认必须同时具备：人工提出的方案、监护人知情同意（TREATMENT）、下一复诊窗。
// - 修订只能追加在已确认方案之后，并保留 revision_of 指向原提案；原判断不被覆盖。
// - 器械不良反应 / 依从困难必须挂在已确认方案上，并作为后续修订的依据。
// - 授权与撤回按监护人在当时是否具有监护资格、按时间线生效；撤回只面向未来用途。
import { EXAM_SOURCES, FINDING_CATEGORIES, FOLLOWUP_OUTCOMES } from "./catalog.js";
import { validateEvent } from "./validator.js";

export class DomainValidationError extends Error {
  constructor(errors) {
    super(errors.join("；"));
    this.name = "DomainValidationError";
    this.errors = errors;
  }
}

export class EventStore {
  #events = [];
  #ids = new Set();
  #aggVersion = new Map();
  #aggLastAt = new Map();

  #children = new Map(); // child_id -> { registeredAt, guardians: [{guardian_id, from, to}] }
  #episodes = new Map(); // episode_id -> { child_id, openedAt, windows, risks }
  #evidence = new Map(); // evidence_id -> event
  #opinions = new Set();
  #plans = new Map(); // plan_id -> plan ledger
  #consents = new Map(); // child_id -> { grants: [], withdrawals: [] }

  events() {
    return this.#events.slice();
  }

  append(record) {
    const errors = validateEvent(record);
    if (errors.length) throw new DomainValidationError(errors);
    this.#checkUniquenessAndVersion(record, errors);
    if (record.payload) this.#checkInvariants(record, errors);
    if (errors.length) throw new DomainValidationError(errors);

    this.#apply(record);
    return record;
  }

  #checkUniquenessAndVersion(record, errors) {
    if (this.#ids.has(record.event_id)) errors.push(`event_id 重复：${record.event_id}`);
    const next = (this.#aggVersion.get(record.aggregate_id) ?? 0) + 1;
    if (record.version !== next) {
      errors.push(`${record.aggregate_id} 的 version 必须连续递增：期望 ${next}，收到 ${record.version}`);
    }
    const lastAt = this.#aggLastAt.get(record.aggregate_id);
    if (lastAt && record.occurred_at < lastAt) {
      errors.push("同一聚合内 occurred_at 不得早于上一事件（历史只能追加，不能插写）");
    }
  }

  // ——————————————————————————————————————————————————————————

  #child(childId) {
    return this.#children.get(childId);
  }

  #requireChild(p, errors) {
    const child = this.#child(p.child_id);
    if (!child) errors.push(`儿童 ${p.child_id} 尚未建档（缺少 CHILD_REGISTERED）`);
    return child;
  }

  #requireEpisode(p, errors) {
    const ep = this.#episodes.get(p.episode_id);
    if (!ep) {
      errors.push(`随访主线 ${p.episode_id} 尚未开启（缺少 EPISODE_OPENED）`);
      return null;
    }
    if (ep.child_id !== p.child_id) errors.push(`episode ${p.episode_id} 不属于儿童 ${p.child_id}`);
    return ep;
  }

  #activeGuardianAt(childId, at) {
    const child = this.#children.get(childId);
    if (!child) return null;
    let current = null;
    for (const g of child.guardians) {
      if (g.from <= at && (g.to === null || g.to > at)) current = g.guardian_id;
    }
    return current;
  }

  #purposeActive(childId, purpose, at, evidenceId = null, source = null) {
    const ledger = this.#consents.get(childId);
    if (!ledger) return false;
    let granted = false;
    for (const g of ledger.grants) {
      if (g.at <= at && g.purposes.includes(purpose)) granted = true;
    }
    if (!granted) return false;
    // 证据尚未入索引时（校验 EVIDENCE_CAPTURED 自身）由调用方传入来源。
    const ev = evidenceId ? this.#evidence.get(evidenceId) : null;
    const examSource = source ?? ev?.payload.exam_source ?? null;
    // 撤回只约束撤回时点之后的使用，不追溯改写已发生的诊疗记录。
    for (const w of ledger.withdrawals) {
      if (w.at > at || !w.purposes.includes(purpose)) continue;
      if (evidenceId && w.scope.evidence_ids?.includes(evidenceId)) return false;
      if (examSource && w.scope.all_capture_sources?.includes(examSource)) return false;
    }
    return true;
  }

  #findConsentGrant(consentRef, childId, guardianId, at) {
    const ledger = this.#consents.get(childId);
    if (!ledger) return null;
    return ledger.grants.find(
      (g) => g.eventId === consentRef && g.guardianId === guardianId && g.at <= at && g.purposes.includes("TREATMENT"),
    );
  }

  #checkInvariants(e, errors) {
    const p = e.payload;
    switch (e.event_type) {
      case "CHILD_REGISTERED":
        if (this.#children.has(p.child_id)) errors.push(`儿童 ${p.child_id} 已存在建档事件`);
        break;

      case "GUARDIAN_LINKED": {
        const child = this.#requireChild(p, errors);
        if (child?.guardians.some((g) => g.guardian_id === p.guardian_id && g.from <= e.occurred_at && (g.to === null || g.to > e.occurred_at))) {
          errors.push(`监护人 ${p.guardian_id} 已与该儿童处于有效监护关系`);
        }
        const current = this.#activeGuardianAt(p.child_id, e.occurred_at);
        if (current && current !== p.guardian_id) {
          errors.push("已存在其他现任监护人；更换监护人必须使用 GUARDIAN_CHANGED 并保留临床连续性说明");
        }
        break;
      }

      case "GUARDIAN_CHANGED": {
        const child = this.#requireChild(p, errors);
        if (!child) break;
        const current = this.#activeGuardianAt(p.child_id, e.occurred_at);
        if (current !== p.previous_guardian_id) {
          errors.push(`变更时点的现任监护人应为 ${p.previous_guardian_id}，实际为 ${String(current)}`);
        }
        if (p.previous_guardian_id === p.new_guardian_id) errors.push("新旧监护人不能相同");
        if (child.guardians.some((g) => g.guardian_id === p.new_guardian_id && g.from <= e.occurred_at && (g.to === null || g.to > e.occurred_at))) {
          errors.push(`新监护人 ${p.new_guardian_id} 已是有效监护人`);
        }
        break;
      }

      case "EPISODE_OPENED":
        this.#requireChild(p, errors);
        if (this.#episodes.has(e.aggregate_id)) errors.push(`随访主线 ${e.aggregate_id} 已开启`);
        break;

      case "EVIDENCE_CAPTURED": {
        const child = this.#requireChild(p, errors);
        const ep = this.#requireEpisode(p, errors);
        if (child && ep?.child_id !== p.child_id) errors.push("证据的 episode 与 child 不匹配");
        if (this.#evidence.has(p.evidence_id)) errors.push(`evidence_id 重复：${p.evidence_id}`);
        if (p.captured_at > e.occurred_at) errors.push("证据采集时间不能晚于事件记录时间");
        for (const purpose of ["TEACHING", "RESEARCH", "CROSS_CAMPUS_CONTINUITY"]) {
          if (p.permissions[purpose] === true && !this.#purposeActive(p.child_id, purpose, p.captured_at, p.evidence_id, p.exam_source)) {
            errors.push(`证据标记 ${purpose} 用途时，必须已有该用途且在采集时点有效的知情同意`);
          }
        }
        break;
      }

      case "OBSERVATION_RECORDED": {
        this.#requireChild(p, errors);
        this.#requireEpisode(p, errors);
        if (!Array.isArray(p.findings) || p.findings.length === 0) {
          errors.push("findings 必须是非空数组（没有阳性发现也应明确记录未发现）");
        } else {
          for (const [i, f] of p.findings.entries()) {
            if (f === null || typeof f !== "object" || !FINDING_CATEGORIES.includes(f.category)) {
              errors.push(`findings[${i}].category 必须是 ${FINDING_CATEGORIES.join(" / ")} 之一`);
            }
            if (f && typeof f.detail !== "string") errors.push(`findings[${i}].detail 必须是文字描述（系统只整理证据，不输出诊断码）`);
            if (f && typeof f.present !== "boolean") errors.push(`findings[${i}].present 必须是布尔值`);
          }
        }
        if (typeof p.observer_id !== "string" || !p.observer_id) errors.push("observer_id 必须是非空字符串");
        if (typeof p.campus_id !== "string" || !p.campus_id) errors.push("campus_id 必须是非空字符串");
        break;
      }

      case "OPINION_ISSUED": {
        this.#requireChild(p, errors);
        this.#requireEpisode(p, errors);
        if (this.#opinions.has(p.opinion_id)) errors.push(`opinion_id 重复：${p.opinion_id}`);
        for (const ref of p.evidence_refs ?? []) {
          const ev = this.#evidence.get(ref);
          if (!ev) errors.push(`意见引用了不存在的证据：${ref}`);
          else if (ev.payload.child_id !== p.child_id) errors.push(`意见不能引用其他儿童的证据：${ref}`);
        }
        // 同一证据允许多位医生并存：opinion_id 唯一即可，不限制 clinician_id/evidence_refs 组合。
        break;
      }

      case "RISK_ESCALATED": {
        const ep = this.#requireEpisode(p, errors);
        if (ep?.risks.has(p.risk_id)) errors.push(`风险 ${p.risk_id} 已在升级队列中，需先 RISK_RESOLVED`);
        break;
      }

      case "RISK_RESOLVED": {
        this.#requireChild(p, errors);
        const found = this.#findRisk(p.risk_id, errors);
        if (found && !found.active) errors.push(`风险 ${p.risk_id} 已关闭，不能重复关闭`);
        break;
      }

      case "FOLLOWUP_WINDOW_SCHEDULED": {
        this.#requireChild(p, errors);
        const ep = this.#requireEpisode(p, errors);
        if (ep?.windows.has(p.window_id)) errors.push(`复诊窗 ${p.window_id} 已存在`);
        break;
      }

      case "FOLLOWUP_COMPLETED": {
        this.#requireChild(p, errors);
        const w = this.#findWindowAnywhere(p.window_ref);
        if (!w) {
          errors.push(`复诊窗 ${p.window_ref} 不存在`);
          break;
        }
        const owner = [...this.#episodes.values()].find((ep) => ep.windows.has(p.window_ref));
        if (owner.child_id !== p.child_id) errors.push(`复诊窗 ${p.window_ref} 不属于儿童 ${p.child_id}`);
        if (w.completed) errors.push(`复诊窗 ${p.window_ref} 已完成，不能重复完成（再次到访请开新窗口）`);
        if (!FOLLOWUP_OUTCOMES.includes(p.outcome)) errors.push(`outcome 必须是 ${FOLLOWUP_OUTCOMES.join(" / ")}`);
        if (!(typeof p.completed_at === "string")) errors.push("completed_at 必须是日期时间字符串");
        break;
      }

      case "CONSENT_GRANTED": {
        this.#requireChild(p, errors);
        if (this.#activeGuardianAt(p.child_id, e.occurred_at) !== p.guardian_id) {
          errors.push("作出知情决定的监护人在该时点不具有有效监护关系（监护人更换须先完成 GUARDIAN_CHANGED）");
        }
        break;
      }

      case "CONSENT_WITHDRAWN": {
        this.#requireChild(p, errors);
        if (this.#activeGuardianAt(p.child_id, e.occurred_at) !== p.guardian_id) {
          errors.push("撤回收回决定的监护人在该时点不具有有效监护关系");
        }
        const ledger = this.#consents.get(p.child_id);
        for (const purpose of p.purposes) {
          const everGranted = ledger?.grants.some((g) => g.at <= e.occurred_at && g.purposes.includes(purpose));
          if (!everGranted) errors.push(`用途 ${purpose} 从未被授予，不能撤回`);
        }
        for (const id of p.scope.evidence_ids ?? []) {
          const ev = this.#evidence.get(id);
          if (!ev) errors.push(`撤回指向不存在的证据：${id}`);
          else if (ev.payload.child_id !== p.child_id) errors.push(`撤回不能指向其他儿童的证据：${id}`);
        }
        for (const src of p.scope.all_capture_sources ?? []) {
          if (!EXAM_SOURCES.includes(src)) errors.push(`all_capture_sources 含未知来源：${src}`);
        }
        break;
      }

      case "PLAN_PROPOSED": {
        this.#requireChild(p, errors);
        this.#requireEpisode(p, errors);
        if (this.#plans.has(p.plan_id)) errors.push(`plan_id 重复：${p.plan_id}（修改已确认方案请用 PLAN_REVISED）`);
        for (const ref of p.evidence_refs) {
          const ev = this.#evidence.get(ref);
          if (!ev) errors.push(`方案引用了不存在的证据：${ref}`);
          else if (ev.payload.child_id !== p.child_id) errors.push(`方案不能引用其他儿童的证据：${ref}`);
        }
        break;
      }

      case "PLAN_CONFIRMED": {
        const plan = this.#plans.get(p.plan_id);
        if (!plan) {
          errors.push(`方案 ${p.plan_id} 尚未经 PLAN_PROPOSED 提出，不能确认`);
          break;
        }
        const proposal = plan.proposals.get(p.proposal_id);
        if (!proposal) errors.push(`方案中找不到提案 ${p.proposal_id}`);
        if (proposal?.confirmedAt) errors.push("该提案已确认；重新决定必须基于新提案或 PLAN_REVISED");
        if (this.#activeGuardianAt(p.child_id, e.occurred_at) !== p.decided_by_guardian_id) {
          errors.push("确认方案的监护人在该时点不具有有效监护关系");
        }
        const grant = this.#findConsentGrant(p.consent_ref, p.child_id, p.decided_by_guardian_id, e.occurred_at);
        if (!grant) {
          errors.push("确认方案必须引用由现任监护人在确认前作出、且包含 TREATMENT 用途的知情同意");
        }
        const w = this.#findWindow(p.window_ref, p.child_id);
        if (!w) {
          errors.push("确认方案必须绑定一个已排定的复诊窗（“先观察”也要有下一节点）");
        } else if (w.completed) {
          errors.push("复诊窗已结束，不能作为新确认方案的下一节点");
        }        break;
      }

      case "PLAN_REVISED": {
        const plan = this.#plans.get(p.plan_id);
        if (!plan) {
          errors.push(`方案 ${p.plan_id} 不存在，不能修订`);
          break;
        }
        if (!plan.confirmedProposalId) errors.push("只能修订已确认的方案；未确认提案应重新 PROPOSED");
        if (plan.confirmedProposalId !== p.revision_of) {
          errors.push(`revision_of 必须指向当前生效提案 ${plan.confirmedProposalId}`);
        }
        if (plan.proposals.has(p.revision_proposal_id)) {
          errors.push(`revision_proposal_id 已存在：${p.revision_proposal_id}`);
        }
        if (this.#activeGuardianAt(p.child_id, e.occurred_at) !== p.decided_by_guardian_id) {
          errors.push("确认修订的监护人在该时点不具有有效监护关系");
        }
        const grant = this.#findConsentGrant(p.consent_ref, p.child_id, p.decided_by_guardian_id, e.occurred_at);
        if (!grant) errors.push("修订是一次新的知情决定，必须引用现任监护人作出且包含 TREATMENT 用途的同意");
        const { add, remove, adjust } = p.changes;
        if (!add.length && !remove.length && !adjust.length) errors.push("修订必须包含至少一项 add/remove/adjust");
        for (const ref of remove) {
          if (!plan.itemTypes.has(ref)) errors.push(`修订试图移除方案中不存在的项目：${ref}`);
        }
        for (const adj of adjust) {
          if (adj && !plan.itemTypes.has(adj.item_id)) errors.push(`修订试图调整方案中不存在的项目：${adj.item_id}`);
        }
        for (const item of add) {
          if (item && plan.itemTypes.has(item.item_id)) errors.push(`修订 add 的 item_id 已存在：${item.item_id}`);
        }
        if (p.reason === "ADVERSE_REACTION" && !plan.adverseReactions.some((r) => r.at <= e.occurred_at)) {
          errors.push("以 ADVERSE_REACTION 为由修订前，须先记录 ADVERSE_REACTION_REPORTED");
        }
        if (p.reason === "COMPLIANCE_DIFFICULTY" && !plan.complianceIssues.some((r) => r.at <= e.occurred_at)) {
          errors.push("以 COMPLIANCE_DIFFICULTY 为由修订前，须先记录 COMPLIANCE_ISSUE_REPORTED");
        }
        if ((p.reason === "GROWTH_CHANGE" || p.reason === "NEW_EVIDENCE")) {
          const refs = p.evidence_refs ?? [];
          if (!refs.length) errors.push(`${p.reason} 修订必须在 evidence_refs 中列出确认后新增的证据/观察`);
          for (const ref of refs) {
            const ev = this.#evidence.get(ref);
            if (!ev) errors.push(`修订引用了不存在的证据：${ref}`);
            else if (ev.payload.captured_at <= plan.confirmedAt) errors.push(`证据 ${ref} 采集于方案确认之前，不能作为“新变化”依据`);
          }
        }
        const w = this.#findWindow(p.window_ref, p.child_id);
        if (!w) errors.push("修订必须绑定下一复诊窗");
        else if (w.completed) errors.push("修订绑定的复诊窗已结束，请先排定新窗口");
        break;
      }

      case "PLAN_REASSESSED": {
        const plan = this.#plans.get(p.plan_id);
        if (!plan) {
          errors.push(`方案 ${p.plan_id} 不存在，不能复评`);
          break;
        }
        if (!plan.confirmedProposalId) errors.push("未确认的方案无需复评");
        const w = this.#findWindow(p.window_ref, p.child_id);
        if (!w) errors.push(`复评引用的复诊窗不存在：${p.window_ref}`);
        else if (!w.completed) errors.push("复评必须在对应复诊窗完成（FOLLOWUP_COMPLETED）之后进行");
        break;
      }

      case "ADVERSE_REACTION_REPORTED": {
        const plan = this.#plans.get(p.plan_id);
        if (!plan) errors.push(`方案 ${p.plan_id} 不存在`);
        else if (!plan.confirmedProposalId) errors.push("只能对已确认、已佩戴的方案报告器械不良反应");
        if (plan && !plan.itemTypes.has(p.device_ref)) {
          errors.push(`device_ref ${p.device_ref} 不在当前生效方案的项目中（item_id 须与提案条目一致）`);
        }
        break;
      }

      case "COMPLIANCE_ISSUE_REPORTED": {
        const plan = this.#plans.get(p.plan_id);
        if (!plan) errors.push(`方案 ${p.plan_id} 不存在`);
        else if (!plan.confirmedProposalId) errors.push("只能对已确认方案上报依从困难");
        break;
      }

      case "REFERRAL_ISSUED": {
        const ep = this.#requireEpisode(p, errors);
        if (ep?.child_id !== p.child_id) break;
        if (p.from_campus_id === p.to_campus_id) errors.push("跨院转诊的院区不能相同");
        const ledger = this.#consents.get(p.child_id);
        const grant = ledger?.grants.find(
          (g) => g.at <= e.occurred_at && g.purposes.includes("CROSS_CAMPUS_CONTINUITY"),
        );
        if (!grant) errors.push("转诊必须引用包含 CROSS_CAMPUS_CONTINUITY 用途的知情同意");
        if (p.consent_ref !== grant?.eventId) {
          errors.push("consent_ref 必须指向授予 CROSS_CAMPUS_CONTINUITY 的同意事件");
        }
        for (const purpose of p.purpose_restrictions) {
          if (!this.#purposeActive(p.child_id, purpose, e.occurred_at)) {
            errors.push(`转诊资料限定用途 ${purpose} 在转出时点没有有效授权`);
          }
        }
        for (const ref of p.continuity_package) {
          if (typeof ref !== "string" || !ref) errors.push("continuity_package 条目必须是非空字符串");
          if (this.#evidence.has(ref)) {
            const ev = this.#evidence.get(ref);
            if (ev.payload.child_id !== p.child_id) errors.push(`连续性资料包不能含其他儿童证据：${ref}`);
            if (!ev.payload.permissions.CROSS_CAMPUS_CONTINUITY) {
              errors.push(`证据 ${ref} 未授权 CROSS_CAMPUS_CONTINUITY，不得纳入转诊包`);
            }
          }
        }
        break;
      }

      default:
        // v1 无 payload 事件：只经过结构与版本校验。
        break;
    }
  }

  #findRisk(riskId, errors) {
    for (const ep of this.#episodes.values()) {
      const r = ep.risks.get(riskId);
      if (r) return r;
    }
    errors.push(`风险 ${riskId} 不存在`);
    return null;
  }

  #findWindow(windowId, childId) {
    for (const ep of this.#episodes.values()) {
      if (ep.child_id === childId && ep.windows.has(windowId)) return ep.windows.get(windowId);
    }
    return null;
  }

  #findWindowAnywhere(windowId) {
    for (const ep of this.#episodes.values()) {
      if (ep.windows.has(windowId)) return ep.windows.get(windowId);
    }
    return null;
  }

  // —— 索引应用（只在校验全部通过后执行）——
  #apply(e) {
    this.#events.push(e);
    this.#ids.add(e.event_id);
    this.#aggVersion.set(e.aggregate_id, e.version);
    this.#aggLastAt.set(e.aggregate_id, e.occurred_at);
    const p = e.payload;
    if (!p) return;

    switch (e.event_type) {
      case "CHILD_REGISTERED":
        this.#children.set(p.child_id, { registeredAt: e.occurred_at, guardians: [] });
        this.#consents.set(p.child_id, { grants: [], withdrawals: [] });
        break;

      case "GUARDIAN_LINKED": {
        const child = this.#children.get(p.child_id);
        this.#closeCurrentGuardian(child, e.occurred_at);
        child.guardians.push({ guardian_id: p.guardian_id, from: e.occurred_at, to: null });
        break;
      }

      case "GUARDIAN_CHANGED": {
        const child = this.#children.get(p.child_id);
        this.#closeCurrentGuardian(child, e.occurred_at);
        child.guardians.push({ guardian_id: p.new_guardian_id, from: e.occurred_at, to: null });
        break;
      }

      case "EPISODE_OPENED":
        this.#episodes.set(e.aggregate_id, {
          child_id: p.child_id,
          openedAt: e.occurred_at,
          windows: new Map(),
          risks: new Map(),
        });
        break;

      case "EVIDENCE_CAPTURED":
        this.#evidence.set(p.evidence_id, e);
        break;

      case "OPINION_ISSUED":
        this.#opinions.add(p.opinion_id);
        break;

      case "RISK_ESCALATED": {
        const ep = this.#episodes.get(p.episode_id);
        ep.risks.set(p.risk_id, { riskId: p.risk_id, active: true, at: e.occurred_at, event: e });
        break;
      }

      case "RISK_RESOLVED": {
        const r = this.#findRiskSilent(p.risk_id);
        if (r) r.active = false;
        break;
      }

      case "FOLLOWUP_WINDOW_SCHEDULED": {
        const ep = this.#episodes.get(p.episode_id);
        ep.windows.set(p.window_id, {
          windowId: p.window_id,
          from: p.due_from,
          to: p.due_to,
          reason: p.reason,
          scheduledAt: e.occurred_at,
          completed: null,
        });
        break;
      }

      case "FOLLOWUP_COMPLETED": {
        const w = this.#findWindowSilent(p.window_ref);
        if (w) w.completed = { at: p.completed_at, outcome: p.outcome };
        break;
      }

      case "CONSENT_GRANTED":
        this.#consents.get(p.child_id).grants.push({
          eventId: e.event_id,
          guardianId: p.guardian_id,
          purposes: p.purposes.slice(),
          at: p.granted_at,
        });
        break;

      case "CONSENT_WITHDRAWN":
        this.#consents.get(p.child_id).withdrawals.push({
          eventId: e.event_id,
          guardianId: p.guardian_id,
          purposes: p.purposes.slice(),
          scope: p.scope,
          at: e.occurred_at,
        });
        break;

      case "PLAN_PROPOSED": {
        this.#plans.set(p.plan_id, {
          planId: p.plan_id,
          episodeId: p.episode_id,
          childId: p.child_id,
          proposals: new Map([[p.proposal_id, { proposedAt: e.occurred_at, confirmedAt: null, revised: false }]]),
          confirmedProposalId: null,
          confirmedAt: null,
          itemTypes: new Map(p.items.map((it) => [it.item_id, it.type])),
          revisions: [],
          adverseReactions: [],
          complianceIssues: [],
        });
        break;
      }

      case "PLAN_CONFIRMED": {
        const plan = this.#plans.get(p.plan_id);
        plan.proposals.get(p.proposal_id).confirmedAt = e.occurred_at;
        plan.confirmedProposalId = p.proposal_id;
        plan.confirmedAt = e.occurred_at;
        break;
      }

      case "PLAN_REVISED": {
        const plan = this.#plans.get(p.plan_id);
        plan.revisions.push({
          at: e.occurred_at,
          reason: p.reason,
          from: p.revision_of,
          proposal: p.revision_proposal_id,
          eventId: e.event_id,
        });
        plan.proposals.set(p.revision_proposal_id, { proposedAt: e.occurred_at, confirmedAt: e.occurred_at, revised: true });
        plan.confirmedProposalId = p.revision_proposal_id;
        plan.confirmedAt = e.occurred_at;
        for (const it of p.changes.add) plan.itemTypes.set(it.item_id, it.type);
        for (const ref of p.changes.remove) plan.itemTypes.delete(ref);
        break;
      }

      case "ADVERSE_REACTION_REPORTED":
        this.#plans.get(p.plan_id)?.adverseReactions.push({ at: e.occurred_at, deviceRef: p.device_ref });
        break;

      case "COMPLIANCE_ISSUE_REPORTED":
        this.#plans.get(p.plan_id)?.complianceIssues.push({ at: e.occurred_at });
        break;
    }
  }

  #closeCurrentGuardian(child, at) {
    const open = child.guardians.find((g) => g.to === null);
    if (open) open.to = at;
  }

  #findRiskSilent(riskId) {
    for (const ep of this.#episodes.values()) {
      if (ep.risks.has(riskId)) return ep.risks.get(riskId);
    }
    return null;
  }

  #findWindowSilent(windowId) {
    for (const ep of this.#episodes.values()) {
      if (ep.windows.has(windowId)) return ep.windows.get(windowId);
    }
    return null;
  }
}
