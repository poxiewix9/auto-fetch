import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { syncUser } from "@/lib/sync";

export const maxDuration = 300;

// Scheduled sync for every connected user. Protect with CRON_SECRET and call
// from Vercel Cron (vercel.json) or any external scheduler.
export async function GET(request: Request) {
  // Fail closed: the endpoint runs with the service role (bypasses RLS for ALL
  // users), so it must never be callable without the shared secret. Vercel Cron
  // injects this Authorization header automatically when CRON_SECRET is set.
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "Cron disabled: CRON_SECRET not configured" },
      { status: 401 }
    );
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json(
      { error: "SUPABASE_SERVICE_ROLE_KEY not configured" },
      { status: 500 }
    );
  }

  const admin = createAdminClient();
  const { data: tokens } = await admin
    .from("gmail_tokens")
    .select("user_id");

  const results: Record<string, unknown> = {};
  for (const row of tokens ?? []) {
    try {
      results[row.user_id] = await syncUser(admin, row.user_id);
    } catch (e) {
      results[row.user_id] = {
        error: e instanceof Error ? e.message : "failed",
      };
    }
  }

  return NextResponse.json({ users: tokens?.length ?? 0, results });
}
