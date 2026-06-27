import { createClient } from "@/lib/supabase/server";
import { Dashboard } from "./dashboard/dashboard";
import type { Application } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return (
      <Dashboard
        email=""
        applications={[]}
        lastSyncedAt={null}
        signedIn={false}
      />
    );
  }

  const { data: applications } = await supabase
    .from("applications")
    .select(
      "*, application_events(id, application_id, user_id, stage, subject, sender, snippet, body, gmail_message_id, email_at, created_at)"
    )
    .order("last_email_at", { ascending: false });

  const { data: sync } = await supabase
    .from("sync_state")
    .select("last_synced_at")
    .eq("user_id", user.id)
    .maybeSingle();

  return (
    <Dashboard
      email={user.email ?? ""}
      applications={(applications ?? []) as Application[]}
      lastSyncedAt={sync?.last_synced_at ?? null}
      signedIn
    />
  );
}
