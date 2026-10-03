# TSS development, staging and production commands

Run these commands inside `tss-tracker`. Use Node.js 24, pnpm 11.25.0 and
Docker Desktop with Linux containers and Docker Compose v2 for staging.
Production uses a private GitHub repository linked to Render.

```powershell
pnpm install --frozen-lockfile
```

## Local development

```powershell
pnpm dev
```

Open http://127.0.0.1:4318. Node watches imported source files and restarts
after edits. Create a development manager through the first-access form.
Press Ctrl+C to stop.

This command disables the existing `.env`, uses JSON in `.local/development`,
and starts with an empty workspace. It preserves development records on the
next start. The existing pilot database, JSON and attachments are not imported.

```powershell
pnpm dev:check
```

This runs the full native test suite. The four real PostgreSQL integration
tests require `TSS_TEST_DATABASE_URL`; use staging testing to run them against
the dedicated disposable test database.

## Local staging and testing

Check the Docker connection first:

```powershell
pnpm docker:check
```

The project commands find Docker on PATH or in the standard Windows
Docker Desktop installation directories, including per-user installations.
For another installation, set `$env:TSS_DOCKER_EXE` to the absolute path of
`docker.exe`. This setting is optional on this workstation.
The commands preserve system PATH and Docker settings, add the executable
directory to their child PATH for credential helpers, and refuse remote
Docker endpoints. Keep Docker Desktop running with Linux containers.

Codex's Windows sandbox may require permission to execute Docker or access
its engine. Approve the specific Docker check or staging command when prompted;
no sandbox or global security settings need to be disabled.

```powershell
pnpm staging:check
```

This runs all tests against an isolated PostgreSQL container, builds the
production Docker image, starts staging and checks the actual HTTPS route.
Open https://localhost:8443. Staging uses PostgreSQL 16, Node.js 24, Caddy and
persistent database, uploads and certificate volumes. Only the HTTPS proxy
port is published, on 127.0.0.1. The project name is always `tss-local-staging`.

The first start initializes an empty local staging database. Create a staging
manager in the browser. Later starts preserve records and uploaded files.
The initialization helper refuses any database outside the designated
Compose host and database; it never runs in production.

Individual commands:

```powershell
pnpm staging:up           # Build, start and wait for healthy services
pnpm staging:test         # All tests, including real PostgreSQL
pnpm staging:smoke        # Read-only checks through actual HTTPS
pnpm staging:logs         # Follow app/proxy logs; Ctrl+C stops following
pnpm staging:certificate  # Export the local HTTPS root certificate
pnpm staging:down         # Stop containers; keep named volumes
pnpm staging:deploy       # Verify and publish a committed staging branch to GitHub
```

The smoke command trusts the exported Caddy certificate for its Node process
only. For browser access, after starting staging, trust this installation's
root certificate in your Windows user account:

```powershell
pnpm staging:certificate
certutil -user -addstore Root .local/staging-root.crt
```

This certificate command changes the user certificate trust store. The
pipeline does not execute it automatically. Do not use the public test
certificates under `tests/fixtures/tls` for browser trust.

After creating a staging record and uploading a file, run `pnpm staging:up`
again and verify that both remain. A rebuild clears sessions, so sign in again.
Use `staging:down` to stop the stack. Avoid `down --volumes` unless intentionally
discarding all local staging records, uploads and certificates.

## GitHub staging setup

This folder is already a local Git repository. Its local `main` follows the
existing GitHub `main` history, and the application changes remain
uncommitted in the working tree.
This workstation already has `origin` configured as
[tsscom/tss-tracker](https://github.com/tsscom/tss-tracker.git); do not add
another `origin`.
Keep that GitHub repository private. Create `staging` from the current
`main`, then review, commit and publish the application changes:

```powershell
git switch -c staging
git add .
git diff --cached --stat
git commit -m "Configure TSS staging and CI/CD"
pnpm staging:deploy
```

For a separate checkout of this existing GitHub repository, start from its
history:

```powershell
git clone https://github.com/tsscom/tss-tracker.git tss-tracker
cd tss-tracker
git switch --no-track -c staging origin/main
```

Make the intended application changes in that checkout, then use the
review, commit and deployment commands above.

For a brand-new, empty GitHub repository, choose a private repository without
an initial README or license. Only for that separate, uninitialized copy,
use `git init -b main`, configure `origin` with the new repository's actual
URL, and commit the reviewed source on local `main` before creating
`staging`. An existing GitHub `main` history should be used as the starting
point for local branches.

The workstation sequence publishes only the `staging` branch. Keep the
GitHub repository private. Review the staged file
list before each commit and inspect any unexpected file. `.env`, `.env.*`,
`data/`, `.local/`, `node_modules/` and `.pnpm-store/` are excluded;
`.env.example` is included as a configuration template. Do not force-add
private environment files, business records, backups or uploaded documents.
Docker uses an explicit source allowlist and excludes the pilot data and
environment files.

## Staging releases

For later updates, review and commit the changes on `staging`, then publish:

```powershell
git switch staging
git add .
git diff --cached --stat
git commit -m "Describe the staging update"
pnpm staging:deploy
```

`staging:deploy` requires a clean, committed `staging` branch and a GitHub
`origin`. It runs the full local staging verification, checks that the commit
and destination remain unchanged, and pushes that exact revision to GitHub's
`staging` branch without forcing. The command does not create a commit or
switch branches. If the working tree is already clean and the update is
committed, run `pnpm staging:deploy` directly.

The verification starts the local Docker staging app at
https://localhost:8443. GitHub receives application code and runs hosted CI.
Development JSON, local staging PostgreSQL records, and uploaded files remain
in their separate local stores; publishing a branch does not transfer them.
The current Render Blueprint deploys production from `main`. To run staging
on a public URL, configure a separate Render service targeting `staging`,
with its own PostgreSQL database and uploads disk.

## Render production setup

When preparing production, publish the approved application revision to
`main` using the production release commands below before connecting Render.
In Render, create a Blueprint linked to this private repository, using
`render.yaml`. The Blueprint describes a paid web service, PostgreSQL and
an uploads disk in Frankfurt. Set `PUBLIC_ORIGIN` to the exact HTTPS origin,
for example `https://YOUR_SERVICE.onrender.com`, without a path.
Render supplies the internal database connection. The app runs one instance.

Initialize production records before the first successful app startup.
The app intentionally refuses an uninitialized PostgreSQL database and does
not automatically import pilot data or create production sample records.
For a JSON source, stop all processes that write that source and back up the
source and attachments together. Temporarily permit only your current IP in
the production database's external access rules, obtain its external URL,
then run:

```powershell
$env:TSS_PRODUCTION_DATABASE_URL = [System.Net.NetworkCredential]::new('', (Read-Host 'Production database URL' -AsSecureString)).Password
pnpm production:import "C:\path\to\backed-up\jobs.json"
Remove-Item Env:TSS_PRODUCTION_DATABASE_URL
```

This command verifies the JSON, creates an exact backup alongside the source,
and imports only into an empty database. Existing users are preserved.
It does not transfer attachment files. Copy the corresponding attachment
directory securely to `/var/data/attachments` before opening production to
users, then remove the temporary external database access rule.
For an existing PostgreSQL source, use an appropriate PostgreSQL backup and
restore into the empty production database, together with the attachments;
the JSON copy can be stale after the pilot switches to PostgreSQL.

`.github/workflows/ci.yml` runs on pull requests and pushes to `main` and
`staging`. It installs locked dependencies, runs all tests with PostgreSQL,
validates Compose, builds the production image, starts staging and checks
HTTPS. Render production tracks `main` and uses
`autoDeployTrigger: checksPass`, so production commits deploy after hosted
CI completes successfully. A push to `staging` runs CI without updating the
production service. The initial database import is not repeated. Versioned
SQL schema migrations run at app startup.

## Production releases

Switch to local `main` before preparing a production release. To promote an
already reviewed staging update, merge it first:

```powershell
git switch main
git merge staging
```

Then verify, review and commit any remaining production changes:

```powershell
pnpm production:check
git add .
git diff --cached --stat
git commit -m "Describe the application update"
pnpm production:deploy
```

Skip `git commit` when the release revision is already committed and the
working tree is clean; `pnpm production:deploy` can run directly.
`production:check` runs the same local staging checks. `production:deploy`
requires a clean `main` branch and a GitHub `origin`, runs those checks,
rechecks the commit and destination, then pushes that exact tested revision
without forcing. It requests deployment; it does not claim Render has
finished. Check the GitHub Actions and Render deployment status.

After Render reports a successful deployment:

```powershell
pnpm production:smoke https://YOUR_SERVICE.onrender.com
```

The smoke command performs read-only readiness, desktop, mobile, manifest
and session checks. It does not create records or sign in.

Keep coordinated database and attachment backups. App rollbacks do not undo
database migrations or business records. The attached disk causes a brief
interruption during deployments, and current in-memory sessions require
users to sign in again. Login throttling uses the proxy socket address,
so proxied clients currently share its aggregate IP limit.

References: [Render automatic deployments](https://render.com/docs/deploys),
[Render Blueprint specification](https://render.com/docs/blueprint-spec),
[Docker Compose](https://docs.docker.com/compose/intro/compose-application-model/),
[Caddy local HTTPS](https://caddyserver.com/docs/automatic-https).
