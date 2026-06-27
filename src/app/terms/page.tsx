import Link from "next/link";
import { TallyLogo } from "@/components/logo";

export const metadata = { title: "Terms of Service — Tally" };

export default function Terms() {
  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-12">
      <Link href="/" className="inline-block">
        <TallyLogo />
      </Link>
      <h1 className="mt-10 text-3xl font-semibold tracking-tight text-ink">
        Terms of Service
      </h1>
      <p className="mt-2 text-sm text-faint">Last updated: June 27, 2026</p>

      <div className="mt-8 space-y-6 text-sm leading-relaxed text-muted">
        <section>
          <h2 className="text-base font-medium text-ink">The service</h2>
          <p className="mt-2">
            Tally is a personal tool that reads your Gmail (read-only) to organize
            your job and internship applications. It is provided as-is, without
            warranty of any kind. Classification is automated and may occasionally be
            inaccurate — always verify important details against the original email.
          </p>
        </section>

        <section>
          <h2 className="text-base font-medium text-ink">Your responsibilities</h2>
          <p className="mt-2">
            You are responsible for keeping your account secure and for the accuracy
            of any manual edits you make. Don&apos;t use Tally to access an inbox you
            are not authorized to access.
          </p>
        </section>

        <section>
          <h2 className="text-base font-medium text-ink">Availability &amp; changes</h2>
          <p className="mt-2">
            We may update, suspend, or discontinue the service at any time. We may
            update these terms; continued use after changes constitutes acceptance.
          </p>
        </section>

        <section>
          <h2 className="text-base font-medium text-ink">Liability</h2>
          <p className="mt-2">
            To the maximum extent permitted by law, Tally and its operators are not
            liable for any indirect or consequential damages arising from use of the
            service, including missed opportunities due to misclassified email.
          </p>
        </section>

        <section>
          <h2 className="text-base font-medium text-ink">Termination</h2>
          <p className="mt-2">
            You can stop using Tally and delete your data at any time from the account
            menu. Deleting your account removes all stored data and revokes stored
            access tokens.
          </p>
        </section>

        <section>
          <h2 className="text-base font-medium text-ink">Contact</h2>
          <p className="mt-2">
            Questions? Email{" "}
            <a className="text-ink underline" href="mailto:keshav.singh@utexas.edu">
              keshav.singh@utexas.edu
            </a>
            .
          </p>
        </section>
      </div>

      <div className="mt-10 border-t border-line pt-6 text-sm">
        <Link href="/privacy" className="text-ink underline">
          Privacy Policy
        </Link>
      </div>
    </main>
  );
}
