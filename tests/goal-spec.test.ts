import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFreeFormGoal } from "../src/discovery/goal-spec.js";

test("free-form goal parser builds an explicit typed contract", () => {
  const spec = parseFreeFormGoal({
    goal: "Look up member 12345 and read their savings balance",
    name: "member.read_savings_balance",
    input: "memberId:string:sensitive=^\\d{3,10}$",
    output: "savingsBalance:currency:sensitive",
    value: "memberId=12345",
  });
  assert.equal(spec.goal, "Look up member 12345 and read their savings balance");
  assert.deepEqual(spec.inputs[0], {
    name: "memberId", type: "string", required: true,
    description: "Invocation value for memberId", sensitive: true, pattern: "^\\d{3,10}$",
  });
  assert.equal(spec.outputs[0]?.type, "currency");
  assert.equal(spec.inputValues.memberId, "12345");
});

test("free-form goal parser rejects malformed input types clearly", () => {
  assert.throws(
    () => parseFreeFormGoal({ goal: "Do a thing", input: "memberId:uuid", value: "memberId=1" }),
    /Unknown input type "uuid".*string, number, boolean, currency/
  );
});

test("free-form goals with no declared inputs derive a stable capability name", () => {
  const spec = parseFreeFormGoal({ goal: "Read the service status banner" });
  assert.equal(spec.name, "custom.read_the_service_status_banner");
  assert.equal(spec.inputs.length, 0);
  assert.equal(spec.derivedName, true);
});
