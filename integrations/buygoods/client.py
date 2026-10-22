#!/usr/bin/env python3
"""
BuyGoods / ClickCRM affiliate API client (stdlib only, Python 3.8+).

Credentials come from the environment (see .env.example):
    BUYGOODS_ACCOUNT_ID  (defaults to config.json account_id)
    BUYGOODS_TOKEN       raw, URL-decoded token

Module usage:
    from integrations.buygoods.client import sales_by_day
    rows = sales_by_day("2026-07-19", "2026-09-16")

CLI usage:
    python3 integrations/buygoods/client.py <report> --from YYYY-MM-DD --to YYYY-MM-DD [--csv] [--all]
    reports: customers | conversions | commissions-legacy | byday | byhour | bysubid | bysubid2 | commissions
"""
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from datetime import date, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONFIG = json.loads((HERE / "config.json").read_text())


def _load_dotenv() -> None:
    """Minimal .env loader; never overrides variables already in the environment."""
    for candidate in (HERE.parent.parent / ".env", Path.cwd() / ".env"):
        if not candidate.exists():
            continue
        for line in candidate.read_text().splitlines():
            if line.strip().startswith("#"):
                continue
            m = re.match(r"^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$", line)
            if not m:
                continue
            value = m.group(2)
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            os.environ.setdefault(m.group(1), value)
        return


_load_dotenv()


def credentials():
    token = os.environ.get(CONFIG["token_env"])
    if not token:
        raise RuntimeError(
            f"{CONFIG['token_env']} is not set. Copy .env.example to .env and add the BuyGoods token, "
            "or export it in the environment."
        )
    account_id = os.environ.get(CONFIG["account_id_env"]) or CONFIG["account_id"]
    return token, account_id


def _assert_date(label, value):
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value or ""):
        raise ValueError(f"{label} must be YYYY-MM-DD, got: {value}")


def _request(url):
    req = urllib.request.Request(url, headers={"Accept": "application/json, text/csv;q=0.9, */*;q=0.8"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = resp.read().decode("utf-8", "replace")
            ctype = resp.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:300]
        safe = url.split("token=")[0] + "token=***"
        raise RuntimeError(f"BuyGoods API {e.code} for {safe}: {body}") from None
    if "json" in ctype or re.match(r"^\s*[\[{]", body):
        try:
            return json.loads(body)
        except ValueError:
            pass
    return body


def legacy(endpoint_key, date_from, date_to):
    """Legacy BuyGoods API (api.buygoods.com). Returns parsed JSON or raw text."""
    api = CONFIG["apis"]["legacy"]
    file = api["endpoints"].get(endpoint_key)
    if not file:
        raise ValueError(f"Unknown legacy endpoint: {endpoint_key}")
    _assert_date("date_from", date_from)
    _assert_date("date_to", date_to)
    token, account_id = credentials()
    qs = urllib.parse.urlencode(
        {api["account_param"]: account_id, "token": token, "date_from": date_from, "date_to": date_to}
    )
    return _request(f"{api['base_url']}/{file}?{qs}")


def clickcrm_page(endpoint_key, date_from, date_to, fmt="json", next_page=None):
    """ClickCRM API (api.clickcrm.com), ONE page. Returns (data, next_page, raw)."""
    api = CONFIG["apis"]["clickcrm"]
    ep = api["endpoints"].get(endpoint_key)
    if not ep:
        raise ValueError(f"Unknown clickcrm endpoint: {endpoint_key}")
    if fmt not in ep["formats"]:
        raise ValueError(f"{endpoint_key} does not support format {fmt}")
    _assert_date("date_from", date_from)
    _assert_date("date_to", date_to)
    token, account_id = credentials()
    params = {
        api["account_param"]: account_id,
        "token": token,
        "date_from": date_from,
        "date_to": date_to,
        "response_type": fmt,
    }
    if next_page:
        params[api["pagination"]["cursor_param"]] = str(next_page)
    raw = _request(f"{api['base_url']}/{ep['path']}?{urllib.parse.urlencode(params)}")
    if isinstance(raw, str):
        return raw, None, raw
    cursor_key = api["pagination"]["cursor_property"]
    cursor = None
    if isinstance(raw, dict):
        cursor = raw.get(cursor_key) or (raw.get("meta") or {}).get(cursor_key)
        data = raw.get("data", raw.get("results", raw.get("rows", raw)))
    else:
        data = raw
    return data, (cursor or None), raw


def clickcrm_all(endpoint_key, date_from, date_to):
    """ClickCRM API: follows next_page until exhausted (JSON only). Returns all records."""
    out = []
    next_page = None
    guard = 0
    while True:
        data, next_page, _ = clickcrm_page(endpoint_key, date_from, date_to, "json", next_page)
        out.extend(data if isinstance(data, list) else [data])
        guard += 1
        if not next_page:
            return out
        if guard > 10000:
            raise RuntimeError("Pagination guard tripped (10k pages)")


# Convenience wrappers ------------------------------------------------------
def customers(date_from, date_to):
    return legacy("customers", date_from, date_to)


def conversions(date_from, date_to):
    return legacy("conversions", date_from, date_to)


def commissions_legacy(date_from, date_to):
    return legacy("commissions", date_from, date_to)


def sales_by_day(date_from, date_to):
    return clickcrm_all("sales_by_day", date_from, date_to)


def sales_by_hour(date_from, date_to):
    return clickcrm_all("sales_by_hour", date_from, date_to)


def sales_by_subid(date_from, date_to):
    return clickcrm_all("sales_by_subid", date_from, date_to)


def sales_by_subid2(date_from, date_to):
    return clickcrm_all("sales_by_subid2", date_from, date_to)


def commissions(date_from, date_to):
    return clickcrm_all("commissions", date_from, date_to)


LEGACY_REPORTS = {"customers": "customers", "conversions": "conversions", "commissions-legacy": "commissions"}
NEW_REPORTS = {
    "byday": "sales_by_day",
    "byhour": "sales_by_hour",
    "bysubid": "sales_by_subid",
    "bysubid2": "sales_by_subid2",
    "commissions": "commissions",
}


def _main(argv):
    report = argv[0] if argv else None

    def flag(name):
        return argv[argv.index(name) + 1] if name in argv and argv.index(name) + 1 < len(argv) else None

    today = date.today()
    date_to = flag("--to") or today.isoformat()
    date_from = flag("--from") or (today - timedelta(days=29)).isoformat()
    csv = "--csv" in argv
    all_pages = "--all" in argv

    if report not in LEGACY_REPORTS and report not in NEW_REPORTS:
        sys.stderr.write(
            "Usage: python3 client.py <report> --from YYYY-MM-DD --to YYYY-MM-DD [--csv] [--all]\n"
            f"Reports: {' | '.join([*LEGACY_REPORTS, *NEW_REPORTS])}\n"
        )
        return 2

    if report in LEGACY_REPORTS:
        out = legacy(LEGACY_REPORTS[report], date_from, date_to)
    elif all_pages and not csv:
        out = clickcrm_all(NEW_REPORTS[report], date_from, date_to)
    else:
        data, _, raw = clickcrm_page(NEW_REPORTS[report], date_from, date_to, "csv" if csv else "json")
        out = data if csv else raw
    sys.stdout.write(out if isinstance(out, str) else json.dumps(out, indent=2))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(_main(sys.argv[1:]))
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"{exc}\n")
        sys.exit(1)
