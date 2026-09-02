/**
 * @agents-index Unit tests for metrics.emitter: verifies token and cost counters
 *   are derived from an assistant message_end usage payload, and that the commit
 *   and pull-request counters fire on matching bash tool results.
 *
 * Why: these are the derivation rules that reconstruct Claude Code's metric
 * inventory from pi lifecycle events (FR6); testing them against a capturing fake
 * Meter pins the value/attribute mapping and the bash heuristics without a backend.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { loadConfig } from "./config.env.ts";
import { MetricsEmitter } from "./metrics.emitter.ts";

/** One recorded counter increment. */
interface Add {
  value: number;
  attrs: Record<string, unknown>;
}

/** Build a MetricsEmitter wired to a fake Meter that records every add() by name. */
function makeEmitter(env: Record<string, string> = { PI_AGENT_ENABLE_TELEMETRY: "1" }) {
  const adds = new Map<string, Add[]>();
  const meter = {
    createCounter: (name: string) => ({
      add: (value: number, attrs: Record<string, unknown>) => {
        const list = adds.get(name) ?? [];
        list.push({ value, attrs });
        adds.set(name, list);
      },
    }),
  };
  const provider = { getMeter: () => meter } as never;
  return { emitter: new MetricsEmitter(provider, loadConfig(env)), adds };
}

test("token-and-cost-from-usage", () => {
  const { emitter, adds } = makeEmitter();
  emitter.recordMessageEnd({
    message: {
      role: "assistant",
      model: "gemini-3.5-flash",
      usage: { input: 23, output: 19, cacheRead: 5, cacheWrite: 0, cost: { total: 0.0019 } },
    },
  } as never);

  const tokens = adds.get("pi.token.usage") ?? [];
  const byType = Object.fromEntries(tokens.map((a) => [a.attrs.type, a.value]));
  assert.equal(byType["input"], 23);
  assert.equal(byType["output"], 19);
  assert.equal(byType["cacheRead"], 5);
  assert.equal(byType["cacheCreation"], undefined); // zero is not recorded
  assert.equal(tokens[0]?.attrs.model, "gemini-3.5-flash");

  const cost = adds.get("pi.cost.usage") ?? [];
  assert.equal(cost.length, 1);
  assert.equal(cost[0]?.value, 0.0019);
  assert.equal(cost[0]?.attrs.model, "gemini-3.5-flash");
});

test("commit-and-pr-heuristics", () => {
  const { emitter, adds } = makeEmitter();
  emitter.recordToolResult({
    toolName: "bash",
    isError: false,
    input: { command: "git commit -m 'feat: x'" },
  } as never);
  emitter.recordToolResult({
    toolName: "bash",
    isError: false,
    input: { command: "gh pr create --fill" },
  } as never);
  // A non-matching bash command increments neither.
  emitter.recordToolResult({
    toolName: "bash",
    isError: false,
    input: { command: "ls -la" },
  } as never);
  // A failed git commit is not counted.
  emitter.recordToolResult({
    toolName: "bash",
    isError: true,
    input: { command: "git commit -m fail" },
  } as never);

  assert.equal((adds.get("pi.commit.count") ?? []).length, 1);
  assert.equal((adds.get("pi.pull_request.count") ?? []).length, 1);
});

test("session-id-distinguishes-runs", () => {
  const env = {
    PI_AGENT_ENABLE_TELEMETRY: "1",
    OTEL_METRICS_INCLUDE_SESSION_ID: "1",
  };
  const first = makeEmitter(env);
  const second = makeEmitter(env);
  first.emitter.recordSessionStart({ reason: "startup" } as never, "pi-run-one");
  second.emitter.recordSessionStart({ reason: "startup" } as never, "pi-run-two");

  const firstIds = (first.adds.get("pi.session.count") ?? []).map((add) => add.attrs["session.id"]);
  const secondIds = (second.adds.get("pi.session.count") ?? []).map((add) => add.attrs["session.id"]);
  assert.deepEqual(firstIds, ["pi-run-one"], "first run keeps its session id");
  assert.deepEqual(secondIds, ["pi-run-two"], "second run keeps its session id");
  assert.notEqual(firstIds[0], secondIds[0], "separate runs must not share a session id");
});
