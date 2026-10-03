import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AGGREGATES,
  EVENT_AGGREGATE,
  EVENT_TYPES,
  PAYLOAD_REQUIRED,
  V1_EVENT_TYPES,
} from "../src/catalog.js";
import { validateEvent } from "../src/validator.js";
import { buildScenario, IDS } from "../examples/scenario.js";

test("v1 最小信封样例仍然合法（向后兼容）", async () => {
  const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.deepEqual(validateEvent(sample), []);
});

test("schema 与目录的事件枚举一致", async () => {
  const schema = JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(new Set(schema.properties.event_type.enum), new Set(Object.values(EVENT_TYPES)));
  assert.deepEqual(new Set(schema.properties.aggregate_type.enum), new Set(Object.values(AGGREGATES)));
  // 每个事件都能归属到聚合，且每个事件都有 payload 必填清单
  for (const type of Object.values(EVENT_TYPES)) {
    assert.ok(EVENT_AGGREGATE[type], `${type} 缺少聚合归属`);
    assert.ok(Array.isArray(PAYLOAD_REQUIRED[type]), `${type} 缺少 payload 清单`);
  }
  // v1 五类事件必须始终保留
  for (const t of ["OBSERVATION_RECORDED", "OPINION_ISSUED", "PLAN_CONFIRMED", "RISK_ESCALATED", "FOLLOWUP_COMPLETED"]) {
    assert.ok(V1_EVENT_TYPES.has(t));
  }
});

test("完整故事的 35 条事件全部通过结构校验", async () => {
  const { events } = buildScenario();
  assert.equal(events.length, 35);
  for (const [i, e] of events.entries()) {
    const errors = validateEvent(e);
    assert.deepEqual(errors, [], `第 ${i} 条 ${e.event_type} 校验失败：${errors.join("；")}`);
  }
});

test("静态样例文件与代码生成结果一致", async () => {
  const saved = JSON.parse(await readFile(new URL("../data/sample-events.json", import.meta.url), "utf8"));
  const { events } = buildScenario();
  assert.deepEqual(saved, events);
  assert.ok(saved.every((e) => e.subject_id === IDS.child));
});
