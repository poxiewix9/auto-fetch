/**
 * Classifier eval harness.
 *
 * Runs src/lib/classifier.ts over labeled email fixtures and scores
 * relevance / stage / company / role per case. Fixtures live in
 * eval/fixtures/*.json.
 *
 * Usage:
 *   npm run eval                 # dev + synthetic fixtures, rules path
 *   npm run eval -- --llm        # also run the Gemini path (needs GEMINI_API_KEY)
 *   npm run eval -- --holdout    # include the holdout set (final check ONLY —
 *                                # iterating against it defeats its purpose)
 *   npm run eval -- --only=<id-substring>   # run matching fixtures
 *   npm run eval -- --verbose    # print every case, not just failures
 *
 * Scoring:
 *   relevant — exact boolean match. If expected relevant=false, nothing else
 *              is scored (an irrelevant email's other fields don't matter).
 *   stage    — exact match.
 *   company  — normCompany() equality against any accepted variant.
 *              Expected null means "classifier must NOT invent a company":
 *              accepts "Unknown Company" (the sync layer drops those).
 *   role     — normRole() equality against any accepted variant; null means
 *              the classifier must return no role (junk roles split cards).
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));

// Load .env.local if present (for --llm runs).
const envPath = join(ROOT, "..", ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
}

const ARGS = process.argv.slice(2);
const RUN_LLM = ARGS.includes("--llm");
const INCLUDE_HOLDOUT = ARGS.includes("--holdout");
const VERBOSE = ARGS.includes("--verbose");
const ONLY = ARGS.find((a) => a.startsWith("--only="))?.slice(7) ?? null;
if (!RUN_LLM) process.env.LLM_PROVIDER = "none";

import type { Stage } from "../src/lib/types";

interface Fixture {
  id: string;
  source: "real" | "synthetic";
  split: "dev" | "holdout";
  note?: string;
  email: { subject: string; fromName: string; fromEmail: string; body: string };
  expect: {
    relevant: boolean;
    stage?: Stage;
    company?: string | string[] | null;
    role?: string | string[] | null;
  };
}

interface CaseResult {
  id: string;
  pass: boolean;
  fields: { field: string; want: string; got: string }[];
}

function loadFixtures(): Fixture[] {
  const dir = join(ROOT, "fixtures");
  const out: Fixture[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const arr = JSON.parse(readFileSync(join(dir, f), "utf-8")) as Fixture[];
    out.push(...arr);
  }
  const ids = new Set<string>();
  for (const f of out) {
    if (ids.has(f.id)) throw new Error(`duplicate fixture id: ${f.id}`);
    ids.add(f.id);
  }
  return out;
}

async function main() {
  const { classifyWithRules, classifyEmails, normCompany, normRole } = await import(
    "../src/lib/classifier"
  );

  let fixtures = loadFixtures();
  const total = fixtures.length;
  if (!INCLUDE_HOLDOUT) fixtures = fixtures.filter((f) => f.split !== "holdout");
  if (ONLY) fixtures = fixtures.filter((f) => f.id.includes(ONLY));
  console.log(
    `fixtures: ${fixtures.length}/${total} (holdout ${INCLUDE_HOLDOUT ? "INCLUDED" : "excluded"})${ONLY ? ` only=${ONLY}` : ""}`
  );

  const emails = fixtures.map((f, i) => ({
    id: `fixture-${i}`,
    threadId: "",
    subject: f.email.subject,
    fromName: f.email.fromName,
    fromEmail: f.email.fromEmail,
    date: new Date("2026-01-15T12:00:00Z"),
    snippet: f.email.body.slice(0, 200),
    body: f.email.body,
  }));

  const modes: { name: string; results: Awaited<ReturnType<typeof classifyEmails>> }[] = [];

  modes.push({ name: "rules", results: emails.map(classifyWithRules) });

  if (RUN_LLM) {
    const llmResults: (typeof modes)[number]["results"] = [];
    const BATCH = 10;
    for (let i = 0; i < emails.length; i += BATCH) {
      llmResults.push(...(await classifyEmails(emails.slice(i, i + BATCH))));
    }
    const nLlm = llmResults.filter((r) => r.source === "llm").length;
    console.log(`llm coverage: ${nLlm}/${llmResults.length} (rest fell back to rules)`);
    modes.push({ name: "llm", results: llmResults });
  }

  let anyFail = false;

  for (const mode of modes) {
    const results: CaseResult[] = fixtures.map((f, i) => {
      const c = mode.results[i];
      const fields: CaseResult["fields"] = [];

      if (c.relevant !== f.expect.relevant) {
        fields.push({ field: "relevant", want: String(f.expect.relevant), got: String(c.relevant) });
      }

      // Only score the rest when the email is supposed to be relevant AND the
      // classifier agreed (otherwise stage/company/role are moot).
      if (f.expect.relevant && c.relevant) {
        if (f.expect.stage && c.stage !== f.expect.stage) {
          fields.push({ field: "stage", want: f.expect.stage, got: c.stage });
        }
        if (f.expect.company !== undefined) {
          const wants = f.expect.company === null ? [null] : [f.expect.company].flat();
          const gotKey = c.company === "Unknown Company" ? null : normCompany(c.company);
          const ok = wants.some((w) =>
            w === null ? gotKey === null : gotKey === normCompany(w)
          );
          if (!ok) {
            fields.push({
              field: "company",
              want: wants.map((w) => w ?? "(none)").join(" | "),
              got: c.company,
            });
          }
        }
        if (f.expect.role !== undefined) {
          const wants = f.expect.role === null ? [null] : [f.expect.role].flat();
          const gotKey = normRole(c.role);
          const ok = wants.some((w) =>
            w === null ? gotKey === "" : gotKey === normRole(w)
          );
          if (!ok) {
            fields.push({
              field: "role",
              want: wants.map((w) => w ?? "(none)").join(" | "),
              got: c.role ?? "(none)",
            });
          }
        }
      }

      return { id: f.id, pass: fields.length === 0, fields };
    });

    const byGroup = new Map<string, { pass: number; fail: number }>();
    for (let i = 0; i < fixtures.length; i++) {
      const key = `${fixtures[i].split}/${fixtures[i].source}`;
      const g = byGroup.get(key) ?? { pass: 0, fail: 0 };
      if (results[i].pass) g.pass++;
      else g.fail++;
      byGroup.set(key, g);
    }

    const failed = results.filter((r) => !r.pass);
    if (failed.length) anyFail = true;

    console.log(`\n═══ ${mode.name.toUpperCase()} ═══`);
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.pass && !VERBOSE) continue;
      console.log(` ${r.pass ? "✓" : "✗"} ${r.id}${fixtures[i].note ? `  (${fixtures[i].note})` : ""}`);
      for (const f of r.fields) {
        console.log(`     ${f.field}: want ${f.want}, got ${f.got}`);
      }
    }
    console.log(` ── ${results.length - failed.length}/${results.length} pass`);
    for (const [k, g] of [...byGroup.entries()].sort()) {
      console.log(`    ${k}: ${g.pass}/${g.pass + g.fail}`);
    }
  }

  process.exit(anyFail ? 1 : 0);
}

main().catch((e) => {
  console.error("eval failed:", e);
  process.exit(1);
});
