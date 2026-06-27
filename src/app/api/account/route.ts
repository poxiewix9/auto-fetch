import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Permanently delete the signed-in user's data (and their auth account if a
// service-role key is configured). Application rows cascade to their events.
export async function DELETE() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  try {
    // RLS scopes these to the current user; deleting applications cascades to
    // application_events via the FK.
    await supabase.from("applications").delete().eq("user_id", user.id);
    await supabase.from("application_events").delete().eq("user_id", user.id);
    await supabase.from("gmail_tokens").delete().eq("user_id", user.id);
    await supabase.from("sync_state").delete().eq("user_id", user.id);

    if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
      const admin = createAdminClient();
      await admin.auth.admin.deleteUser(user.id);
    }
    await supabase.auth.signOut();

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("account deletion failed", e);
    return NextResponse.json(
      { error: "Could not delete account. Please try again." },
      { status: 500 }
    );
  }
}
