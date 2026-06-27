# Tally

Tally keeps a running count of every job and internship application, straight
from your inbox. It reads your Gmail (read-only) and builds a live ledger sorted
by funnel stage: **Applied → Assessment → Interview → Offer / Rejected**.

- **Sign in with Google**, grant read-only Gmail access, done.
- A server-side pipeline scans application confirmations, assessment invites,
  interview requests, offers, and rejections.
- Each email is classified (rule-based, with an optional LLM pass) and grouped
  by company + role.
- Per-user data is isolated with Supabase Row Level Security.

## Stack

- **Next.js 16** (App Router, TypeScript) + **Tailwind CSS v4**
- **Supabase** — Google auth + Postgres + RLS
- **Gmail API** — read-only message scanning
- Optional **LLM (Google Gemini)** for higher-accuracy company/role/stage extraction + noise filtering

---

## Setup

### 1. Install

```bash
npm install
cp .env.local.example .env.local
```

### 2. Create the database

In your Supabase project → **SQL Editor**, paste and run
[`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql).
This creates `applications`, `application_events`, `gmail_tokens`, `sync_state`
and enables RLS so each user only sees their own data.

### 3. Google Cloud — OAuth + Gmail API

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and create
   (or pick) a project.
2. **APIs & Services → Library →** enable the **Gmail API**.
3. **APIs & Services → OAuth consent screen:**
   - User type: **External**, fill in the basics.
   - Add the scope `https://www.googleapis.com/auth/gmail.readonly`.
   - Leave the app in **Testing** mode and add your own Google account under
     **Test users**. (Testing mode is free and skips Google's restricted-scope
     verification; you'll just see an "unverified app" warning you can click
     through. Going public later requires Google verification + a security
     assessment.)
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID:**
   - Application type: **Web application**.
   - Authorized redirect URI:
     `https://<YOUR-PROJECT>.supabase.co/auth/v1/callback`
   - Save the **Client ID** and **Client Secret**.

### 4. Supabase — enable Google auth

1. Supabase → **Authentication → Providers → Google** → enable it.
2. Paste the **Client ID** and **Client Secret** from the step above.
3. Supabase → **Authentication → URL Configuration:** add
   `http://localhost:3000/auth/callback` (and your production URL later) to the
   **Redirect URLs**.

### 5. Fill in `.env.local`

```ini
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...          # only needed for scheduled cron sync
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
LLM_PROVIDER=gemini                    # optional; blank = rules-only
GEMINI_API_KEY=                        # https://aistudio.google.com/apikey
GEMINI_MODEL=gemini-2.5-flash-lite
CRON_SECRET=                           # optional; protects /api/sync/cron
```

### 6. Run

```bash
npm run dev
```

Open <http://localhost:3000>, sign in with Google, then hit **Sync inbox**.

---

## How it works

```
Google sign-in (gmail.readonly + offline)
        │  provider refresh token
        ▼
gmail_tokens (Supabase, RLS)
        │
   /api/sync ──► getAccessToken(refresh) ──► Gmail messages.list (q=funnel terms, after:lastSync)
        │                                          │
        │                                   messages.get (full)
        │                                          │
        │                                   decode Base64URL + strip HTML
        │                                          ▼
        │                              classifyEmail()  (rules + optional LLM)
        │                                          │  { stage, company, role }
        ▼                                          ▼
   applications  ◄── merge by dedup_key ──  application_events (deduped by Gmail message id)
        │
        ▼
   Dashboard board (Applied / OA / Interview / Offer / Rejected)
```

- **Incremental sync:** only fetches mail newer than the last sync (with a 2-day
  overlap), and skips messages whose Gmail IDs were already processed.
- **Stage merging:** an application's stage is the best signal across its emails
  (`offer > rejected > interview > oa > applied`).
- **Classification:** [`src/lib/classifier.ts`](src/lib/classifier.ts) runs regex
  rules first; if `GEMINI_API_KEY` is set, a batched LLM pass refines company/role/stage
  and falls back to rules on any failure.

## Scheduled (background) sync

`vercel.json` registers a cron hitting `/api/sync/cron` every 6 hours. It uses the
Supabase **service role key** to sync every connected user. Set `CRON_SECRET` and
Vercel Cron will send it as a Bearer token. You can also trigger it from any
scheduler:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://your-app/api/sync/cron
```

## Tuning what gets matched

The Gmail search query and stage keywords live in:

- `buildQuery()` in [`src/lib/gmail.ts`](src/lib/gmail.ts) — which emails are fetched.
- `STAGE_PATTERNS` in [`src/lib/classifier.ts`](src/lib/classifier.ts) — how stages
  are detected.

## Privacy

- Gmail scope is **read-only** (`gmail.readonly`). The app never sends or modifies email.
- Only derived metadata (company, role, stage, subject, short snippet) is stored —
  not full email bodies.
- All tables are protected by Row Level Security keyed to `auth.uid()`.
