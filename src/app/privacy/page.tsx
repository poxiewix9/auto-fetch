import Link from "next/link";
import { TallyLogo } from "@/components/logo";

export const metadata = { title: "Privacy Policy — Tally" };

export default function Privacy() {
  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-12">
      <Link href="/" className="inline-block">
        <TallyLogo />
      </Link>
      <h1 className="mt-10 text-3xl font-semibold tracking-tight text-ink">
        Privacy Policy
      </h1>
      <p className="mt-2 text-sm text-faint">Last updated: June 27, 2026</p>

      <div className="mt-8 space-y-6 text-sm leading-relaxed text-muted">
        <section>
          <h2 className="text-base font-medium text-ink">What Tally accesses</h2>
          <p className="mt-2">
            With your explicit consent, Tally requests <strong>read-only</strong> access to
            your Gmail (<code>gmail.readonly</code>). We scan messages to identify
            job and internship application updates — confirmations, assessments,
            interviews, offers, and rejections. Tally never sends, deletes, or
            modifies your email, and never accesses anything beyond reading messages.
          </p>
        </section>

        <section>
          <h2 className="text-base font-medium text-ink">What we store</h2>
          <p className="mt-2">
            We store the structured results of that classification (company, role,
            stage), the related message metadata and content needed to show you the
            email, your account email address, and an{" "}
            <strong>encrypted</strong> Google refresh token used to sync on your
            behalf. Data is isolated per user with database row-level security.
          </p>
        </section>

        <section>
          <h2 className="text-base font-medium text-ink">How we use it</h2>
          <p className="mt-2">
            Your data is used solely to provide your personal application tracker. We
            do not sell it, use it for advertising, or share it with anyone except the
            infrastructure providers that run the product (Supabase for
            authentication and database, and Google Gemini to classify email text).
          </p>
        </section>

        <section>
          <h2 className="text-base font-medium text-ink">Limited Use disclosure</h2>
          <p className="mt-2">
            Tally&apos;s use and transfer of information received from Google APIs
            adheres to the{" "}
            <a
              className="text-ink underline"
              href="https://developers.google.com/terms/api-services-user-data-policy"
              target="_blank"
              rel="noreferrer"
            >
              Google API Services User Data Policy
            </a>
            , including its Limited Use requirements.
          </p>
        </section>

        <section>
          <h2 className="text-base font-medium text-ink">Retention &amp; deletion</h2>
          <p className="mt-2">
            You can permanently delete your account and all associated data at any
            time from the account menu in the app. You may also revoke Tally&apos;s
            access from your{" "}
            <a
              className="text-ink underline"
              href="https://myaccount.google.com/permissions"
              target="_blank"
              rel="noreferrer"
            >
              Google Account permissions
            </a>
            .
          </p>
        </section>

        <section>
          <h2 className="text-base font-medium text-ink">Security</h2>
          <p className="mt-2">
            Refresh tokens are encrypted at rest, all traffic is over HTTPS, and every
            database query is scoped to the authenticated user via row-level security.
          </p>
        </section>

        <section>
          <h2 className="text-base font-medium text-ink">Contact</h2>
          <p className="mt-2">
            Questions about your data? Email{" "}
            <span className="text-ink">your-email@example.com</span>.
          </p>
        </section>
      </div>

      <div className="mt-10 border-t border-line pt-6 text-sm">
        <Link href="/terms" className="text-ink underline">
          Terms of Service
        </Link>
      </div>
    </main>
  );
}
