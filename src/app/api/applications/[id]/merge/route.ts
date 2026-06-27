import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { Stage } from "@/lib/types";

const PROGRESSION: Record<Stage, number> = {
  applied: 1,
  oa: 2,
  interview: 3,
  rejected: 4,
  offer: 5,
  declined: 6,
  accepted: 7,
};

/**
 * Merge another application (`sourceId` in the body) INTO the application in
 * the URL (the survivor). All events move to the survivor, its stage/dates are
 * recomputed, and the source row is deleted.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: targetId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const sourceId = typeof body.sourceId === "string" ? body.sourceId : null;
  if (!sourceId || sourceId === targetId) {
    return NextResponse.json({ error: "Invalid merge target" }, { status: 400 });
  }

  const { data: apps, error: appsErr } = await supabase
    .from("applications")
    .select("id, role, stage, locked")
    .eq("user_id", user.id)
    .in("id", [targetId, sourceId]);
  if (appsErr) return NextResponse.json({ error: appsErr.message }, { status: 500 });

  const target = apps?.find((a) => a.id === targetId);
  const source = apps?.find((a) => a.id === sourceId);
  if (!target || !source) {
    return NextResponse.json({ error: "Application not found" }, { status: 404 });
  }

  // Move all of source's events onto the survivor.
  const { error: moveErr } = await supabase
    .from("application_events")
    .update({ application_id: targetId })
    .eq("user_id", user.id)
    .eq("application_id", sourceId);
  if (moveErr) return NextResponse.json({ error: moveErr.message }, { status: 500 });

  // Recompute survivor from its (now combined) events.
  const { data: events } = await supabase
    .from("application_events")
    .select("stage, email_at")
    .eq("user_id", user.id)
    .eq("application_id", targetId);

  let first = Date.now();
  let last = 0;
  let bestStage: Stage = target.stage as Stage;
  for (const e of events ?? []) {
    const t = new Date(e.email_at).getTime();
    if (t < first) first = t;
    if (t > last) last = t;
    if (!target.locked && PROGRESSION[e.stage as Stage] > PROGRESSION[bestStage]) {
      bestStage = e.stage as Stage;
    }
  }

  await supabase
    .from("applications")
    .update({
      role: target.role ?? source.role,
      ...(target.locked ? {} : { stage: bestStage }),
      ...(last ? { first_email_at: new Date(first).toISOString(), last_email_at: new Date(last).toISOString() } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", targetId)
    .eq("user_id", user.id);

  // Remove the now-empty source row.
  const { error: delErr } = await supabase
    .from("applications")
    .delete()
    .eq("id", sourceId)
    .eq("user_id", user.id);
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
