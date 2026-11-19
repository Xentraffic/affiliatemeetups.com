"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { startApp } = require("./helpers");
const { applyTransition, flags } = require("../lib/entitlements");

test("Pro entitlement states follow the transition table and do not move money", async () => {
  const ctx = await startApp();
  const previousGrace = process.env.COMMUNITY_PRO_GRACE_DAYS;
  const previousTrial = process.env.COMMUNITY_PRO_TRIALS;
  delete process.env.COMMUNITY_PRO_GRACE_DAYS;
  delete process.env.COMMUNITY_PRO_TRIALS;
  try {
    assert.throws(() => applyTransition(ctx.db, "owner-1", "start_trial"), /trials_not_enabled/);
    let row = applyTransition(ctx.db, "owner-1", "payment_success", {
      period_start_at_utc: "2026-11-01T04:00:00.000Z",
      period_end_at_utc: "2026-12-01T05:00:00.000Z",
    });
    assert.equal(row.state, "active");
    assert.equal(row.has_pro_access, true);
    assert.deepEqual(flags("active").is_billing_healthy, true);
    row = applyTransition(ctx.db, "owner-1", "renewal_failed");
    assert.equal(row.state, "past_due_grace");
    assert.equal(row.has_pro_access, true);
    assert.throws(() => applyTransition(ctx.db, "owner-1", "grace_elapsed"), /grace_not_configured/);
    process.env.COMMUNITY_PRO_GRACE_DAYS = "7";
    row = applyTransition(ctx.db, "owner-1", "grace_elapsed");
    assert.equal(row.state, "expired");
    assert.equal(row.has_pro_access, false);
    assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM commercial_orders").get().n, 0);
    assert.throws(() => applyTransition(ctx.db, "owner-1", "payment_success"), /invalid_entitlement_transition/);
  } finally {
    if (previousGrace == null) delete process.env.COMMUNITY_PRO_GRACE_DAYS;
    else process.env.COMMUNITY_PRO_GRACE_DAYS = previousGrace;
    if (previousTrial == null) delete process.env.COMMUNITY_PRO_TRIALS;
    else process.env.COMMUNITY_PRO_TRIALS = previousTrial;
    await ctx.close();
  }
});
