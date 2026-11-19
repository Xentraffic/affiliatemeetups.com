"use strict";

function setting(db, name, fallback = null) {
  const row = db.prepare("SELECT value FROM settings WHERE name=?").get(name);
  return row ? row.value : fallback;
}

function jsonSetting(db, name, fallback) {
  try {
    const raw = setting(db, name, null);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function slotEnabled(db, name) {
  if (process.env.COMMUNITY_SPONSORED_SLOTS === "0") return false;
  const envKey = "COMMUNITY_" + String(name).toUpperCase();
  if (process.env[envKey] === "0") return false;
  return setting(db, name, "0") === "1";
}

module.exports = { setting, jsonSetting, slotEnabled };
