# Deploying Sift

Sift is a standard Next.js app plus a Postgres database. It needs exactly one environment
variable:

```
SIFT_DATABASE_URL=postgres://user:password@host:5432/dbname?sslmode=require
```

The schema is created on first request, so there is no migration step. To have the deployed
instance open on the demo pile rather than an empty screen, run `npm run setup` **once**
from your laptop with `SIFT_DATABASE_URL` pointing at the hosted database.

---

## Option A — Vercel + Neon (fastest)

1. **Create the database.** [neon.tech](https://neon.tech) → new project → copy the pooled
   connection string. (Supabase, Railway or any other hosted Postgres works identically.)

2. **Seed it from your laptop**, so the deployed app opens on something worth looking at:

   ```bash
   SIFT_DATABASE_URL='postgres://…?sslmode=require' npm run setup
   ```

   About a minute, most of it network round-trips. It creates the schema, generates the
   corpus if it is missing, and ingests all 40 documents.

3. **Deploy.**

   ```bash
   npx vercel            # first run links the project
   npx vercel env add SIFT_DATABASE_URL    # paste the same connection string
   npx vercel --prod
   ```

   Or connect the GitHub repo in the Vercel dashboard and add the environment variable
   there.

**Two things to know about serverless here.** Ingest is synchronous and a 40-document pile
takes a couple of seconds, which is comfortably inside Vercel's default function timeout —
but a much larger upload would need the timeout raised (`maxDuration`) or a queue. And
`pg`'s pool does not survive between invocations, so a busy deployment wants Neon's pooled
connection string rather than the direct one. Both are noted in `decisions.md` §13 as
things a production version would change.

---

## Option B — Render (one file, database included)

`render.yaml` in the repo root is a blueprint: web service plus a managed Postgres, wired
together.

1. Push the repo to GitHub.
2. Render dashboard → **New → Blueprint** → pick the repo.
3. Render provisions both and injects `SIFT_DATABASE_URL` from the database automatically.
4. Seed it once, using the database's **External Connection String** from the Render
   dashboard:

   ```bash
   SIFT_DATABASE_URL='postgres://…' npm run setup
   ```

Free-tier web services sleep after inactivity; the first request after a sleep takes about
thirty seconds to wake.

---

## Option C — Docker, anywhere

```bash
docker build -t sift .
docker run -p 3000:3000 -e SIFT_DATABASE_URL='postgres://…' sift
```

Or bring up the app and a database together:

```bash
docker compose up --build
docker compose exec app npm run setup    # seed the demo pile
```

---

## Option D — a plain server

Any box with Node 20+ and a reachable Postgres:

```bash
npm ci
npm run build
SIFT_DATABASE_URL='postgres://…' PORT=3000 npm start
```

`npm start` respects `PORT`. Put it behind nginx or a process manager as you would any
other Node service.

---

## Checking it worked

```
GET /                       lists projects; shows a clear error if the database is unreachable
GET /api/projects           JSON, same data
```

If the home page shows *"SIFT_DATABASE_URL is not set"*, the variable did not reach the
runtime — on Vercel, environment variables added after a deploy need a redeploy to take
effect.

If it shows a connection error instead, the variable arrived but the database refused it:
most often a missing `?sslmode=require` on a hosted provider.
