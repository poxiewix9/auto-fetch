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
    // Log details server-side only; never leak internals to the user URL.
    console.error(
      "[auth/callback] exchangeCodeForSession failed:",
      error?.message ?? "no_session"
    );
    return NextResponse.redirect(`${origin}/?error=auth_failed`);
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
