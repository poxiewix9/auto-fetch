import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { encryptToken } from "@/lib/crypto";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/";

  if (!code) {
    return NextResponse.redirect(`${origin}/?error=missing_code`);
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error || !data.session) {
    const reason = error?.message ?? "no_session";
    // The anon/publishable key is public (it ships to the browser), so it's
    // safe to fingerprint here. This tells us whether Vercel actually has the
    // env var set vs. whether Supabase is rejecting a wrong value.
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
    const keyInfo = key
      ? `${key.slice(0, 14)}…len${key.length}`
      : "MISSING";
    const urlInfo = url ? url : "MISSING";
    console.error(
      `[auth/callback] exchangeCodeForSession failed: ${reason} | key=${keyInfo} | url=${urlInfo}`
    );
    return NextResponse.redirect(
      `${origin}/?error=auth_failed&reason=${encodeURIComponent(
        reason
      )}&key=${encodeURIComponent(keyInfo)}&url=${encodeURIComponent(urlInfo)}`
    );
  }

  // Persist the Google refresh token so we can sync Gmail server-side later.
  // Wrapped so a token-storage hiccup can never block a successful sign-in.
  try {
    const refreshToken = data.session.provider_refresh_token;
    if (refreshToken && data.user) {
      await supabase.from("gmail_tokens").upsert(
        {
          user_id: data.user.id,
          refresh_token: encryptToken(refreshToken),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" }
      );
    }
  } catch (e) {
    console.error("[auth/callback] failed to persist gmail token:", e);
  }

  return NextResponse.redirect(`${origin}${next}`);
}
