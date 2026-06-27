import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { normCompany, normRole } from "@/lib/classifier";
import { ALL_STAGES, type Stage } from "@/lib/types";

async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, user };
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { supabase, user } = await requireUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (typeof body.stage === "string") {
    if (!ALL_STAGES.includes(body.stage as Stage)) {
      return NextResponse.json({ error: "Invalid stage" }, { status: 400 });
    }
    update.stage = body.stage;
    update.locked = true; // manual stage survives future syncs
  }
  if (typeof body.company === "string" && body.company.trim()) {
    update.company = body.company.trim();
    update.company_key = normCompany(body.company);
  }
  if (typeof body.role === "string") {
    const role = body.role.trim() || null;
    update.role = role;
    update.role_key = normRole(role);
  }

  const { error } = await supabase
    .from("applications")
    .update(update)
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { supabase, user } = await requireUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { error } = await supabase
    .from("applications")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
