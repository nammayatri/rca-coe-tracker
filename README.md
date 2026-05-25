# RCA COE Tracker

A lightweight, opinionated tracker for RCAs / CoEs (post-incident reviews).
Designed for small-to-medium engineering teams who already use Slack and
want a single place to file blameless post-mortems, track action items,
and auto-summarise on closure.

- **What it does**: track RCAs through `Open → In Progress → RCA Done →
  Closed`, DM everyone involved on every change, and auto-generate a
  post-mortem summary on closure.
- **Auth**: trusts an upstream identity proxy (Pomerium / oauth2-proxy /
  similar). It reads identity from the forwarded `x-pomerium-claim-*` headers,
  or from a Pomerium JWT assertion (decoded for its claims, not verified — the
  proxy is the trust boundary). The app issues no sessions or tokens of its
  own. Works with any proxy that can set those headers.
- **Structured editor**: create *and* edit an RCA through one form — incident
  metadata (severity, services, timestamps), summary, Five Whys, action items,
  and a timeline. Saved as both a structured payload and a rendered markdown
  body, so the same form reopens for editing.
- **Notifications**: Slack DMs to creator + assignees on assignment
  changes and status transitions. Bring your own bot token.
- **AI summary**: optional. Plug any OpenAI-compatible endpoint into
  `AI_API_BASE` / `AI_API_KEY`. Use a non-reasoning model — reasoning
  models leak chain-of-thought as visible text.

## Stack

```
backend/      FastAPI + SQLAlchemy 2.0 async + slack-sdk + litellm
frontend/     React 19 + Vite 6 + Tailwind 4 + React Query
prodk8s/      k8s manifests (one pod: app + Postgres sidecar on a shared PVC)
Dockerfile    multi-stage: node build → python runtime serving SPA + API
```

One pod in production (app + Postgres sidecar containers, sharing a PVC over
`localhost`). Locally, the app runs as one process and Postgres runs in Docker.

## Run locally

```bash
cp .env.example .env       # fill in DEV_FAKE_EMAIL, ADMIN_EMAILS at minimum
make install               # creates venv + npm install
make db-up                 # starts Postgres on a docker volume
make migrate               # applies all migrations (idempotent)
make dev                   # builds SPA into backend/static, runs uvicorn
# → open http://localhost:8000
```

`DEV_FAKE_EMAIL` in `.env` is the local-dev bypass for the upstream identity
proxy. In prod, the proxy sets `x-pomerium-claim-email` and the dev fallback
is ignored.

For frontend HMR while iterating:

```bash
make dev-split    # prints the two commands to run in two shells
# shell 1: cd backend && .venv/bin/uvicorn app.main:app --reload
# shell 2: cd frontend && npm run dev   (Vite on :5173, proxies /api → :8000)
```

## Permissions

| Action                          | Admin | Creator | Assignee | Other authed |
|---------------------------------|:-----:|:-------:|:--------:|:------------:|
| View RCAs                       |   Y   |    Y    |     Y    |       Y      |
| Create RCA                      |   Y   |    Y    |     Y    |       Y      |
| Edit title / body / assignees   |   Y   |    Y    |     Y    |       N      |
| Change status                   |   Y   |    Y    |     Y    |       N      |
| Delete RCA                      |   Y   |    Y    |     N    |       N      |
| Regenerate AI summary           |   Y   |    N    |     N    |       N      |
| View user list                  |   Y   |    N    |     N    |       N      |
| Promote / demote admins         |   Y   |    N    |     N    |       N      |
| Remove user                     |   Y   |    N    |     N    |       N      |

### Admin bootstrap

Emails in `ADMIN_EMAILS` are seeded as admins on first login and **cannot be
demoted or deleted from the UI** — this is the recovery path if the
DB-stored admin set ever empties. Other admins can be promoted via the
Users page and demoted by another admin.

Last-admin protection: the API refuses to demote or delete the very last
admin so the system can't lock itself out.

## Deploy

See [`prodk8s/DEPLOY.md`](prodk8s/DEPLOY.md). TL;DR:

1. Edit `prodk8s/deployment.yaml` to fill in your image registry, namespace,
   public URL, and secret values.
2. `kubectl apply -f prodk8s/deployment.yaml`.
3. Run `prodk8s/init.sql` + every `backend/migrations/*.sql` against the
   `postgres` container in the app pod
   (`kubectl exec -i <pod> -c postgres -- psql -U rca -d rca_coe < <file>`).
4. Build & push the multi-stage image, then `kubectl set image` (or re-`apply`).
5. Add a route to your identity proxy that forwards `x-pomerium-claim-*`
   headers (or equivalent) to the app's `:8000` Service.

## License

MIT.
