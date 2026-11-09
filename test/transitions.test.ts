import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { readTransition, sameTransition, TRANSITION_ENTRY_TYPE } from "../src/transitions.ts";

const identity = (id: string, soul: string | null = "faye") => ({ model: { provider: "p", id }, soul });
const snapshot = (session: SessionManager, id: string, soul: string | null = "faye") =>
  session.appendCustomEntry(TRANSITION_ENTRY_TYPE, { version: 1, ...identity(id, soul) });

test("the last well-formed snapshot on the active branch is the identity", () => {
  const session = SessionManager.inMemory();
  assert.equal(readTransition(session.getBranch()), undefined);
  snapshot(session, "a");
  snapshot(session, "b", "reviewer");
  assert.deepEqual(readTransition(session.getBranch()), identity("b", "reviewer"));

  session.appendCustomEntry(TRANSITION_ENTRY_TYPE, { version: 2, model: null, soul: null });
  session.appendCustomEntry(TRANSITION_ENTRY_TYPE, { version: 1, model: { provider: "" }, soul: null });
  session.appendCustomEntry(TRANSITION_ENTRY_TYPE, { version: 1, model: null, soul: "bad name!" });
  assert.deepEqual(readTransition(session.getBranch()), identity("b", "reviewer"));
  snapshot(session, "c", null);
  assert.deepEqual(readTransition(session.getBranch()), identity("c", null));
});

test("identity snapshots compare provider, model and soul", () => {
  assert.equal(sameTransition(identity("a"), identity("a")), true);
  assert.equal(sameTransition(identity("a"), { model: { provider: "q", id: "a" }, soul: "faye" }), false);
  assert.equal(sameTransition(identity("a"), identity("a", "reviewer")), false);
  assert.equal(sameTransition({ model: null, soul: null }, { model: null, soul: null }), true);
});
