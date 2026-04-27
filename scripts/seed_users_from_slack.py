#!/usr/bin/env python3
"""
Seed the RCA Tracker `users` table from a Slack user group.

Usage:
  # Print SQL to stdout — pipe into psql, kubectl exec, etc.
  SLACK_BOT_TOKEN=xoxb-... python scripts/seed_users_from_slack.py \\
      --group ny-devs > /tmp/seed.sql

  # Or write directly to a database via SQLAlchemy:
  SLACK_BOT_TOKEN=xoxb-... \\
  DATABASE_URL=postgresql://rca:rca@localhost:5432/rca_coe \\
  python scripts/seed_users_from_slack.py --group ny-devs --output db

  # Mark some emails as admin in the same pass:
  python scripts/seed_users_from_slack.py --group ny-devs \\
      --admin-emails alice@example.com,bob@example.com

The script is idempotent: it uses ``INSERT ... ON CONFLICT (email) DO NOTHING``
so re-running it is safe. New users are inserted with ``is_admin=false`` unless
their email is in ``--admin-emails``.

Required Slack scopes on the bot token:
  - usergroups:read
  - users:read
  - users:read.email
"""
from __future__ import annotations

import argparse
import os
import re
import sys

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--group", required=True, help="Slack usergroup handle, e.g. ny-devs")
    p.add_argument("--output", choices=["sql", "db"], default="sql",
                   help="sql = print INSERT statements to stdout (default); db = execute against $DATABASE_URL")
    p.add_argument("--schema", default="rca_coe", help="Postgres schema for the users table")
    p.add_argument("--admin-emails", default="", help="Comma-separated emails to mark is_admin=true")
    p.add_argument("--dry-run", action="store_true", help="With --output db, print but do not execute")
    return p.parse_args()


def resolve_group_id(client, handle: str) -> str:
    """Find a Slack user group by handle (without the @)."""
    handle = handle.lstrip("@").lower()
    resp = client.usergroups_list()
    groups = resp.data.get("usergroups", [])
    for g in groups:
        if g.get("handle", "").lower() == handle:
            return g["id"]
    available = ", ".join(sorted(g.get("handle", "?") for g in groups))
    raise SystemExit(
        f"Slack usergroup @{handle} not found. Available handles: {available}"
    )


def fetch_members(client, group_id: str) -> list[str]:
    resp = client.usergroups_users_list(usergroup=group_id)
    return resp.data.get("users", [])


def fetch_user(client, user_id: str) -> dict | None:
    resp = client.users_info(user=user_id)
    return resp.data.get("user")


def main() -> int:
    args = parse_args()

    token = os.environ.get("SLACK_BOT_TOKEN")
    if not token:
        print("SLACK_BOT_TOKEN env var not set", file=sys.stderr)
        return 1

    try:
        from slack_sdk import WebClient
        from slack_sdk.errors import SlackApiError
    except ImportError:
        print("slack-sdk not installed. Run: pip install slack-sdk", file=sys.stderr)
        return 1

    client = WebClient(token=token)

    try:
        group_id = resolve_group_id(client, args.group)
        member_ids = fetch_members(client, group_id)
    except SlackApiError as e:
        print(f"Slack API error: {e.response.get('error', e)}", file=sys.stderr)
        return 1

    print(f"Group @{args.group}: {len(member_ids)} members", file=sys.stderr)

    admin_set = {e.strip().lower() for e in args.admin_emails.split(",") if e.strip()}
    rows: list[dict] = []
    skipped_no_email: list[str] = []

    for uid in member_ids:
        try:
            user = fetch_user(client, uid)
        except SlackApiError as e:
            print(f"  skip {uid}: {e.response.get('error', e)}", file=sys.stderr)
            continue
        if not user or user.get("is_bot") or user.get("deleted"):
            continue
        profile = user.get("profile") or {}
        email = (profile.get("email") or "").lower()
        if not email or not EMAIL_RE.match(email):
            skipped_no_email.append(user.get("name") or uid)
            continue
        name = (user.get("real_name") or profile.get("display_name") or email.split("@")[0]).strip()
        rows.append({"email": email, "name": name, "is_admin": email in admin_set})

    print(f"Resolved {len(rows)} users with email", file=sys.stderr)
    if skipped_no_email:
        print(f"Skipped {len(skipped_no_email)} (no email or restricted): {', '.join(skipped_no_email[:5])}{'...' if len(skipped_no_email) > 5 else ''}", file=sys.stderr)

    if args.output == "sql":
        print(f"-- Seed from Slack @{args.group} ({len(rows)} users)")
        print(f"SET search_path TO {args.schema};")
        for r in rows:
            email = r["email"].replace("'", "''")
            name = r["name"].replace("'", "''")
            adm = "true" if r["is_admin"] else "false"
            print(
                f"INSERT INTO users (email, name, is_admin) "
                f"VALUES ('{email}', '{name}', {adm}) "
                f"ON CONFLICT (email) DO NOTHING;"
            )
        return 0

    # output == db
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("DATABASE_URL env var not set", file=sys.stderr)
        return 1

    try:
        from sqlalchemy import create_engine, text
    except ImportError:
        print("sqlalchemy not installed. Run: pip install sqlalchemy", file=sys.stderr)
        return 1

    sync_url = db_url.replace("postgresql+asyncpg://", "postgresql://")
    engine = create_engine(sync_url, future=True)
    sql = text(
        f"INSERT INTO {args.schema}.users (email, name, is_admin) "
        f"VALUES (:email, :name, :is_admin) "
        f"ON CONFLICT (email) DO NOTHING"
    )

    if args.dry_run:
        print(f"[dry-run] Would INSERT {len(rows)} rows into {args.schema}.users", file=sys.stderr)
        return 0

    inserted = 0
    with engine.begin() as conn:
        for r in rows:
            conn.execute(sql, r)
            inserted += 1
    print(f"Applied {inserted} INSERTs (existing rows skipped via ON CONFLICT)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
