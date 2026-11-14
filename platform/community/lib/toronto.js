"use strict";
// Calendar days are local midnight to the next local midnight in America/Toronto.
// Intl.DateTimeFormat reads the IANA time zone database (the platform tz library).
// Instants are stored as UTC. Never add 24 hours: fall-back days are 25h and
// spring-forward days are 23h.
const IANA = "America/Toronto";

function parts(utcMs, timeZone = IANA) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const bag = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) bag[p.type] = p.value;
  let year = Number(bag.year),
    month = Number(bag.month),
    day = Number(bag.day),
    hour = Number(bag.hour);
  if (hour === 24) {
    hour = 0;
    const next = new Date(Date.UTC(year, month - 1, day) + 86400000);
    year = next.getUTCFullYear();
    month = next.getUTCMonth() + 1;
    day = next.getUTCDate();
  }
  const pad = (n) => String(n).padStart(2, "0");
  return {
    year,
    month,
    day,
    hour,
    minute: Number(bag.minute),
    second: Number(bag.second),
    date: `${year}-${pad(month)}-${pad(day)}`,
    minutes: hour * 60 + Number(bag.minute),
    timeZone,
  };
}

function offsetMs(utcMs, timeZone = IANA) {
  const p = parts(utcMs, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - utcMs;
}

function zonedToUtc(year, month, day, hour = 0, minute = 0, second = 0, timeZone = IANA) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  let utc = guess - offsetMs(guess, timeZone);
  const adjusted = guess - offsetMs(utc, timeZone);
  if (adjusted !== utc) utc = adjusted;
  return utc;
}

function parseDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const [y, m, d] = date.split("-").map(Number);
  const check = new Date(Date.UTC(y, m - 1, d));
  if (
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() !== m - 1 ||
    check.getUTCDate() !== d
  )
    return null;
  return { y, m, d };
}

function addCalendarDays(date, n) {
  const p = parseDate(date);
  if (!p) return null;
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d) + n * 86400000);
  const pad = (x) => String(x).padStart(2, "0");
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

function isoZ(ms) {
  return new Date(ms).toISOString().replace(".000Z", "Z");
}

function torontoDayWindow(date) {
  const p = parseDate(date);
  if (!p) {
    const e = Error("invalid_date");
    e.status = 400;
    throw e;
  }
  const start = zonedToUtc(p.y, p.m, p.d, 0, 0, 0);
  const next = addCalendarDays(date, 1);
  const np = parseDate(next);
  const end = zonedToUtc(np.y, np.m, np.d, 0, 0, 0);
  return {
    start,
    end,
    startIso: isoZ(start),
    endIso: isoZ(end),
    duration_h: (end - start) / 3600000,
    iana: IANA,
    add_24h_to_start_utc: false,
  };
}

function torontoDate(utcMs) {
  return parts(utcMs).date;
}

function torontoIso(utcMs) {
  const p = parts(utcMs);
  const offMin = Math.round(offsetMs(utcMs) / 60000);
  const sign = offMin >= 0 ? "+" : "-";
  const abs = Math.abs(offMin);
  const pad = (n) => String(n).padStart(2, "0");
  return `${p.date}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function parseHm(value, fallbackMinutes) {
  const m = /^(\d{2}):(\d{2})$/.exec(value || "");
  if (!m) return fallbackMinutes;
  const h = Number(m[1]),
    min = Number(m[2]);
  if (h > 23 || min > 59) return fallbackMinutes;
  return h * 60 + min;
}

function yesterdayToronto(now = Date.now()) {
  return addCalendarDays(torontoDate(now), -1);
}

module.exports = {
  IANA,
  parts,
  zonedToUtc,
  parseDate,
  addCalendarDays,
  torontoDayWindow,
  torontoDate,
  torontoIso,
  isoZ,
  parseHm,
  yesterdayToronto,
};
