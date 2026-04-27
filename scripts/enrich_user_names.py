#!/usr/bin/env python3
"""
Backfill names + Slack IDs for users in the RCA Tracker DB.

Looks at every user whose `slack_id` is NULL (or, with --rename-fallbacks,
also any whose `name` is just the email-local-part fallback), looks each up
via `users.lookupByEmail` against the configured Slack bot, and updates
the row.

Usage:
  # Print SQL UPDATEs to stdout — pipe into psql / kubectl exec
  SLACK_BOT_TOKEN=xoxb-... python scripts/enrich_user_names.py > /tmp/enrich.sql

  # Or apply directly against $DATABASE_URL
  SLACK_BOT_TOKEN=xoxb-... DATABASE_URL=postgresql://rca:rca@localhost:5432/rca_coe \
      python scripts/enrich_user_names.py --output db

  # Also overwrite "fallback" names (email or email local-part) with the
  # Slack display name.
  python scripts/enrich_user_names.py --rename-fallbacks --output db

Idempotent: re-running on already-enriched users is a no-op.

Required Slack scopes on the bot token:
  - users:read
  - users:read.email
"""
from __future__ import annotations

import argparse
import os
import sys


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--output", choices=["sql", "db"], default="sql",
                   help="sql = print UPDATE statements (default); db = execute against $DATABASE_URL")
    p.add_argument("--schema", default="rca_coe", help="Postgres schema for the users table")
    p.add_argument("--rename-fallbacks", action="store_true",
                   help="Also overwrite name when it's just the email or its local-part")
    p.add_argument("--dry-run", action="store_true", help="With --output db, print but do not execute")
    return p.parse_args()


def name_is_fallback(email: str, name: str | None) -> bool:
    if not name:
        return True
    local = email.split("@", 1)[0]
    return name == email or name == local


def main() -> int:
    args = parse_args()

    token = os.environ.get("SLACK_BOT_TOKEN")
    if not token:
        print("SLACK_BOT_TOKEN env var not set", file=sys.stderr)
        return 1
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("DATABASE_URL env var not set", file=sys.stderr)
        return 1

    try:
        from slack_sdk import WebClient
        from slack_sdk.errors import SlackApiError
    except ImportError:
        print("slack-sdk not installed. Run: pip install slack-sdk", file=sys.stderr)
        return 1

    try:
        from sqlalchemy import create_engine, text
    except ImportError:
        print("sqlalchemy not installed. Run: pip install sqlalchemy", file=sys.stderr)
        return 1

    sync_url = db_url.replace("postgresql+asyncpg://", "postgresql://")
    engine = create_engine(sync_url, future=True)

    # 1. Fetch candidate users
    with engine.begin() as conn:
        rows = conn.execute(
            text(f"SELECT email, name, slack_id FROM {args.schema}.users ORDER BY email")
        ).all()

    candidates = []
    for r in rows:
        email, name, slack_id = r.email, r.name, r.slack_id
        needs_slack = slack_id is None
        needs_name = args.rename_fallbacks and name_is_fallback(email, name)
        if needs_slack or needs_name:
            candidates.append({"email": email, "name": name, "slack_id": slack_id})

    print(f"{len(rows)} users in DB; {len(candidates)} candidates for enrichment.", file=sys.stderr)
    if not candidates:
        return 0

    # 2. Resolve each via Slack
    client = WebClient(token=token)
    updates: list[dict] = []
    for c in candidates:
        try:
            resp = client.users_lookupByEmail(email=c["email"])
        except SlackApiError as e:
            err = e.response.get("error", str(e))
            print(f"  skip {c['email']}: {err}", file=sys.stderr)
            continue
        u = resp.data.get("user") or {}
        new_slack_id = u.get("id")
        profile = u.get("profile") or {}
        new_name = (u.get("real_name") or profile.get("display_name") or "").strip()
        if not new_slack_id:
            continue

        upd: dict = {"email": c["email"]}
        if c["slack_id"] != new_slack_id:
            upd["slack_id"] = new_slack_id
        if args.rename_fallbacks and name_is_fallback(c["email"], c["name"]) and new_name:
            upd["name"] = new_name
        if len(upd) > 1:
            updates.append(upd)

    print(f"Enriching {len(updates)} users.", file=sys.stderr)
    if not updates:
        return 0

    # 3. Apply
    if args.output == "sql":
        print(f"-- enrich {len(updates)} users in {args.schema}.users")
        for u in updates:
            email = u["email"].replace("'", "''")
            sets = []
            if "slack_id" in u:
                sets.append(f"slack_id = '{u['slack_id']}'")
            if "name" in u:
                nm = u["name"].replace("'", "''")
                sets.append(f"name = '{nm}'")
            print(
                f"UPDATE {args.schema}.users SET {', '.join(sets)} "
                f"WHERE email = '{email}';"
            )
        return 0

    # output == db
    if args.dry_run:
        for u in updates:
            print(f"[dry-run] UPDATE {u['email']}: {u}", file=sys.stderr)
        return 0

    applied = 0
    with engine.begin() as conn:
        for u in updates:
            sets = []
            params: dict = {"email": u["email"]}
            if "slack_id" in u:
                sets.append("slack_id = :slack_id")
                params["slack_id"] = u["slack_id"]
            if "name" in u:
                sets.append("name = :name")
                params["name"] = u["name"]
            conn.execute(
                text(f"UPDATE {args.schema}.users SET {', '.join(sets)} WHERE email = :email"),
                params,
            )
            applied += 1
    print(f"Applied {applied} UPDATEs.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
