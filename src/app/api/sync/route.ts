import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { syncUser } from "@/lib/sync";

export const maxDuration = 60;

// Per-user cooldown to stop a client from hammering sync (and our LLM bill).
// In-memory is per-instance — a cheap guard, not a hard distributed limit.
const COOLDOWN_MS = 12_000;
const lastSync = new Map<string, number>();

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const now = Date.now();
  const prev = lastSync.get(user.id) ?? 0;
  if (now - prev < COOLDOWN_MS) {
    return NextResponse.json(
      { error: "You're syncing too fast — give it a few seconds." },
      { status: 429 }
    );
  }
  lastSync.set(user.id, now);

  const body = await request.json().catch(() => ({}));
  let maxMessages: number | undefined;
  if (typeof body.maxMessages === "number" && Number.isFinite(body.maxMessages)) {
    maxMessages = Math.min(Math.max(Math.round(body.maxMessages), 10), 1000);
  }

  try {
    const result = await syncUser(supabase, user.id, { maxMessages });
    const status = result.error ? 400 : 200;
    return NextResponse.json(result, { status });
  } catch (e) {
    console.error("sync failed", e);
    return NextResponse.json({ error: "Sync failed. Please try again." }, { status: 500 });
  }
}
