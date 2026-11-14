"use strict";
const { nowIso } = require("./ids");

const STATES = [
  "none",
  "trialing",
  "active",
  "past_due_grace",
  "canceled_pending_end",
  "expired",
  "refunded",
  "disputed_suspended",
];

const ACCESS = new Set(["trialing", "active", "past_due_grace", "canceled_pending_end"]);
const HEALTHY = new Set(["trialing", "active"]);
const TERMINAL = new Set(["none", "expired", "refunded"]);

const TRANSITIONS = {
  none: { payment_success: "active", start_trial: "trialing" },
  trialing: { payment_success: "active", trial_ended_unpaid: "expired" },
  active: {
    payment_success: "active",
    renewal_failed: "past_due_grace",
    cancel: "canceled_pending_end",
    refund: "refunded",
    dispute_opened: "disputed_suspended",
  },
  past_due_grace: {
    payment_success: "active",
    grace_elapsed: "expired",
    cancel: "canceled_pending_end",
    refund: "refunded",
    dispute_opened: "disputed_suspended",
  },
  canceled_pending_end: {
    period_ended: "expired",
    payment_success: "active",
    refund: "refunded",
    dispute_opened: "disputed_suspended",
  },
  disputed_suspended: { dispute_won: "restore", dispute_lost: "lost" },
  expired: {},
  refunded: {},
};

function fail(message) {
  const e = Error(message);
  e.status = 409;
  throw e;
}

function flags(state) {
  return {
    has_pro_access: ACCESS.has(state),
    is_billing_healthy: HEALTHY.has(state),
    is_suspended: state === "disputed_suspended",
    is_terminal: TERMINAL.has(state),
  };
}

function nextState(current, trigger, ctx = {}) {
  if (!STATES.includes(current)) fail("invalid_entitlement_state");
  if (trigger === "start_trial" && process.env.COMMUNITY_PRO_TRIALS !== "1")
    fail("trials_not_enabled");
  if (trigger === "grace_elapsed") {
    if (!/^\d+$/.test(process.env.COMMUNITY_PRO_GRACE_DAYS || ""))
      fail("grace_not_configured");
  }
  const mapped = TRANSITIONS[current]?.[trigger];
  if (!mapped) fail("invalid_entitlement_transition");
  if (mapped === "restore") {
    const prior = ctx.suspended_from;
    if (!prior || !ACCESS.has(prior)) return "expired";
    if (ctx.period_end_at_utc && ctx.now_utc && ctx.now_utc >= ctx.period_end_at_utc)
      return "expired";
    return prior;
  }
  if (mapped === "lost") return ctx.period_lapsed === false ? "refunded" : "expired";
  return mapped;
}

function applyTransition(db, customerRef, trigger, ctx = {}) {
  const now = ctx.now_utc || nowIso();
  let row = db
    .prepare("SELECT * FROM premium_entitlements WHERE customer_ref=?")
    .get(customerRef);
  const current = row?.state || "none";
  const state = nextState(current, trigger, {
    suspended_from: row?.suspended_from || row?.state,
    period_end_at_utc: ctx.period_end_at_utc || row?.period_end_at_utc,
    now_utc: now,
    period_lapsed: ctx.period_lapsed,
  });
  const periodStart = ctx.period_start_at_utc || row?.period_start_at_utc || null;
  const periodEnd = ctx.period_end_at_utc || row?.period_end_at_utc || null;
  const grace =
    state === "past_due_grace" ? now : state === "active" ? null : row?.grace_start_at_utc || null;
  const suspendedFrom = state === "disputed_suspended" ? current : null;
  if (!row) {
    db.prepare(
      `INSERT INTO premium_entitlements VALUES(?,?,?,?,?,?,?,?,?)`,
    ).run(
      require("./ids").newId("ent"),
      customerRef,
      state,
      suspendedFrom,
      periodStart,
      periodEnd,
      grace,
      now,
      now,
    );
  } else {
    db.prepare(
      `UPDATE premium_entitlements SET state=?, suspended_from=?, period_start_at_utc=?, period_end_at_utc=?, grace_start_at_utc=?, updated_at_utc=? WHERE customer_ref=?`,
    ).run(state, suspendedFrom, periodStart, periodEnd, grace, now, customerRef);
  }
  return { state, ...flags(state) };
}

module.exports = { STATES, TRANSITIONS, flags, nextState, applyTransition };
