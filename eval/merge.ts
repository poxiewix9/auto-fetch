/**
 * Stage-merge checks.
 *
 * `npm run eval` scores the classifier (one email -> one classification). This
 * covers the other half: how several emails for the SAME application collapse
 * into a single card stage. Run with `npm run eval:merge`.
 */
import { __test } from "../src/lib/sync";
import type { Stage } from "../src/lib/types";

const { mergeStage } = __test;

const OLDER = false;
const NEWER = true;

interface Case {
  name: string;
  current: Stage;
  incoming: Stage;
  newer: boolean;
  want: Stage;
}

const CASES: Case[] = [
  // --- normal forward progression -----------------------------------------
  { name: "applied -> oa advances", current: "applied", incoming: "oa", newer: NEWER, want: "oa" },
  { name: "oa -> interview advances", current: "oa", incoming: "interview", newer: NEWER, want: "interview" },
  { name: "interview -> offer advances", current: "interview", incoming: "offer", newer: NEWER, want: "offer" },
  { name: "interview -> rejected advances", current: "interview", incoming: "rejected", newer: NEWER, want: "rejected" },

  // --- the ratchet: stale/duplicate mail must not drag a card backwards ----
  { name: "interview does NOT fall back to applied", current: "interview", incoming: "applied", newer: NEWER, want: "interview" },
  { name: "offer does NOT fall back to interview", current: "offer", incoming: "interview", newer: NEWER, want: "offer" },
  { name: "offer outranks a rejection for another req", current: "offer", incoming: "rejected", newer: NEWER, want: "offer" },
  { name: "accepted is never downgraded", current: "accepted", incoming: "applied", newer: NEWER, want: "accepted" },

  // --- rejection is terminal only until something NEWER contradicts it ----
  { name: "re-applying after a rejection reopens the card", current: "rejected", incoming: "applied", newer: NEWER, want: "applied" },
  { name: "a newer interview reopens a rejected card", current: "rejected", incoming: "interview", newer: NEWER, want: "interview" },
  { name: "a newer offer reopens a rejected card", current: "rejected", incoming: "offer", newer: NEWER, want: "offer" },
  { name: "a second rejection stays rejected", current: "rejected", incoming: "rejected", newer: NEWER, want: "rejected" },

  // --- ...but only when it is genuinely newer -----------------------------
  {
    name: "backfilled OLD application mail does not reopen a rejection",
    current: "rejected",
    incoming: "applied",
    newer: OLDER,
    want: "rejected",
  },
  {
    name: "backfilled OLD interview mail does not reopen a rejection",
    current: "rejected",
    incoming: "interview",
    newer: OLDER,
    want: "rejected",
  },
];

let failed = 0;
for (const c of CASES) {
  const got = mergeStage(c.current, c.incoming, c.newer);
  const ok = got === c.want;
  if (!ok) failed++;
  const age = c.newer ? "newer" : "older";
  console.log(
    `${ok ? " ✓" : " ✗"} ${c.name}\n    ${c.current} + ${c.incoming} (${age}) -> ${got}${
      ok ? "" : `  [want ${c.want}]`
    }`
  );
}

console.log(`\n ── ${CASES.length - failed}/${CASES.length} pass`);
if (failed) process.exit(1);
