# Deploying Sift

Sift is a standard Next.js app plus a Postgres database. It needs exactly one environment
variable:

```
SIFT_DATABASE_URL=postgres://user:password@host:5432/dbname?sslmode=require
```

The schema is created on first request, so there is no migration step — and there is no
seeding step either. A deployed instance with an empty database offers **Load the
40-document demo pile** on its home page, which generates the corpus on the server and
ingests it in about a second, so whoever opens the URL first sees the whole thing working.

(Running `npm run setup` from your laptop against the hosted database does the same thing
ahead of time, if you would rather the pile already be there.)

---

## Option A — Vercel + Neon (fastest)

1. **Create the database.** [neon.tech](https://neon.tech) → new project → copy the pooled
   connection string. (Supabase, Railway or any other hosted Postgres works identically.)

2. **Deploy.** No CLI needed: Vercel dashboard → **Add New → Project** → import the GitHub
   repo → add `SIFT_DATABASE_URL` under **Environment Variables** → **Deploy**.

   From a terminal instead:

   ```bash
   npx vercel                              # first run links the project
   npx vercel env add SIFT_DATABASE_URL    # paste the connection string
   npx vercel --prod
   ```

3. **Open the URL** and click **Load the 40-document demo pile**.

**Three things to know about serverless here.** Ingest is synchronous; forty documents take
about 1.5 seconds, well inside the 60-second `maxDuration` set on the upload route. That
number is deliberately the Hobby ceiling — a value above your plan's limit fails the *build*
rather than degrading — so raise it in `src/app/api/projects/route.ts` if you turn on Fluid
Compute and want to accept much larger piles. Progress is streamed as NDJSON, which needs a
Node runtime rather than Edge; that is the default here and nothing declares otherwise. And
`pg`'s pool does not survive between invocations, so a busy deployment wants Neon's pooled
connection string rather than the direct one. These are noted in `decisions.md` §15 as things
a production version would change.

---

## Option B — Render (one file, database included)

`render.yaml` in the repo root is a blueprint: web service plus a managed Postgres, wired
together.

1. Push the repo to GitHub.
2. Render dashboard → **New → Blueprint** → pick the repo.
3. Render provisions both and injects `SIFT_DATABASE_URL` from the database automatically.
4. Open the URL and click **Load the 40-document demo pile**.

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
