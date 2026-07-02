import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getAccessToken,
  listMessages,
  getMessage,
  buildQuery,
  getProfileEmail,
  type ParsedEmail,
} from "./gmail";
import {
  classifyEmails,
  companyKeySimilar,
  dedupKey,
  normCompany,
  normRole,
  roleSimilar,
} from "./classifier";
import { decryptToken } from "./crypto";
import type { Stage } from "./types";

/** Run an async mapper over items with bounded concurrency, preserving order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

// Progression ranking used to merge multiple emails for one application.
// Offer is the best outcome and wins; rejection is otherwise terminal.
const PROGRESSION: Record<Stage, number> = {
  applied: 1,
  oa: 2,
  interview: 3,
  rejected: 4,
  offer: 5,
  declined: 6,
  accepted: 7,
};

function mergeStage(current: Stage, incoming: Stage): Stage {
  return PROGRESSION[incoming] > PROGRESSION[current] ? incoming : current;
}

export interface SyncResult {
  scanned: number;
  newEvents: number;
  applicationsTouched: number;
  error?: string;
}

export async function syncUser(
  supabase: SupabaseClient,
  userId: string,
  opts: { maxMessages?: number } = {}
): Promise<SyncResult> {
  const result: SyncResult = {
    scanned: 0,
    newEvents: 0,
    applicationsTouched: 0,
  };

  // 1. Resolve the stored Gmail refresh token -> fresh access token.
  const { data: tokenRow } = await supabase
    .from("gmail_tokens")
    .select("refresh_token")
    .eq("user_id", userId)
    .maybeSingle();

  if (!tokenRow?.refresh_token) {
    result.error = "No Gmail access. Please reconnect your Google account.";
    return result;
  }

  const accessToken = await getAccessToken(decryptToken(tokenRow.refresh_token));
  const accountEmail = await getProfileEmail(accessToken);

  // 2. Only fetch mail since the last successful sync (with a small overlap).
  const { data: syncRow } = await supabase
    .from("sync_state")
    .select("last_synced_at")
    .eq("user_id", userId)
    .maybeSingle();

  let after: number | undefined;
  if (syncRow?.last_synced_at) {
    const last = new Date(syncRow.last_synced_at).getTime();
    after = Math.floor((last - 2 * 24 * 60 * 60 * 1000) / 1000); // 2-day overlap
  }

  const query = buildQuery(after);
  const metas = await listMessages(accessToken, query, opts.maxMessages ?? 300);
  result.scanned = metas.length;

  if (metas.length === 0) {
    await touchSyncState(supabase, userId);
    return result;
  }

  // 3. Skip messages we've already processed.
  const ids = metas.map((m) => m.id);
  const { data: existing } = await supabase
    .from("application_events")
    .select("gmail_message_id")
    .eq("user_id", userId)
    .in("gmail_message_id", ids);

  const seen = new Set((existing ?? []).map((r) => r.gmail_message_id));
  const todo = metas.filter((m) => !seen.has(m.id));

  // 4. Fetch full messages concurrently, dropping your own sent replies.
  const emails = (
    await mapLimit(todo, 10, async (meta) => {
      try {
        const email = await getMessage(accessToken, meta.id);
        if (accountEmail && email.fromEmail === accountEmail) return null;
        return email;
      } catch {
        return null;
      }
    })
  ).filter((e): e is ParsedEmail => e !== null);

  // Process oldest-first: confirmations carry the cleanest company/role/req,
  // so they create the cards that later terse follow-ups then attach to.
  emails.sort((a, b) => a.date.getTime() - b.date.getTime());

  // 5. Classify in batches: one Gemini call per batch, batches run in parallel.
  const BATCH = 10;
  const batches: ParsedEmail[][] = [];
  for (let i = 0; i < emails.length; i += BATCH) batches.push(emails.slice(i, i + BATCH));
  const classifiedBatches = await mapLimit(batches, 4, (b) => classifyEmails(b));
  const items = emails.map((email, i) => ({
    email,
    c: classifiedBatches[Math.floor(i / BATCH)][i % BATCH],
  }));

  // 6. Preload existing applications so matching happens in memory (no
  // per-email DB reads). Resolve apps, collect events, then bulk-write.
  type AppRec = {
    id: string;
    role: string | null;
    role_key: string;
    req: string | null;
    stage: Stage;
    first: number;
    last: number;
    company_key: string;
    locked: boolean;
    touched: boolean;
  };
  const byCompany = new Map<string, AppRec[]>();
  const { data: existingApps } = await supabase
    .from("applications")
    .select("id, company, company_key, role, role_key, stage, locked, first_email_at, last_email_at, dedup_key")
    .eq("user_id", userId);
  for (const a of existingApps ?? []) {
    // dedup_key carries the requisition id as a third segment (company::role::req).
    const reqSeg = (a.dedup_key ?? "").split("::")[2] ?? "";
    const rec: AppRec = {
      id: a.id,
      role: a.role,
      role_key: a.role_key ?? "",
      req: reqSeg || null,
      stage: a.stage as Stage,
      first: new Date(a.first_email_at).getTime(),
      last: new Date(a.last_email_at).getTime(),
      company_key: a.company_key ?? normCompany(a.company),
      locked: a.locked ?? false,
      touched: false,
    };
    const list = byCompany.get(rec.company_key) ?? [];
    list.push(rec);
    byCompany.set(rec.company_key, list);
  }

  const eventsToInsert: Record<string, unknown>[] = [];

  for (const { email, c } of items) {
    if (!c.relevant) continue;
    // Drop emails we can't attribute to a real company. Tracking them creates a
    // junk card, and (worse) they all share an empty key and merge into one.
    if (c.company === "Unknown Company") continue;

    let companyKey = normCompany(c.company);
    const roleKey = normRole(c.role);
    const req = c.req ?? null;
    const when = email.date.getTime();
    // Name variants of one employer ("Impulse" vs "Impulse Space") must land
    // in the same bucket or every variant spawns a duplicate card.
    if (!byCompany.has(companyKey)) {
      for (const k of byCompany.keys()) {
        if (companyKeySimilar(k, companyKey)) {
          companyKey = k;
          break;
        }
      }
    }
    const list = byCompany.get(companyKey) ?? [];

    // Requisition ID is the strongest identity: same req = same application,
    // two DIFFERENT known reqs are never the same application. Role text only
    // groups applications when reqs don't contradict.
    const compatible = (r: AppRec) => !req || !r.req || r.req === req;

    let rec: AppRec | undefined;
    if (req) rec = list.find((r) => r.req === req);
    if (!rec && roleKey) {
      rec =
        list.find((r) => compatible(r) && r.role_key === roleKey) ??
        list.find((r) => compatible(r) && r.role_key && roleSimilar(r.role_key, roleKey)) ??
        list.find((r) => compatible(r) && !r.role_key);
    } else if (!rec && !roleKey) {
      // Role-less follow-up: the most recently active compatible card, not an
      // arbitrary one — status updates are usually about the latest activity.
      rec = list
        .filter(compatible)
        .sort((a, b) => b.last - a.last)[0];
    }

    if (!rec) {
      const { data: created, error } = await supabase
        .from("applications")
        .insert({
          user_id: userId,
          company: c.company,
          role: c.role,
          stage: c.stage,
          dedup_key: dedupKey(c.company, c.role, req),
          company_key: companyKey,
          role_key: roleKey,
          first_email_at: email.date.toISOString(),
          last_email_at: email.date.toISOString(),
        })
        .select("id")
        .single();
      if (error || !created) continue;
      rec = {
        id: created.id,
        role: c.role,
        role_key: roleKey,
        req,
        stage: c.stage,
        first: when,
        last: when,
        company_key: companyKey,
        locked: false,
        touched: true,
      };
      list.push(rec);
      byCompany.set(companyKey, list);
    } else {
      if (!rec.locked) rec.stage = mergeStage(rec.stage, c.stage);
      rec.first = Math.min(rec.first, when);
      rec.last = Math.max(rec.last, when);
      if (!rec.role_key && roleKey) {
        rec.role = c.role;
        rec.role_key = roleKey;
      }
      if (!rec.req && req) rec.req = req;
      rec.touched = true;
    }

    eventsToInsert.push({
      application_id: rec.id,
      user_id: userId,
      stage: c.stage,
      subject: email.subject,
      sender: `${email.fromName} <${email.fromEmail}>`.trim(),
      snippet: email.snippet?.slice(0, 300) ?? null,
      body: email.body ? email.body.slice(0, 20000) : null,
      gmail_message_id: email.id,
      email_at: email.date.toISOString(),
    });
  }

  // 7. Bulk insert events (dedupe on gmail_message_id).
  for (let i = 0; i < eventsToInsert.length; i += 200) {
    const chunk = eventsToInsert.slice(i, i + 200);
    const { error } = await supabase
      .from("application_events")
      .upsert(chunk, { onConflict: "user_id,gmail_message_id", ignoreDuplicates: true });
    if (!error) result.newEvents += chunk.length;
  }

  // 8. Persist merged stages/dates for every touched application.
  const touched: AppRec[] = [];
  for (const list of byCompany.values())
    for (const r of list) if (r.touched) touched.push(r);
  await mapLimit(touched, 8, async (r) => {
    await supabase
      .from("applications")
      .update({
        ...(r.locked ? {} : { stage: r.stage }),
        role: r.role,
        role_key: r.role_key,
        dedup_key: `${r.company_key}::${r.role_key}::${r.req ?? ""}`,
        first_email_at: new Date(r.first).toISOString(),
        last_email_at: new Date(r.last).toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", r.id);
  });
  result.applicationsTouched = touched.length;

  await touchSyncState(supabase, userId);
  return result;
}

async function touchSyncState(supabase: SupabaseClient, userId: string) {
  await supabase.from("sync_state").upsert(
    {
      user_id: userId,
      last_synced_at: new Date().toISOString(),
      status: "ok",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );
}
