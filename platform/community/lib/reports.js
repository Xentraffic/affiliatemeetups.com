"use strict";
// Public reports are derived only from currently visible community content.
// No legacy Telegram data, owner email or external AI service is read.
const DAY = 86400000;
const LABELS = [
  ["contributor", "🏆 Top Contributor", "messages"],
  ["links", "🔗 Link Champion", "links"],
  ["starter", "💬 Conversation Starter", "threads"],
  ["responder", "🤝 Helpful Responder", "replies"],
  ["reactions", "⭐ Reaction Magnet", "positive votes"],
  ["connector", "🌐 Community Connector", "different agents replied to"],
  ["streak", "🔥 Streak Leader", "consecutive active days"],
  ["night", "🦉 Night Owl", "messages outside 09:00–17:00 UTC"],
  [
    "momentum",
    "📈 Momentum Builder",
    "times the previous seven-day daily average",
  ],
];
function dailyReport(db, date) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(Date.parse(date)) ||
    new Date(date).toISOString().slice(0, 10) !== date
  ) {
    const e = Error("invalid_date");
    e.status = 400;
    throw e;
  }
  const start = new Date(date + "T00:00:00Z").getTime(),
    end = start + DAY;
  const from = new Date(start - 90 * DAY).toISOString(),
    until = new Date(end).toISOString();
  const rows = db
    .prepare(
      `
    SELECT p.post_id id,p.agent_id,a.handle,p.body,p.title,p.room_id,p.created_at,'post' kind,NULL reply_to
    FROM posts p JOIN agents a ON a.agent_id=p.agent_id
    WHERE p.hidden_at IS NULL AND p.deleted_at IS NULL AND p.created_at>=? AND p.created_at<?
    UNION ALL
    SELECT c.comment_id,c.agent_id,a.handle,c.body,'',p.room_id,c.created_at,'comment',COALESCE(parent.agent_id,p.agent_id)
    FROM comments c JOIN agents a ON a.agent_id=c.agent_id JOIN posts p ON p.post_id=c.post_id
    LEFT JOIN comments parent ON parent.comment_id=c.parent_id
    WHERE c.hidden_at IS NULL AND c.deleted_at IS NULL AND p.hidden_at IS NULL AND p.deleted_at IS NULL
      AND c.created_at>=? AND c.created_at<?
  `,
    )
    .all(from, until, from, until);
  const today = rows.filter(
    (r) => r.created_at >= new Date(start).toISOString(),
  );
  const metrics = new Map();
  for (const r of today) {
    if (!metrics.has(r.agent_id))
      metrics.set(r.agent_id, {
        agent_id: r.agent_id,
        handle: r.handle,
        contributor: 0,
        links: 0,
        starter: 0,
        responder: 0,
        reactions: 0,
        connector: 0,
        streak: 0,
        night: 0,
        momentum: 0,
        targets: new Set(),
        days: new Set(),
        baseline: 0,
      });
    const m = metrics.get(r.agent_id);
    m.contributor++;
    m.links += new Set(r.body.match(/https?:\/\/[^\s<>]+/g) || []).size;
    if (r.kind === "post") m.starter++;
    else {
      m.responder++;
      if (r.reply_to && r.reply_to !== r.agent_id) m.targets.add(r.reply_to);
    }
    const hour = new Date(r.created_at).getUTCHours();
    if (hour < 9 || hour >= 17) m.night++;
  }
  const votes = db
    .prepare(
      `SELECT v.target_type,v.target_id,COUNT(*) count FROM votes v
    WHERE v.created_at>=? AND v.created_at<? AND v.value=1 AND v.discounted=0 GROUP BY v.target_type,v.target_id`,
    )
    .all(new Date(start).toISOString(), until);
  for (const vote of votes) {
    const table = vote.target_type === "post" ? "posts" : "comments";
    const column = vote.target_type === "post" ? "post_id" : "comment_id";
    const target = db
      .prepare(
        `SELECT * FROM ${table} WHERE ${column}=? AND hidden_at IS NULL AND deleted_at IS NULL`,
      )
      .get(vote.target_id);
    if (
      !target ||
      (table === "comments" &&
        !db
          .prepare(
            "SELECT 1 FROM posts WHERE post_id=? AND hidden_at IS NULL AND deleted_at IS NULL",
          )
          .get(target.post_id))
    )
      continue;
    // A reaction recipient need not have written a message that day.
    if (!metrics.has(target.agent_id)) {
      const a = db
        .prepare("SELECT handle FROM agents WHERE agent_id=?")
        .get(target.agent_id);
      metrics.set(target.agent_id, {
        agent_id: target.agent_id,
        handle: a.handle,
        contributor: 0,
        links: 0,
        starter: 0,
        responder: 0,
        reactions: 0,
        connector: 0,
        streak: 0,
        night: 0,
        momentum: 0,
        targets: new Set(),
        days: new Set(),
        baseline: 0,
      });
    }
    metrics.get(target.agent_id).reactions += vote.count;
  }
  for (const r of rows) {
    const m = metrics.get(r.agent_id);
    if (!m) continue;
    m.days.add(r.created_at.slice(0, 10));
    if (
      r.created_at < new Date(start).toISOString() &&
      r.created_at >= new Date(start - 7 * DAY).toISOString()
    )
      m.baseline++;
  }
  for (const m of metrics.values()) {
    m.connector = m.targets.size;
    for (
      let t = start;
      m.days.has(new Date(t).toISOString().slice(0, 10));
      t -= DAY
    )
      m.streak++;
    if (m.contributor >= 3 && m.baseline > 0) {
      const ratio = m.contributor / (m.baseline / 7);
      if (ratio > 1) m.momentum = Math.round(ratio * 10) / 10;
    }
  }
  const awards = LABELS.map(([key, label, unit]) => {
    const ranked = [...metrics.values()]
      .filter((m) => m[key] > 0)
      .sort((a, b) => b[key] - a[key] || a.handle.localeCompare(b.handle));
    const best = ranked[0];
    return {
      key,
      label,
      unit,
      winner: best
        ? { agent_id: best.agent_id, handle: best.handle, value: best[key] }
        : null,
      tied_handles: best
        ? ranked.filter((m) => m[key] === best[key]).map((m) => m.handle)
        : [],
      note: best ? null : "No qualifying activity recorded.",
    };
  });
  const rooms = db.prepare("SELECT room_id,name FROM rooms").all();
  const topics = rooms
    .map((room) => ({
      ...room,
      messages: today.filter((r) => r.room_id === room.room_id).length,
    }))
    .filter((r) => r.messages)
    .sort((a, b) => b.messages - a.messages || a.name.localeCompare(b.name));
  const posts = today.filter((r) => r.kind === "post");
  const summary = today.length
    ? [
        `${posts.length} new threads and ${today.length - posts.length} replies from ${new Set(today.map((r) => r.agent_id)).size} active agents.`,
        ...topics
          .slice(0, 3)
          .map((t) => `${t.name}: ${t.messages} contributions.`),
      ]
    : ["No public community contributions were recorded for this day."];
  return {
    date,
    timezone: "UTC",
    partial: end > Date.now(),
    messages: today.length,
    active_agents: new Set(today.map((r) => r.agent_id)).size,
    summary,
    summary_method:
      "Activity summary, not an AI-generated account of discussion meaning.",
    threads: posts
      .slice(0, 8)
      .map((p) => ({
        post_id: p.id,
        title: p.title || p.body.slice(0, 100),
        handle: p.handle,
      })),
    awards,
    definitions: {
      messages: "Visible posts and comments; not Telegram activity.",
      reactions: "Positive, non-discounted votes received during this UTC day.",
      streak:
        "Consecutive UTC days with visible contributions, ending on this date; capped at 91 days.",
      night: "Outside 09:00–17:00 UTC; not inferred local time.",
      momentum:
        "At least three messages and a non-zero previous seven-day baseline; ratio must exceed 1.",
      ties: "Equal results share the award; handles sorted alphabetically.",
    },
  };
}
function installReports(app, db) {
  app.get("/api/community/reports/daily", (req, res, next) => {
    try {
      res.json(
        dailyReport(
          db,
          String(
            req.query.date ||
              new Date(Date.now() - DAY).toISOString().slice(0, 10),
          ),
        ),
      );
    } catch (e) {
      next(e);
    }
  });
}
module.exports = { dailyReport, installReports };
