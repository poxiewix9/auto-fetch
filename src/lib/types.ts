export type Stage =
  | "applied"
  | "oa"
  | "interview"
  | "offer"
  | "accepted"
  | "declined"
  | "rejected";

// The pipeline columns shown on the board / stat strip.
export const STAGES: Stage[] = [
  "applied",
  "oa",
  "interview",
  "offer",
  "rejected",
];

// Every stage, including offer outcomes (used in the modal selector + funnel).
export const ALL_STAGES: Stage[] = [
  "applied",
  "oa",
  "interview",
  "offer",
  "accepted",
  "declined",
  "rejected",
];

// Offer outcomes collapse into the Offer column on the board.
export function boardColumn(stage: Stage): Stage {
  return stage === "accepted" || stage === "declined" ? "offer" : stage;
}

export const STAGE_META: Record<
  Stage,
  {
    label: string;
    short: string;
    rank: number;
    color: string;
    dot: string;
    tint: string;
  }
> = {
  applied: {
    label: "Applied",
    short: "Applied",
    rank: 1,
    color: "bg-black/[0.04] text-ink/70 border-black/10",
    dot: "bg-[#9b9990]",
    tint: "bg-[#9b9990]/[0.06] border-[#9b9990]/25 hover:border-[#9b9990]/45",
  },
  oa: {
    label: "Assessment",
    short: "OA",
    rank: 2,
    color: "bg-[#bb8a3a]/10 text-[#8a6420] border-[#bb8a3a]/30",
    dot: "bg-[#bb8a3a]",
    tint: "bg-[#bb8a3a]/[0.07] border-[#bb8a3a]/25 hover:border-[#bb8a3a]/45",
  },
  interview: {
    label: "Interview",
    short: "Interview",
    rank: 3,
    color: "bg-[#5b7aa8]/10 text-[#3f5c86] border-[#5b7aa8]/30",
    dot: "bg-[#5b7aa8]",
    tint: "bg-[#5b7aa8]/[0.07] border-[#5b7aa8]/25 hover:border-[#5b7aa8]/45",
  },
  offer: {
    label: "Offer",
    short: "Offer",
    rank: 4,
    color: "bg-[#5a8a6b]/12 text-[#3c6b4e] border-[#5a8a6b]/30",
    dot: "bg-[#5a8a6b]",
    tint: "bg-[#5a8a6b]/[0.08] border-[#5a8a6b]/30 hover:border-[#5a8a6b]/50",
  },
  accepted: {
    label: "Accepted",
    short: "Accepted",
    rank: 5,
    color: "bg-[#2f8f5b]/12 text-[#246b44] border-[#2f8f5b]/35",
    dot: "bg-[#2f8f5b]",
    tint: "bg-[#2f8f5b]/[0.10] border-[#2f8f5b]/35 hover:border-[#2f8f5b]/55",
  },
  declined: {
    label: "Declined",
    short: "Declined",
    rank: 4,
    color: "bg-[#7a756c]/12 text-[#5f5b53] border-[#7a756c]/35",
    dot: "bg-[#7a756c]",
    tint: "bg-[#7a756c]/[0.07] border-[#7a756c]/30 hover:border-[#7a756c]/45",
  },
  rejected: {
    label: "Rejected",
    short: "Rejected",
    rank: 0,
    color: "bg-[#b06a5f]/10 text-[#8c4a40] border-[#b06a5f]/30",
    dot: "bg-[#b06a5f]",
    tint: "bg-[#b06a5f]/[0.06] border-[#b06a5f]/25 hover:border-[#b06a5f]/45",
  },
};

export interface ApplicationEvent {
  id: string;
  application_id: string;
  user_id: string;
  stage: Stage;
  subject: string | null;
  sender: string | null;
  snippet: string | null;
  body: string | null;
  gmail_message_id: string;
  email_at: string;
  created_at: string;
}

export interface Application {
  id: string;
  user_id: string;
  company: string;
  role: string | null;
  stage: Stage;
  dedup_key: string;
  locked: boolean;
  first_email_at: string;
  last_email_at: string;
  created_at: string;
  updated_at: string;
  application_events?: ApplicationEvent[];
}

export interface Classification {
  relevant: boolean;
  stage: Stage;
  company: string;
  role: string | null;
  /** Requisition/job ID when stated — distinguishes same-title applications. */
  req?: string | null;
  confidence: number;
  source: "rules" | "llm";
}
