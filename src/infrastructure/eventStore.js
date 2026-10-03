// 追加型事件存储：只追加、不改写。
// version 按聚合实例（aggregate_type + aggregate_id）从 1 递增，
// 调用方通过 expectedVersion 做乐观并发控制。
// 入存储前同时跑契约校验（src/validator.js）与信封细分校验（domain/events.js）。

import { validateEvent } from "../validator.js";
import { checkEnvelope } from "../domain/events.js";

export class ConcurrencyError extends Error {
  constructor(aggregateId, expected, actual) {
    super(`聚合 ${aggregateId} 版本冲突：期望 ${expected}，实际 ${actual}`);
    this.code = "CONCURRENCY_ERROR";
    this.expected = expected;
    this.actual = actual;
  }
}

export class EventValidationError extends Error {
  constructor(errors) {
    super(`事件未通过契约校验：${errors.join("；")}`);
    this.code = "EVENT_VALIDATION_ERROR";
    this.errors = errors;
  }
}

export class EventStore {
  #events = [];
  #versionByAggregate = new Map();

  static #key(aggregateType, aggregateId) {
    return `${aggregateType}/${aggregateId}`;
  }

  /**
   * @param {object} event makeEvent 产出的事件（version 为 0）
   * @param {object} [opts]
   * @param {number} [opts.expectedVersion] 调用方看到的聚合版本；新建聚合传 0
   */
  append(event, { expectedVersion } = {}) {
    const contractErrors = validateEvent({ ...event, version: 1 });
    if (contractErrors.length) throw new EventValidationError(contractErrors);

    const envelopeErrors = checkEnvelope({ ...event, version: 1 });
    if (envelopeErrors.length) throw new EventValidationError(envelopeErrors);

    const key = EventStore.#key(event.aggregate_type, event.aggregate_id);
    const current = this.#versionByAggregate.get(key) ?? 0;
    if (expectedVersion !== undefined && expectedVersion !== current) {
      throw new ConcurrencyError(event.aggregate_id, expectedVersion, current);
    }

    const stored = { ...event, version: current + 1 };
    this.#events.push(stored);
    this.#versionByAggregate.set(key, stored.version);
    return stored;
  }

  versionOf(aggregateType, aggregateId) {
    return this.#versionByAggregate.get(EventStore.#key(aggregateType, aggregateId)) ?? 0;
  }

  loadAggregate(aggregateType, aggregateId) {
    return this.#events.filter(
      (e) => e.aggregate_type === aggregateType && e.aggregate_id === aggregateId,
    );
  }

  /** 一次连续档案 = 同一 episode_id 下全部聚合的事件，按发生时间排序 */
  loadEpisode(episodeId) {
    return this.#events
      .filter((e) => e.payload?.episode_id === episodeId)
      .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.version - b.version);
  }

  all() {
    return [...this.#events];
  }
}
