import type { Classification, Stage } from "./types";
import { fetchWithTimeout, type ParsedEmail } from "./gmail";

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

// Applicant Tracking System senders. Mail from these is almost always a real
// application-funnel email, so we trust it even without strong phrasing.
const ATS_DOMAINS = [
  "greenhouse.io",
  "greenhouse-mail.io",
  "lever.co",
  "hire.lever.co",
  "myworkday.com",
  "myworkdayjobs.com",
  "workday.com",
  "ashbyhq.com",
  "icims.com",
  "smartrecruiters.com",
  "jobvite.com",
  "taleo.net",
  "successfactors.com",
  "workable.com",
  "breezy.hr",
  "bamboohr.com",
  "rippling.com",
  "oraclecloud.com",
  "myworkdaysite.com",
  "eightfold.ai",
  "paradox.ai",
  "hirevue.com",
  "ripplingats.com",
];

// Newsletters / news / social that pollute keyword matches. If the sender is
// here and there's no ATS/strong signal, we drop the email.
const NOISE_DOMAINS = [
  "nytimes.com",
  "cnn.com",
  "quora.com",
  "substack.com",
  "medium.com",
  "dailytexan.com",
  "washingtonpost.com",
  "bloomberg.com",
  "techcrunch.com",
  "morningbrew.com",
  "theinformation.com",
  "reddit.com",
  "facebookmail.com",
  "twitter.com",
  "x.com",
  "youtube.com",
  "spotify.com",
  "news",
  "newsletter",
  "digest",
  "marketing",
];

// Stage detection. Patterns are deliberately high-precision: the bare word
// "interview" or "offer" is NOT enough (newsletters use those), we require
// application/scheduling context.
const STAGE_PATTERNS: { stage: Stage; patterns: RegExp[] }[] = [
  {
    stage: "rejected",
    patterns: [
      /\bunfortunately\b/i,
      /\bregret to inform\b/i,
      /\bwe have decided (?:not|to move forward with other)/i,
      /\b(?:not|won['’]t) be (?:moving|progressing) (?:forward|ahead)\b/i,
      /\bnot to move forward\b/i,
      /\bmove forward with other candidates\b/i,
      /\bother candidates\b/i,
      // Require a past-tense auxiliary so a decisive "you were not selected"
      // matches but a conditional "if you are not selected" (common in
      // application *confirmations*) does not.
      /\b(?:have|has|had|were|was) not (?:been )?(?:selected|chosen)\b/i,
      /\bno longer (?:be )?under consideration\b/i,
      /\bdecided not to (?:proceed|move)\b/i,
      /\bafter careful consideration\b/i,
      /\bwe are unable to (?:offer|move|proceed)\b/i,
      /\bwill not be moving forward\b/i,
      /\bposition has been filled\b/i,
    ],
  },
  {
    stage: "offer",
    patterns: [
      /\bpleased to offer\b/i,
      /\bexcited to offer\b/i,
      /\bdelighted to offer\b/i,
      /\bextend(?:ing)? (?:you )?an offer\b/i,
      /\boffer of (?:employment|internship)\b/i,
      /\boffer letter\b/i,
      /\bwe(?:'| woul)d like to offer\b/i,
      // "your offer letter / your offer details" is a real signal; a bare
      // "your job offer" is NOT — it matches fraud-warning newsletters
      // ("the authenticity of your job offer"). Require positive context.
      /\byour offer (?:letter|details|package)\b/i,
      /\bcongratulations\b[\s\S]{0,80}\boffer\b/i,
    ],
  },
  {
    stage: "interview",
    patterns: [
      /\binvit(?:e|ation|ing) (?:you )?(?:to|for)(?: an?| the)? (?:interview|phone screen)/i,
      /\b(?:schedule|set up|arrange|book) (?:a |an |your |some time for )?(?:phone |video |technical |onsite )?(?:interview|screen|call|chat|conversation)\b/i,
      /\bphone screen\b/i,
      /\btechnical (?:interview|screen)\b/i,
      /\bonsite interview\b/i,
      /\binterview (?:invitation|invite|request)\b/i,
      /\b(?:would like to|like to|want to) (?:speak|chat|meet|connect) (?:with you )?(?:about|regarding) (?:your application|the (?:role|position))/i,
      /\bavailability (?:for|to schedule)\b.*\b(?:interview|call|chat)\b/i,
      // Only a genuinely interview-specific "next step". The old version also
      // matched "next step in the process/application", which fires on OA and
      // confirmation emails (e.g. IBM's assessment invite).
      /\bnext (?:round|step)s? (?:in|of) (?:the |your |our )?(?:interviews?|hiring process)\b/i,
      /\bhiring manager (?:would like|wants)\b/i,
    ],
  },
  {
    stage: "oa",
    patterns: [
      /\bonline assessment\b/i,
      /\bcoding (?:assessment|challenge|test)\b/i,
      /\btechnical assessment\b/i,
      /\btake[- ]home (?:assignment|assessment|challenge|test)\b/i,
      /\bhackerrank\b/i,
      /\bcodesignal\b/i,
      /\bcodility\b/i,
      /\bcomplete (?:the |your )?(?:online )?assessment\b/i,
      /\bskills? assessment\b/i,
      /\bassessment invitation\b/i,
    ],
  },
  {
    stage: "applied",
    patterns: [
      /\bthank you for applying\b/i,
      /\bthank you for your (?:application|interest in)\b/i,
      /\bapplication (?:has been |was )?received\b/i,
      /\b(?:we|we've|we have) received your application\b/i,
      /\byour application (?:to|for|has been|was|is)\b/i,
      /\bsuccessfully (?:applied|submitted your application)\b/i,
      /\bapplication (?:has been |was )?submitted\b/i,
      /\bapplication confirmation\b/i,
      /\bwe(?:'ve| have) got your application\b/i,
      /\bthanks for applying\b/i,
    ],
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function domainOf(email: string): string {
  return (email.split("@")[1] || "").toLowerCase();
}

function isAts(domain: string): boolean {
  return ATS_DOMAINS.some((d) => domain.includes(d));
}

function isNoise(domain: string): boolean {
  return NOISE_DOMAINS.some((d) => domain.includes(d));
}

// Assessment/interview PLATFORMS. Mail comes *from* these on behalf of a real
// employer, so their name/domain must never be used as the company (the hiring
// company is named in the subject/body, e.g. "Susquehanna invited you ...").
const VENDOR_DOMAINS = [
  "codesignal.com",
  "hackerrank.com",
  "hackerearth.com",
  "codility.com",
  "coderpad.io",
  "karat.com",
  "hirevue.com",
  "codesubmit.io",
  "qualified.io",
  "testgorilla.com",
];
const VENDOR_NAMES = new Set([
  "codesignal", "hackerrank", "hackerearth", "codility", "coderpad",
  "karat", "hirevue", "codesubmit", "qualified", "testgorilla",
]);

function isVendorDomain(domain: string): boolean {
  return VENDOR_DOMAINS.some((d) => domain.includes(d));
}

function isVendorName(name: string): boolean {
  return VENDOR_NAMES.has(name.toLowerCase().replace(/[^a-z]/g, ""));
}

function titleCase(s: string): string {
  return s
    .trim()
    .split(/\s+/)
    .map((w) => (w.length > 1 ? w[0].toUpperCase() + w.slice(1) : w.toUpperCase()))
    .join(" ");
}

const COMPANY_NOISE_WORDS =
  /\b(careers?|recruiting|recruitment|recruiter|talent|talent acquisition|hr|human resources|team|hiring|jobs?|notifications?|notification|no[\s-]?reply|do[\s-]?not[\s-]?reply|donotreply|mailer|admin|info|hello|support|via|workday|greenhouse|lever|ashby|icims|smartrecruiters|jobvite|taleo|workable|inc|llc|ltd|corp|co)\b/gi;

function cleanCompany(raw: string): string | null {
  let c = raw
    .replace(/[“”"']/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s,.-]+|[\s,.:;!?-]+$/g, "")
    .trim();
  // Strip an email-ish token.
  if (/@/.test(c) || /\.com|\.io|\.co|\.org|\.net/i.test(c)) return null;
  c = c.replace(COMPANY_NOISE_WORDS, "").replace(/\s+/g, " ").trim();
  if (!c || c.length < 2) return null;
  if (/^(the|your|our|a|an|we|this|that)$/i.test(c)) return null;
  if (c.length > 45) c = c.slice(0, 45).trim();
  return titleCase(c);
}

// Funnel-only ranking used to break ties among non-decisive stages.
const FUNNEL_RANK: Partial<Record<Stage, number>> = { interview: 3, oa: 2, applied: 1 };

/**
 * Decide a single email's stage from how many patterns of each stage it hits.
 *
 * This is evidence-based rather than pure first-match-by-priority: an OA email
 * that incidentally trips one interview phrase shouldn't be filed as an
 * interview when its assessment signals are stronger. BUT the decisive
 * terminal stages (rejected / offer) still win outright when their (now
 * high-precision) patterns fire — otherwise a rejection that also says
 * "thank you for applying" would be scored down to "applied".
 */
function detectStage(haystack: string): { stage: Stage; confidence: number } | null {
  const hits: Partial<Record<Stage, number>> = {};
  for (const { stage, patterns } of STAGE_PATTERNS) {
    const n = patterns.filter((p) => p.test(haystack)).length;
    if (n > 0) hits[stage] = n;
  }
  const conf = (n: number) => Math.min(0.55 + n * 0.15, 0.95);

  // Decisive stages override (checked in funnel-terminal order).
  if (hits.rejected) return { stage: "rejected", confidence: conf(hits.rejected) };
  if (hits.offer) return { stage: "offer", confidence: conf(hits.offer) };

  // Among the rest, most evidence wins; ties go to the more advanced stage.
  let best: Stage | null = null;
  for (const s of ["interview", "oa", "applied"] as Stage[]) {
    const n = hits[s];
    if (!n) continue;
    if (
      best === null ||
      n > hits[best]! ||
      (n === hits[best]! && FUNNEL_RANK[s]! > FUNNEL_RANK[best]!)
    ) {
      best = s;
    }
  }
  return best ? { stage: best, confidence: conf(hits[best]!) } : null;
}

function extractCompany(email: ParsedEmail): string {
  const { subject, body, fromName, fromEmail } = email;
  const text = `${subject}\n${body.slice(0, 600)}`;
  const domain = domainOf(fromEmail);

  // 1) Subject/body relationship patterns.
  const patterns = [
    // Employer named in vendor/recruiter mail ("Susquehanna invited you ...",
    // "interest in Susquehanna", "someone from Susquehanna to take ..."). These
    // run first so a CodeSignal/recruiter email resolves to the real company.
    /([A-Z][A-Za-z0-9&.\- ]{1,40}?) (?:invited you|is waiting for)\b/,
    /\bfrom ([A-Z][A-Za-z0-9&.\- ]{1,40}?) to (?:take|complete|schedule)\b/,
    /\binterest(?:ed)? in ([A-Z][A-Za-z0-9&.\- ]{1,40}?)(?:[.,!?\n]|$|\s+for\b)/,
    /(?:applying|application)\s+(?:to|with|at)\s+([A-Z][A-Za-z0-9&.\- ]{1,40}?)(?:[.,!?\n]|$|\s+for\b|\s+as\b|\s+team\b)/,
    /thank you for applying(?:\s+to)?\s+([A-Z][A-Za-z0-9&.\- ]{1,40}?)(?:[.,!?\n]|$|\s+for\b)/i,
    /(?:interview|opportunity|position|role|internship)\s+(?:at|with)\s+([A-Z][A-Za-z0-9&.\- ]{1,40}?)(?:[.,!?\n]|$|\s+team\b)/,
    /\bat\s+([A-Z][A-Za-z0-9&.\- ]{1,40}?)\s+(?:internship|position|role|team)\b/,
    /welcome to (?:the )?([A-Z][A-Za-z0-9&.\- ]{1,40}?)(?:[.,!?\n]| team| family)/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m?.[1]) {
      const c = cleanCompany(m[1]);
      if (c) return c;
    }
  }

  // 2) Sender display name (ATS usually sets this to the company), unless it's
  //    obviously a person (recruiter) like "Negron, Jennifer", or an assessment
  //    vendor (CodeSignal/HackerRank) which is never the employer.
  if (fromName && !looksLikePerson(fromName) && !isVendorName(fromName)) {
    const c = cleanCompany(fromName);
    if (c && !looksLikePerson(c) && !isVendorName(c)) return c;
  }

  // 3) Company-owned domain (e.g. careers@stripe.com -> Stripe).
  if (domain && !isAts(domain) && !isVendorDomain(domain) && !isNoise(domain)) {
    const parts = domain.split(".");
    const root = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    if (root && root.length > 1 && !/^(mail|email|smtp|notify|notifications|info|hello|app)$/i.test(root)) {
      return titleCase(root);
    }
  }

  return "Unknown Company";
}

function extractRole(email: ParsedEmail): string | null {
  const text = `${email.subject}\n${email.body.slice(0, 800)}`;
  const patterns = [
    // ATS requisition line: "Ref: 58806 - AI Foundations - Software Engineer -
    // Research Internship: 2026" / "...application - 87239 - Associate Developer
    // Intern 2026". Capture the title after the req number, up to the year. This
    // is the most reliable role signal and consolidates an app's emails.
    /\b(?!20\d{2}\b)\d{4,6}\b\s*[-–—:]\s*([A-Za-z][A-Za-z0-9/&.,\-+ ]{3,70}?)(?=\s*:|\s*\n|\s+(?:–|-)?\s*20\d{2}\b|$)/,
    // Explicit "(following )role: <title>" / "position: <title>" (e.g. iCIMS).
    /\b(?:following\s+)?(?:role|position)\s*:\s*([A-Za-z][A-Za-z0-9/&,\-+ ]{3,60}?)(?=\s*[:.,!?\n]|\s+at\b|\s+20\d{2}\b|$)/i,
    /(?:application|applying|apply)\s+for\s+(?:the\s+|our\s+|a\s+)?([A-Za-z0-9/&,\-+ ]{3,55}?)(?:\s+(?:position|role|internship|opportunity|opening)|\s+at\b|\s+\(|[.,!?\n]|$)/i,
    /(?:the|your|our)\s+([A-Za-z0-9/&,\-+ ]{3,55}?)\s+(?:position|role|internship|opening)\b/i,
    // Require an explicit "of"/":" — bare "position at IBM" used to capture "at IBM".
    /position(?:\s+of|\s*:)\s+([A-Za-z0-9/&,\-+ ]{3,55}?)(?:[.,!?\n]|\s+at\b|$)/i,
    /\b([A-Za-z0-9/&,\-+ ]{3,45}?\b(?:intern|internship|co[\s-]?op|engineer|developer|analyst|scientist|manager|designer|consultant|associate|researcher))\b/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m?.[1]) {
      let role = m[1].replace(/\s+/g, " ").trim().replace(/[.,;:]+$/, "");
      if (/^(the|your|our|a|an)\b/i.test(role)) role = role.replace(/^(the|your|our|a|an)\s+/i, "");
      if (role.length >= 3 && role.length <= 70) return titleCase(role);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rule-based classification
// ---------------------------------------------------------------------------

export function classifyWithRules(email: ParsedEmail): Classification {
  const domain = domainOf(email.fromEmail);
  const haystack = `${email.subject}\n${email.snippet}\n${email.body.slice(0, 2000)}`;
  const detected = detectStage(haystack);
  const ats = isAts(domain) || isVendorDomain(domain);

  // Relevant only if it reads like a funnel email OR comes from an ATS, and
  // never if it's clearly a newsletter without strong application phrasing.
  const relevant = (Boolean(detected) || ats) && !(isNoise(domain) && !detected);

  const company = extractCompany(email);
  let role = sanitizeRole(extractRole(email));
  // A "role" that's really just the company name ("At IBM" -> "IBM") is not a
  // role; null it so it doesn't become a junk label or split the application.
  if (role && roleIsJustCompany(role, company)) role = null;

  return {
    relevant,
    stage: detected?.stage ?? "applied",
    company,
    role,
    confidence: detected?.confidence ?? (ats ? 0.4 : 0.2),
    source: "rules",
  };
}

/** True when every token of the role is part of the company name. */
function roleIsJustCompany(role: string, company: string): boolean {
  const rk = normRole(role);
  if (!rk) return false;
  const companyTokens = new Set(normCompany(company).split(" ").filter(Boolean));
  if (!companyTokens.size) return false;
  return rk.split(" ").every((t) => companyTokens.has(t));
}

// ---------------------------------------------------------------------------
// Gemini classification (structured JSON output)
// ---------------------------------------------------------------------------

export function llmEnabled(): boolean {
  return (
    (process.env.LLM_PROVIDER ?? "").toLowerCase() === "gemini" &&
    Boolean(process.env.GEMINI_API_KEY)
  );
}

const VALID_STAGES: Stage[] = ["applied", "oa", "interview", "offer", "rejected"];

const SYSTEM_RULES = `You classify emails for a job/internship application tracker.
For each email decide "relevant": false for newsletters, job alerts/digests, marketing, news, social, or anything that is NOT a status update on an application the user submitted.
If relevant, classify "stage". Be conservative: only advance the stage when the email EXPLICITLY does the thing. A generic "thanks for applying", "we received your application", "your application is under review", "still being considered", or "we'll keep you posted" is ALWAYS "applied" — NOT interview.
- "applied": application received / confirmation / still under review / being considered. Default when unsure.
- "oa": the email invites the candidate to take an online assessment, coding challenge, or take-home.
- "interview": the email actually invites or schedules an interview, phone screen, or call (asks for availability, proposes times, or says "let's schedule"). NOT a status update that merely mentions the process.
- "offer": an actual job/internship offer is extended (offer letter, "pleased to offer").
- "rejected": application declined / not moving forward / position filled.
Extract:
- "company": the hiring ORGANIZATION's common short name (e.g. "Fidelity" not "Fidelity Investments Inc", "Amazon" not "Amazon.com Services LLC"). NEVER a person's name — if the sender is a recruiter or hiring manager (a human like "Charles Carr" or "Negron, Jennifer"), find the company from the email domain, signature, or body, NOT their name. Never the ATS vendor (Greenhouse/Lever/Workday/Oracle) and never an email address or requisition ID. If you truly cannot tell, use "".
- "role": ONLY the clean job title (e.g. "Software Engineer Intern"). NO requisition IDs or numbers, NO dates or "Summer 2026", NO locations, NO process words ("assessment", "interview", "OA"). Do NOT invent a role from a sentence fragment — if there is no real job title, use "".`;

// Hard signals required for "promoting" emails. The LLM sometimes labels a
// generic "still under review" note as interview/offer; we refuse to advance to
// those stages unless the text actually contains the relevant signal.
const INTERVIEW_SIGNAL =
  /\b(interview|phone screen|video (?:call|interview)|on-?site|hiring manager|schedule (?:a|an|your|some time|time)|your availability|availability (?:for|to)|times? (?:that )?work|meet with|speak with (?:the|our|a)|(?:chat|call|conversation|connect) with (?:the|our|a|us|me)|coffee chat|recruiter call|next round|technical screen|book a time|set up a (?:call|time|chat))\b/i;
// Require real offer phrasing — a bare "offer" appears in tons of non-offer mail.
const OFFER_SIGNAL =
  /\b(pleased to (?:offer|extend)|excited to offer|delighted to offer|happy to offer|extend(?:ing)? (?:you )?an offer|offer of (?:employment|internship)|offer letter|formal offer|your offer (?:letter|details|package))\b/i;
const OA_SIGNAL =
  /\b(assessment|coding (?:challenge|test|exercise)|hackerrank|codesignal|codility|take[- ]home|online test|skills test)\b/i;

/** True when a "company" string is really a person's name. */
function looksLikePerson(name: string): boolean {
  const t = name.trim();
  // "Last, First"
  if (/^[A-Z][a-z'’.-]+,\s*[A-Z][a-z'’.-]+$/.test(t)) return true;
  return false;
}

const ROLE_JUNK = new Set([
  "this", "that", "the", "future", "new", "right", "opportunity", "opportunities",
  "interest", "qualifications", "application", "applications", "team", "role",
  "position", "program", "update", "status", "thanks", "thank", "your", "our",
  "for", "and", "with", "here", "now", "today", "details", "information",
  // sentence-fragment words that leaked into roles ("Specific Requirements Of
  // The", "Careers From Day One", "At IBM", "For Completion")
  "specific", "requirements", "requirement", "completion", "careers", "career",
  "day", "one", "see", "how", "from", "at", "of", "in", "on", "to", "by", "a",
  "an", "we", "you", "are", "is", "be", "will",
  // "Candidate Assessment Process For The Following"
  "candidate", "candidates", "process", "following", "next", "steps", "step",
]);

// Leading words that are never the start of a real job title; strip them.
const ROLE_LEADING_JUNK =
  /^(?:at|of|in|on|to|by|for|with|from|the|a|an|your|our|this|that|we|you|are|is)\b\s*/i;

/** Strip req-ids/dates/locations and reject sentence-fragment junk roles. */
function sanitizeRole(role: string | null): string | null {
  if (!role) return null;
  let r = role
    .replace(/\b[Rr]\d{4,}\b/g, " ") // workday req ids like R0000402313
    .replace(/\b\d{4,}\b/g, " ") // bare long numbers / req ids
    .replace(/\b(summer|fall|spring|winter)\s*20\d{2}\b/gi, " ")
    .replace(/\b20\d{2}\b/g, " ")
    .replace(/\b(remote|hybrid|onsite|on-site)\b/gi, " ")
    .replace(/[-–—|·•]+\s*$/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s,.\-–—|]+|[\s,.\-–—|]+$/g, "")
    .trim();
  // Strip leading prepositions/articles ("At IBM" -> "IBM", "Of The Team" -> "Team").
  while (ROLE_LEADING_JUNK.test(r)) r = r.replace(ROLE_LEADING_JUNK, "").trim();
  if (!r) return null;
  const words = r.split(/\s+/);
  // A single common word ("This", "Future", "Right") is not a real title.
  if (words.length === 1 && ROLE_JUNK.has(words[0].toLowerCase())) return null;
  // A short phrase made only of junk words ("Qualifications For The", "Interest In The").
  if (words.length <= 3 && words.every((w) => ROLE_JUNK.has(w.toLowerCase()))) return null;
  // Must contain at least one letter.
  if (!/[A-Za-z]{2,}/.test(r)) return null;
  if (r.length > 70) r = r.slice(0, 70).trim();
  return r;
}

/** Prevent the model from advancing a stage that the email doesn't support. */
function guardStage(stage: Stage, text: string): Stage {
  if (stage === "interview" && !INTERVIEW_SIGNAL.test(text)) {
    return OA_SIGNAL.test(text) ? "oa" : "applied";
  }
  if (stage === "offer" && !OFFER_SIGNAL.test(text)) return "applied";
  if (stage === "oa" && !OA_SIGNAL.test(text)) return "applied";
  return stage;
}

function mergeLlmWithRules(
  llm: Partial<Classification> & { relevant: boolean; stage: Stage },
  rules: Classification,
  text: string
): Classification {
  const llmCompany =
    llm.company && llm.company !== "Unknown Company" && !looksLikePerson(llm.company)
      ? llm.company
      : null;
  const rulesCompany =
    rules.company !== "Unknown Company" && !looksLikePerson(rules.company)
      ? rules.company
      : null;
  return {
    relevant: llm.relevant,
    stage: guardStage(llm.stage, text),
    company: llmCompany ?? rulesCompany ?? "Unknown Company",
    role: sanitizeRole(llm.role ?? rules.role),
    confidence: 0.92,
    source: "llm",
  };
}

/**
 * Classify a batch of emails in a single Gemini call (thinking disabled for
 * speed). Returns one Classification per input email; falls back to rules for
 * any email the model couldn't classify or when the call fails.
 */
export async function classifyEmails(
  emails: ParsedEmail[]
): Promise<Classification[]> {
  const ruleResults = emails.map(classifyWithRules);
  if (!llmEnabled() || emails.length === 0) return ruleResults;

  const apiKey = process.env.GEMINI_API_KEY!;
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const emailBlocks = emails
    .map(
      (e, i) =>
        `### Email ${i}\nFrom: ${e.fromName} <${e.fromEmail}>\nSubject: ${e.subject}\nBody:\n${e.body.slice(0, 1500)}`
    )
    .join("\n\n");

  const payload = {
    contents: [
      {
        parts: [
          {
            text: `${SYSTEM_RULES}\n\nClassify ALL ${emails.length} emails below. Return a JSON array with one object per email IN ORDER, each: {"index", "relevant", "stage", "company", "role"}.\n\n${emailBlocks}`,
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      thinkingConfig: { thinkingBudget: 0 }, // no reasoning => much faster
      responseMimeType: "application/json",
      responseSchema: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            index: { type: "INTEGER" },
            relevant: { type: "BOOLEAN" },
            stage: {
              type: "STRING",
              enum: ["applied", "oa", "interview", "offer", "rejected"],
            },
            company: { type: "STRING" },
            role: { type: "STRING" },
          },
          required: ["index", "relevant", "stage", "company"],
        },
      },
    },
  };

  try {
    const res = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(payload),
      },
      30000
    );
    if (!res.ok) return ruleResults;
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return ruleResults;

    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) return ruleResults;

    const out = [...ruleResults];
    for (const item of arr) {
      const i = typeof item?.index === "number" ? item.index : -1;
      if (i < 0 || i >= emails.length) continue;
      if (typeof item.relevant !== "boolean") continue;
      const stage: Stage = VALID_STAGES.includes(item.stage) ? item.stage : "applied";
      const company =
        typeof item.company === "string" && item.company.trim()
          ? item.company.trim()
          : "Unknown Company";
      const role =
        typeof item.role === "string" && item.role.trim() ? item.role.trim() : null;
      const text = `${emails[i].subject}\n${emails[i].body.slice(0, 2000)}`;
      out[i] = mergeLlmWithRules(
        { relevant: item.relevant, stage, company, role },
        ruleResults[i],
        text
      );
    }
    return out;
  } catch {
    return ruleResults;
  }
}

/** Single-email convenience wrapper around the batch classifier. */
export async function classifyEmail(email: ParsedEmail): Promise<Classification> {
  const [c] = await classifyEmails([email]);
  return c;
}

/** Canonical company identity used to group an applicant's cards. */
export function normCompany(company: string): string {
  return company
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(
      /\b(inc|llc|ltd|limited|corp|corporation|co|company|the|technologies|technology|tech|labs|group|holdings|global|international|systems|solutions|financial|investments|investment|capital|partners|enterprises|industries)\b/g,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();
}

const ROLE_STOPWORDS = new Set([
  "intern", "internship", "interns", "coop", "co", "op", "summer", "fall",
  "spring", "winter", "the", "a", "an", "position", "role", "opportunity",
  "opening", "program", "team", "early", "career", "careers", "new", "grad",
  "graduate", "student", "full", "time", "part", "i", "ii", "iii", "iv", "of",
  "for", "and", "at",
  // stage/process words that leak into role text
  "assessment", "assessments", "online", "oa", "test", "testing", "challenge",
  "coding", "code", "phone", "screen", "screening", "technical", "interview",
  "video", "virtual", "application", "apply", "req", "requisition", "id", "job",
  "summer2025", "summer2026", "us", "usa", "remote", "hybrid", "onsite",
]);

const ROLE_SYNONYMS: Record<string, string> = {
  engineering: "engineer",
  development: "developer",
  dev: "developer",
  swe: "engineer",
  sde: "engineer",
  ml: "machinelearning",
  ai: "artificialintelligence",
  ux: "design",
  ui: "design",
};

/** Canonical role identity: strip filler/levels/years/codes, stem, sort tokens. */
export function normRole(role: string | null): string {
  if (!role) return "";
  const tokens = role
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .map((t) => ROLE_SYNONYMS[t] ?? t)
    .filter(
      (t) =>
        t &&
        !ROLE_STOPWORDS.has(t) &&
        !/\d/.test(t) && // drop years / req-ids / any token with a digit
        t.length > 1
    );
  return Array.from(new Set(tokens)).sort().join(" ");
}

/**
 * Two role keys count as the same application if one is a subset of the other
 * or they overlap heavily (handles "swe intern" vs "swe intern assessment").
 */
export function roleSimilar(a: string, b: string): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const ta = new Set(a.split(" ").filter(Boolean));
  const tb = new Set(b.split(" ").filter(Boolean));
  if (!ta.size || !tb.size) return false;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const smaller = Math.min(ta.size, tb.size);
  const union = ta.size + tb.size - inter;
  // Subset match, or Jaccard >= 0.6.
  return inter === smaller || inter / union >= 0.6;
}

export function dedupKey(company: string, role: string | null): string {
  return `${normCompany(company)}::${normRole(role)}`;
}
