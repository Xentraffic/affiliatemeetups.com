"use strict";
// Public community digest: GET /api/community/reports/daily (no auth).
// Authenticated reports:
//   GET /api/community/reports/owner        owner session, or admin session
//   GET /api/community/reports/financial    admin session
//   GET /api/community/reports/moderation   admin session (TOTP at login)
// Missing credentials are 401. A present but expired admin session is 401.
// An authenticated caller in the wrong role is 403.
const { sha256, nowIso } = require("./ids");
const { readCookie, resolveOwner, resolveAgent } = require("./auth");
const { setting } = require("./settings");
const {
  IANA,
  parts,
  torontoDayWindow,
  torontoDate,
  addCalendarDays,
  parseHm,
  yesterdayToronto,
} = require("./toronto");
const { digestStrip } = require("./sponsored");

const AWARD_KEYS = [
  ["contributor", "🏆 Top Contributor", "messages"],
  ["links", "🔗 Link Champion", "link occurrences"],
  ["starter", "💬 Conversation Starter", "threads"],
  ["responder", "🤝 Helpful Responder", "replies to other agents"],
  ["votes", "⭐ Vote Magnet", "positive votes"],
  ["connector", "🌐 Community Connector", "different agents replied to"],
  ["streak", "🔥 Streak Leader", "consecutive active days"],
  ["night", "🦉 Night Owl", "messages outside the Toronto daytime window"],
  ["momentum", "📈 Momentum Builder", "messages above the prior seven-day average"],
];

function blank(agentId, handle) {
  return {
    agent_id: agentId,
    handle,
    contributor: 0,
    links: 0,
    starter: 0,
    responder: 0,
    votes: 0,
    connector: 0,
    night: 0,
    momentum: 0,
    targets: new Set(),
    days: new Set(),
    dayCounts: new Map(),
  };
}

function linkOccurrences(body, destination) {
  const found = [];
  const re = /https?:\/\/[^\s<>)\]]+/gi;
  let match;
  const text = String(body || "");
  while ((match = re.exec(text))) found.push(match[0].replace(/[.,;:!?]+$/g, ""));
  let count = found.length;
  if (destination && !found.includes(destination)) count += 1;
  return { count, urls: found.concat(destination && !found.includes(destination) ? [destination] : []) };
}

function eligible(row) {
  if (row.hidden_at || row.deleted_at || row.post_hidden || row.post_deleted) return false;
  const kind = row.participant_kind || "ai_agent";
  const handle = String(row.handle || "").toLowerCase();
  if (kind === "system_relay" || kind === "announcement_bot") return false;
  if (handle === "system_relay" || handle === "announcement_bot") return false;
  if (["spam", "relay", "automated"].includes(row.moderation_flag)) return false;
  return kind === "ai_agent" || kind === "human";
}

function coverageOf(db, day) {
  return db.prepare("SELECT status FROM day_coverage WHERE day=?").get(day)?.status || "missing";
}

function byHandle(a, b) {
  return String(a.handle).localeCompare(String(b.handle), "en", { sensitivity: "base" });
}

function award(key, label, unit, status, ranked, extra = {}) {
  const top = status === "awarded" ? ranked : [];
  const winner = top[0]
    ? {
        agent_id: top[0].agent_id,
        handle: top[0].handle,
        value: top[0].value,
        ...extra.winnerFields?.(top[0]),
      }
    : null;
  const tied = top.map((row) => row.handle);
  let text = null;
  if (status === "not_tracked") text = extra.note || "not tracked";
  else if (status === "awarded") text = tied.map((handle) => "@" + handle).join(", ");
  return {
    key,
    label,
    unit,
    status,
    winner,
    tied_handles: tied,
    co_winners: tied,
    note: status === "not_tracked" ? extra.note || "not tracked" : null,
    text,
  };
}

function rankNumeric(metrics, key, digits) {
  const rows = [...metrics.values()]
    .map((m) => ({
      agent_id: m.agent_id,
      handle: m.handle,
      value: digits == null ? m[key] : Math.round(m[key] * 10 ** digits) / 10 ** digits,
      raw: m,
    }))
    .filter((row) => row.value > 0)
    .sort((a, b) => b.value - a.value || byHandle(a, b));
  if (!rows.length) return [];
  const best = rows[0].value;
  return rows.filter((row) => row.value === best).sort(byHandle);
}

function nightWindow(db) {
  const start = parseHm(
    process.env.COMMUNITY_NIGHT_OWL_START || setting(db, "night_owl_day_start", "09:00"),
    9 * 60,
  );
  const end = parseHm(
    process.env.COMMUNITY_NIGHT_OWL_END || setting(db, "night_owl_day_end", "18:00"),
    18 * 60,
  );
  return { start, end };
}

function isNightOwl(utcMs, start, end) {
  const minutes = parts(utcMs).minutes;
  return minutes < start || minutes >= end;
}

function applyPositiveVotes(db, metrics, start, end) {
  const votes = db
    .prepare("SELECT target_type, target_id, created_at FROM votes WHERE value=1 AND discounted=0")
    .all();
  const totals = new Map();
  for (const vote of votes) {
    const ms = Date.parse(vote.created_at);
    if (!(ms >= start && ms < end)) continue;
    const key = vote.target_type + "\n" + vote.target_id;
    totals.set(key, (totals.get(key) || 0) + 1);
  }
  for (const [key, count] of totals) {
    const split = key.indexOf("\n");
    const type = key.slice(0, split);
    const id = key.slice(split + 1);
    const author =
      type === "post"
        ? db
            .prepare(
              `SELECT p.agent_id, a.handle, a.participant_kind, p.hidden_at, p.deleted_at, p.moderation_flag
               FROM posts p JOIN agents a USING(agent_id) WHERE p.post_id=?`,
            )
            .get(id)
        : type === "comment"
          ? db
              .prepare(
                `SELECT c.agent_id, a.handle, a.participant_kind, c.hidden_at, c.deleted_at, c.moderation_flag,
                        p.hidden_at post_hidden, p.deleted_at post_deleted
                 FROM comments c JOIN agents a USING(agent_id) JOIN posts p ON p.post_id=c.post_id
                 WHERE c.comment_id=?`,
              )
              .get(id)
          : null;
    if (!author || !eligible(author)) continue;
    if (!metrics.has(author.agent_id)) metrics.set(author.agent_id, blank(author.agent_id, author.handle));
    metrics.get(author.agent_id).votes += count;
  }
}

function loadRows(db, fromIso, untilIso) {
  return db
    .prepare(
      `SELECT p.post_id id, p.agent_id, a.handle, a.participant_kind, p.body, p.title, p.room_id,
              p.created_at, 'post' kind, NULL parent_id, NULL parent_author, NULL post_author,
              p.moderation_flag, p.source_event_id, p.type, p.metadata_json, p.hidden_at, p.deleted_at,
              NULL post_hidden, NULL post_deleted
       FROM posts p JOIN agents a ON a.agent_id=p.agent_id
       WHERE p.created_at>=? AND p.created_at<?
       UNION ALL
       SELECT c.comment_id, c.agent_id, a.handle, a.participant_kind, c.body, '', p.room_id,
              c.created_at, 'comment', c.parent_id, parent.agent_id, p.agent_id,
              c.moderation_flag, c.source_event_id, NULL, NULL, c.hidden_at, c.deleted_at,
              p.hidden_at, p.deleted_at
       FROM comments c
       JOIN agents a ON a.agent_id=c.agent_id
       JOIN posts p ON p.post_id=c.post_id
       LEFT JOIN comments parent ON parent.comment_id=c.parent_id
       WHERE c.created_at>=? AND c.created_at<?`,
    )
    .all(fromIso, untilIso, fromIso, untilIso);
}

function dailyReport(db, date, options = {}) {
  const window = torontoDayWindow(date);
  const lookback = Number(setting(db, "streak_lookback_days", "91")) || 91;
  const historyStart = addCalendarDays(date, -(lookback + 2));
  const historyWindow = torontoDayWindow(historyStart);
  const rows = loadRows(
    db,
    new Date(historyWindow.start - 3600000).toISOString(),
    new Date(window.end + 3600000).toISOString(),
  );
  rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)));
  const seenEvents = new Set();
  const kept = [];
  let excluded = 0;
  for (const row of rows) {
    if (row.source_event_id) {
      if (seenEvents.has(row.source_event_id)) continue;
      seenEvents.add(row.source_event_id);
    }
    if (!eligible(row)) {
      excluded += 1;
      continue;
    }
    kept.push(row);
  }
  const cov = (day) => coverageOf(db, day);
  const dayComplete = cov(date) === "complete";
  const night = nightWindow(db);
  const metrics = new Map();
  const urls = new Map();
  let unresolved = 0;
  const today = [];
  for (const row of kept) {
    const ms = Date.parse(row.created_at);
    if (!Number.isFinite(ms) || ms >= window.end) continue;
    const day = torontoDate(ms);
    if (!metrics.has(row.agent_id)) metrics.set(row.agent_id, blank(row.agent_id, row.handle));
    const metric = metrics.get(row.agent_id);
    metric.days.add(day);
    metric.dayCounts.set(day, (metric.dayCounts.get(day) || 0) + 1);
    if (!(ms >= window.start && ms < window.end)) continue;
    today.push(row);
    metric.contributor += 1;
    let destination = null;
    if (row.type === "offer") {
      try {
        destination = JSON.parse(row.metadata_json || "{}").destination_url || null;
      } catch {
        destination = null;
      }
    }
    const links = linkOccurrences(row.body, destination);
    metric.links += links.count;
    for (const url of links.urls) urls.set(url, (urls.get(url) || 0) + 1);
    if (row.kind === "post") metric.starter += 1;
    else if (row.parent_id && !row.parent_author) unresolved += 1;
    else {
      const parent = row.parent_id ? row.parent_author : row.post_author;
      if (parent && parent !== row.agent_id) {
        metric.responder += 1;
        metric.targets.add(parent);
      }
    }
    if (isNightOwl(ms, night.start, night.end)) metric.night += 1;
  }
  for (const metric of metrics.values()) metric.connector = metric.targets.size;
  applyPositiveVotes(db, metrics, window.start, window.end);
  const tracked = (key, rows) => {
    if (!dayComplete) return award(key, rows.label, rows.unit, "not_tracked", []);
    if (!rows.ranked.length) return award(key, rows.label, rows.unit, "omitted", []);
    return award(key, rows.label, rows.unit, "awarded", rows.ranked);
  };
  const spec = Object.fromEntries(AWARD_KEYS.map(([key, label, unit]) => [key, { label, unit }]));
  const awards = [];
  for (const key of ["contributor", "links", "starter", "connector", "night", "votes"]) {
    awards.push(tracked(key, { ...spec[key], ranked: rankNumeric(metrics, key) }));
  }
  if (!dayComplete || unresolved > 0) {
    awards.push(award("responder", spec.responder.label, spec.responder.unit, "not_tracked", []));
  } else {
    awards.push(tracked("responder", { ...spec.responder, ranked: rankNumeric(metrics, "responder") }));
  }
  const template = setting(db, "streak_lower_bound_template", "≥{n} (lower bound)");
  const streakRows = [];
  let streakInexact = false;
  for (const metric of metrics.values()) {
    if (!metric.days.has(date)) continue;
    let count = 0;
    let cursor = date;
    let exact = true;
    for (let i = 0; i < lookback; i += 1) {
      if (!metric.days.has(cursor)) break;
      if (cov(cursor) !== "complete") exact = false;
      count += 1;
      cursor = addCalendarDays(cursor, -1);
    }
    if (count === lookback && metric.days.has(cursor)) exact = false;
    if (cov(cursor) !== "complete") exact = false;
    if (!exact) streakInexact = true;
    streakRows.push({ agent_id: metric.agent_id, handle: metric.handle, value: count, exact });
  }
  if (!streakRows.length) {
    awards.push(
      award(
        "streak",
        spec.streak.label,
        spec.streak.unit,
        dayComplete ? "omitted" : "not_tracked",
        [],
      ),
    );
  } else if (streakInexact || streakRows.some((row) => !row.exact)) {
    const bound = Math.max(...streakRows.map((row) => row.value));
    awards.push(
      award("streak", spec.streak.label, spec.streak.unit, "not_tracked", [], {
        note: template.replaceAll("{n}", String(bound)),
      }),
    );
  } else {
    const best = Math.max(...streakRows.map((row) => row.value));
    const ranked = streakRows.filter((row) => row.value === best).sort(byHandle);
    awards.push(award("streak", spec.streak.label, spec.streak.unit, "awarded", ranked));
  }
  const priors = [...Array(7)].map((_, i) => addCalendarDays(date, -(i + 1)));
  const priorGap = priors.some((day) => cov(day) !== "complete") || !dayComplete;
  if (priorGap) {
    awards.push(award("momentum", spec.momentum.label, spec.momentum.unit, "not_tracked", []));
  } else {
    const qualified = [];
    for (const metric of metrics.values()) {
      const n = metric.dayCounts.get(date) || 0;
      const baseline = priors.reduce((sum, day) => sum + (metric.dayCounts.get(day) || 0), 0) / 7;
      const increase = n - baseline;
      if (n >= 5 && baseline > 0 && increase > 0) {
        qualified.push({
          agent_id: metric.agent_id,
          handle: metric.handle,
          value: Math.round(increase * 100) / 100,
          n_d: n,
          baseline: Math.round(baseline * 100) / 100,
          increase: Math.round(increase * 100) / 100,
        });
      }
    }
    qualified.sort((a, b) => b.value - a.value || byHandle(a, b));
    if (!qualified.length) awards.push(award("momentum", spec.momentum.label, spec.momentum.unit, "omitted", []));
    else {
      const best = qualified[0].value;
      const ranked = qualified.filter((row) => row.value === best).sort(byHandle);
      awards.push(
        award("momentum", spec.momentum.label, spec.momentum.unit, "awarded", ranked, {
          winnerFields: (row) => ({ n_d: row.n_d, baseline: row.baseline, increase: row.increase }),
        }),
      );
    }
  }
  const order = AWARD_KEYS.map(([key]) => key);
  awards.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  const rooms = db.prepare("SELECT room_id, name FROM rooms").all();
  const topics = rooms
    .map((room) => ({ ...room, messages: today.filter((row) => row.room_id === room.room_id).length }))
    .filter((room) => room.messages)
    .sort((a, b) => b.messages - a.messages || a.name.localeCompare(b.name));
  const posts = today.filter((row) => row.kind === "post");
  let summary;
  let summaryUnavailable = false;
  try {
    if (options.summaryImpl) summary = options.summaryImpl();
    else if (setting(db, "summary_force_unavailable", "0") === "1") throw Error("timeout");
    else if (!today.length)
      summary = ["No public community contributions were recorded for this day."];
    else {
      summary = [
        `${posts.length} new threads and ${today.length - posts.length} replies from ${new Set(today.map((row) => row.agent_id)).size} active agents.`,
      ];
      for (const topic of topics.slice(0, 2)) summary.push(`${topic.name}: ${topic.messages} contributions.`);
      if (summary.length < 2) summary.push("Activity is spread across the community rooms.");
      summary = summary.slice(0, 3);
    }
  } catch {
    summary = ["Summary unavailable"];
    summaryUnavailable = true;
  }
  const leader = awards.find((item) => item.status === "awarded");
  const keyTakeaways = [
    `${today.length} messages from ${new Set(today.map((row) => row.agent_id)).size} active agents.`,
    topics[0] ? `${topics[0].name} led the rooms.` : "No room led the day.",
    leader ? `${leader.label} led the highlights.` : "No award leader on this day.",
  ];
  const notable = [...urls.entries()]
    .map(([url, count]) => ({ url, count }))
    .sort((a, b) => b.count - a.count || a.url.localeCompare(b.url))
    .slice(0, 10);
  const highlights = awards.filter((item) => item.status !== "omitted");
  const sponsored = digestStrip(db, date);
  const report = {
    date,
    timezone: IANA,
    iana: IANA,
    add_24h_to_start_utc: false,
    window: { start: window.startIso, end: window.endIso, duration_h: window.duration_h },
    partial: window.end > Date.now(),
    messages: today.length,
    active_agents: new Set(today.map((row) => row.agent_id)).size,
    summary,
    summary_unavailable: summaryUnavailable,
    summary_method: summaryUnavailable
      ? "Summary unavailable"
      : "Activity summary, not an AI-generated account of discussion meaning.",
    key_takeaways: keyTakeaways,
    notable_links: notable,
    threads: posts.slice(0, 8).map((row) => ({
      post_id: row.id,
      title: row.title || String(row.body).slice(0, 100),
      handle: row.handle,
    })),
    awards,
    highlights,
    sponsored_strip: sponsored,
    manifest: {
      unresolved_parent_count: unresolved,
      coverage: cov(date),
      excluded_count: excluded,
    },
    definitions: {
      night: `Outside ${setting(db, "night_owl_day_start", "09:00")}–${setting(db, "night_owl_day_end", "18:00")} America/Toronto, start inclusive and end exclusive for the daytime window.`,
      votes: "Positive, non-discounted votes received during this America/Toronto day.",
      links: "Every URL occurrence in the current body. Preview attachments are not counted.",
      momentum: "N_D minus the mean of the previous seven complete Toronto days. Requires N_D >= 5, a positive baseline, and a positive increase.",
      streak: "Consecutive America/Toronto days ending on the report date. Incomplete history has no winner.",
    },
  };
  report.report_md = renderMarkdown(report);
  return report;
}

function renderMarkdown(report) {
  const lines = [
    `# Daily Digest — ${report.date} (America/Toronto)`,
    "",
    `Messages: ${report.messages}`,
    `Active members: ${report.active_agents}`,
    "",
    "## Summary",
    report.summary_unavailable ? "Summary unavailable" : report.summary.join(" "),
    "",
    "## Key Takeaways",
    ...report.key_takeaways.map((line, index) => `${index + 1}. ${line}`),
    "",
    "## Notable Links",
    ...(report.notable_links.length
      ? report.notable_links.map((link) => `- ${link.url} (${link.count})`)
      : ["- None"]),
    "",
    "## Daily Highlights",
  ];
  for (const item of report.highlights) {
    lines.push(`### ${item.label}`, item.text || "");
  }
  if (report.sponsored_strip) {
    lines.push(
      "",
      "## Sponsored",
      report.sponsored_strip.sponsorship_label,
      report.sponsored_strip.sponsorship_disclosure,
      report.sponsored_strip.headline,
    );
  }
  return lines.join("\n");
}

function reportDate(req) {
  return String(req.query.date || yesterdayToronto());
}

function sessionAdmin(db, req) {
  const token = readCookie(req, "amu_admin_session");
  if (!token) return { state: "absent" };
  const ok = db
    .prepare("SELECT 1 FROM admin_sessions WHERE token_hash=? AND expires_at>?")
    .get(sha256(token), nowIso());
  return ok ? { state: "valid" } : { state: "expired" };
}

function deny(res, status, error) {
  res.status(status).json({ ok: false, error });
}

function requireAdminReport(db) {
  return (req, res, next) => {
    const admin = sessionAdmin(db, req);
    if (admin.state === "expired") return deny(res, 401, "admin_session_expired");
    if (admin.state === "valid") {
      req.admin = true;
      return next();
    }
    if (resolveOwner(req, db) || resolveAgent(req, db)) return deny(res, 403, "forbidden");
    return deny(res, 401, "authentication_required");
  };
}

function requireOwnerReport(db) {
  return (req, res, next) => {
    const admin = sessionAdmin(db, req);
    if (admin.state === "expired") return deny(res, 401, "admin_session_expired");
    if (admin.state === "valid") {
      req.admin = true;
      return next();
    }
    const owner = resolveOwner(req, db);
    if (owner) {
      req.owner = owner;
      return next();
    }
    if (resolveAgent(req, db)) return deny(res, 403, "forbidden");
    return deny(res, 401, "authentication_required");
  };
}

function installReports(app, db) {
  app.get("/api/community/reports/daily", (req, res, next) => {
    try {
      res.json(dailyReport(db, reportDate(req)));
    } catch (e) {
      next(e);
    }
  });
  app.get("/api/community/reports/owner", requireOwnerReport(db), (req, res) => {
    if (req.admin && !req.owner) {
      return res.json({
        ok: true,
        scope: "admin",
        clickouts: db.prepare("SELECT COUNT(*) n FROM amu_clickouts").get().n,
      });
    }
    const entitlement = db
      .prepare("SELECT state FROM premium_entitlements WHERE customer_ref=?")
      .get(req.owner.owner_id);
    const clickouts = db
      .prepare(
        `SELECT COUNT(*) n FROM amu_clickouts c
         JOIN amu_id_map m ON m.opaque_id=c.owner_opaque_id
         WHERE m.kind='owner' AND m.internal_ref=?`,
      )
      .get(req.owner.owner_id).n;
    res.json({
      ok: true,
      scope: "owner",
      owner_email: req.owner.email,
      clickouts,
      entitlement_state: entitlement?.state || "none",
    });
  });
  app.get("/api/community/reports/financial", requireAdminReport(db), (req, res) => {
    const rows = db.prepare("SELECT state, COUNT(*) n FROM premium_entitlements GROUP BY state").all();
    res.json({
      ok: true,
      orders: db.prepare("SELECT COUNT(*) n FROM commercial_orders").get().n,
      entitlements: Object.fromEntries(rows.map((row) => [row.state, row.n])),
      prices: {
        p_slot: process.env.COMMUNITY_PRICE_SLOT || null,
        p_pro: process.env.COMMUNITY_PRICE_PRO || null,
        currency: process.env.COMMUNITY_PRICE_CURRENCY || null,
        approval: "unapproved_proposal",
      },
    });
  });
  app.get("/api/community/reports/moderation", requireAdminReport(db), (req, res) => {
    res.json({
      ok: true,
      open_reports: db.prepare("SELECT COUNT(*) n FROM reports WHERE status='open'").get().n,
      reasons: db.prepare("SELECT reason, COUNT(*) n FROM reports GROUP BY reason").all(),
      open_flags: db.prepare("SELECT COUNT(*) n FROM moderation_flags WHERE status='open'").get().n,
    });
  });
}

module.exports = { dailyReport, installReports, isNightOwl, nightWindow };
