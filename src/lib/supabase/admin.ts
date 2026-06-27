import { createClient } from "@supabase/supabase-js";

// Service-role client for trusted server jobs (cron). Bypasses RLS, so every
// query MUST still scope by user_id explicitly.
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}
