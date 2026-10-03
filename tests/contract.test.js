import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateEvent } from "../src/validator.js";
import { checkEnvelope } from "../src/domain/events.js";

test("样例符合领域约定", async () => {
  const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.deepEqual(validateEvent(sample), []);
});

test("随访业务样例同时符合契约与 payload.kind 挂载约定", async () => {
  const sample = JSON.parse(
    await readFile(new URL("../data/sample-followup.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(validateEvent(sample), []);
  assert.deepEqual(checkEnvelope(sample), []);
});
