import type { Classification, Stage } from "./types";
import { fetchWithTimeout, type ParsedEmail } from "./gmail";

// ---------------------------------------------------------------------------
// Sender categories
// ---------------------------------------------------------------------------

// Applicant Tracking System senders. Mail from these is almost always a real
// application-funnel email, so we trust it even without strong phrasing —
// but their name/domain is NEVER the hiring company.
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
  "brassring.com",
  "kenexa.com",
  "adp.com",
  "avature.net",
  "pinpoint.email",
  "dayforcehcm.com",
  "ultipro.com",
  "phenom.com",
];

// Assessment/interview PLATFORMS. Mail comes *from* these on behalf of a real
// employer, so their name/domain must never be used as the company (the hiring
// company is named in the subject/body, e.g. "Susquehanna invited you ...").
const VENDOR_DOMAINS = [
  "codesignal.com",
  "hackerrank.com",
  "hackerrankforwork.com",
  "hackerearth.com",
  "codility.com",
  "coderpad.io",
  "karat.com",
  "hirevue.com",
  "codesubmit.io",
  "qualified.io",
  "testgorilla.com",
  "sovaassessment.com",
  "sovaonline.com",
  "shl.com",
  "criteriacorp.com",
  "pymetrics.com",
  "plum.io",
  "modernhire.com",
  "harver.com",
  "testdome.com",
];
const VENDOR_NAMES = new Set([
  "codesignal", "hackerrank", "hackerearth", "codility", "coderpad",
  "karat", "hirevue", "codesubmit", "qualified", "testgorilla", "sova",
  "sovaassessment", "shl", "pymetrics", "plum", "modernhire", "harver",
]);

// Job boards / aggregators. They DELIVER employer updates (relevant, employer
// named in content) but also send marketing nudges (irrelevant). Their name is
// never the company.
const JOB_BOARD_DOMAINS = [
  "linkedin.com",
  "wayup.com",
  "ziprecruiter.com",
  "indeed.com",
  "joinhandshake.com",
  "glassdoor.com",
  "monster.com",
  "dice.com",
  "wellfound.com",
  "builtin.com",
  "otta.com",
  "untapped.io",
  "ripplematch.com",
  "simplify.jobs",
  "jobright.ai",
  "lensa.com",
];

// Newsletters / news / social / prep platforms that pollute keyword matches.
// Personal mailboxes never deliver ATS status mail; a friend's "my application
// is under review" must not become a card (nor "Gmail" a company).
const FREEMAIL_DOMAINS = [
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
];

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
  "leetcode.com",
  "news",
  "newsletter",
  "digest",
  "marketing",
];

function domainOf(email: string): string {
  return (email.split("@")[1] || "").toLowerCase();
}
function isAts(domain: string): boolean {
  return ATS_DOMAINS.some((d) => domain.includes(d));
}
function isVendorDomain(domain: string): boolean {
  return VENDOR_DOMAINS.some((d) => domain.includes(d));
}
function isJobBoard(domain: string): boolean {
  return JOB_BOARD_DOMAINS.some((d) => domain.includes(d));
}
function isNoise(domain: string): boolean {
  return NOISE_DOMAINS.some((d) => domain.includes(d));
}
function isFreemail(domain: string): boolean {
  return FREEMAIL_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}
function isVendorName(name: string): boolean {
  return VENDOR_NAMES.has(name.toLowerCase().replace(/[^a-z]/g, ""));
}

// ---------------------------------------------------------------------------
// Text normalization
// ---------------------------------------------------------------------------

// Stored bodies often contain raw HTML entities ("our&nbsp;ML Engineer"),
// which silently break word-boundary regexes. Decode before ANY matching.
export function decodeEntities(s: string): string {
  return s
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;|&ldquo;|&rdquo;/gi, '"')
    .replace(/&#39;|&apos;|&rsquo;|&lsquo;|&#8217;/gi, "'")
    .replace(/&[a-z]{2,8};|&#\d{2,5};/gi, " ");
}

const REQ_ID_PATTERNS: RegExp[] = [
  /\bREQ[\s-]?(\d{4,10})\b/i,
  /\bJR[\s-]?(\d{5,10})\b/i,
  /\bR-?(\d{4}-\d{2,8})\b/, // R-2026-63180
  /\bR-?(\d{5,10})\b/, // R0114671, R-80658 (5+ digits so bare years never match)
  /\b(\d{4,10})\s*BR\b/, // 717004BR
  /\b([A-Z]{1,3}-[A-Z]{2,3}-\d{2,8})\b/, // C-GE-112 style structured codes
  /\(\s*(?:ID|No\.?|Job ID|Requisition(?: ID)?)\s*[:# ]\s*([A-Z]?\d{4,14})\s*\)/i,
  /\b(?:Job ID|Requisition(?: ID)?|Ref)\s*[:# ]\s*([A-Z]?\d{4,12})\b/i,
  /\bposition of\s+(\d{5,10})\b/i,
  // "72366 - Software Developer Intern" — require an application lead-in so
  // street addresses / zip codes ("… TX 78712 - Building A") never match.
  /\b(?:ref|req(?:uisition)?|id|no\.?|#|of|to|application|position|job|role)\s*[:#-]?\s*(\d{5,9})\s*[-–]\s*(?=[A-Z])/i,
];

/** Requisition/job ID when the email states one — the strongest app identity. */
export function extractReqId(text: string): string | null {
  for (const p of REQ_ID_PATTERNS) {
    const m = text.match(p);
    if (m?.[1]) {
      const norm = m[1].replace(/[^A-Za-z0-9]/g, "").toUpperCase();
      if (norm.length >= 4 && !/^20\d{2}$/.test(norm)) return norm;
    }
  }
  return null;
}

function titleCase(s: string): string {
  return s
    .trim()
    .split(/\s+/)
    .map((w) => (w.length > 1 ? w[0].toUpperCase() + w.slice(1) : w.toUpperCase()))
    .join(" ");
}

// ---------------------------------------------------------------------------
// Company extraction
// ---------------------------------------------------------------------------

// Recruiting-machinery words that are not part of a company's name. Longest
// alternatives FIRST — "talent acquisition" must strip as a unit, or "IBM
// Talent Acquisition" degrades to "IBM Acquisition".
const COMPANY_NOISE_WORDS = new RegExp(
  "\\b(" +
    [
      "talent acquisition group",
      "talent acquisition team",
      "talent acquisition",
      "university recruiting",
      "early careers team",
      "early careers",
      "human resources",
      "people service center",
      "recruiting team",
      "recruitment team",
      "careers team",
      "hiring team",
      "talent team",
      "student programs",
      "campus recruiting",
      "campus recruitment",
      "recruiting",
      "recruitment",
      "recruiter",
      "careers?",
      "talent",
      "hiring",
      "jobs?",
      "notifications?",
      "no[\\s-]*reply",
      "do[\\s-]*not[\\s-]*reply",
      "donotreply",
      "automationmanager",
      "my\\s?workday",
      "workday",
      "greenhouse",
      "lever",
      "ashby(?:hq)?",
      "icims",
      "smartrecruiters",
      "jobvite",
      "taleo",
      "workable",
      "successfactors",
      "brassring",
      "apply now",
      "inc",
      "llc",
      "ltd",
      "corp",
    ].join("|") +
    ")\\b",
  "gi"
);

// ATS artifacts glued into display names without word boundaries
// ("SonyWorkdayDoNotReply", "workdayemailnotification cae").
const COMPANY_NOISE_SUBSTRINGS =
  /myworkday|workday|donotreply|noreply|emailnotification|automationmanager/gi;

// A real company name is a short proper-noun phrase. Sentence fragments,
// greetings, job titles, and req IDs are not companies. IMPORTANT: this list
// must never contain words that appear inside real company names ("Best Buy",
// "Spring Health", "KIND Snacks", "Wish") — sign-offs and seasons are handled
// as phrases/whole-string checks below, not bare words.
const COMPANY_REJECT_WORDS = new RegExp(
  "\\b(" +
    [
      "dear", "hi", "hey", "greetings",
      "thank", "thanks", "congratulations", "welcome",
      "you", "your", "our", "we", "us", "me", "my",
      "apply", "applying", "applied", "application", "applications", "candidacy", "candidate",
      "position", "positions", "role", "roles", "opportunity", "opportunities", "opening", "openings",
      "intern", "interns", "internship", "internships", "engineer", "engineers", "engineering",
      "developer", "developers", "development", "scientist", "scientists", "analyst", "analysts",
      "assessment", "assessments", "interview", "interviews",
      "update", "updates", "status", "regarding", "received", "submitted", "submitting",
      "wish you", "following", "relation", "interest",
      "took", "seems", "and wish", "this", "that", "co[- ]?op", "coop", "programs?",
      "kind regards", "warm(?:est)? regards", "best regards", "best wishes",
      "sincerely", "cheers", "respectfully",
    ].join("|") +
    ")\\b",
  "i"
);

// Bare mailbox/staffing words are not companies as WHOLE strings, but must
// survive inside names ("Hello Heart", "Info-Tech Research Group").
const COMPANY_WHOLE_REJECT =
  /^(?:info|hello|support|admin|mailer|via|careers?|jobs?|recruiting|recruitment|notifications?|no[- ]?reply|team|hr|talent|regards|best|global|corporate|regional|international|worldwide|early|university|graduate|campus|people|welcome|time|americas?|emea|apac|latam|linkedin|wayup|indeed|ziprecruiter|handshake|glassdoor|monster|dice|wellfound|lensa)$/i;

/** True when a "company" string is really a person's name. */
function looksLikePerson(name: string, fromEmail?: string): boolean {
  const t = name.trim();
  if (/^[A-Z][a-z'’.-]+,\s*[A-Z][a-z'’.-]+$/.test(t)) return true; // "Last, First"
  // "First Last" from a personal-looking mailbox: priya.raman@, praman@,
  // priyar@. ATS tenant mailboxes (nimbusnetworks@myworkday.com) are not
  // people, and a bare first+last concat is skipped (companies do that too:
  // generalmotors@…).
  if (fromEmail && /^[A-Z][a-z'’-]+ [A-Z][a-z'’-]+$/.test(t)) {
    const local = fromEmail.split("@")[0].toLowerCase().replace(/\d+$/, "");
    if (!isAts(domainOf(fromEmail))) {
      const [first, last] = t.toLowerCase().split(/\s+/).map((w) => w.replace(/[^a-z]/g, ""));
      if (/^[a-z]+[._-][a-z]+$/.test(local)) {
        const parts = local.split(/[._-]/);
        if ([first, last].every((w) => parts.some((p) => p === w || p[0] === w[0]))) return true;
      }
      if (local === first[0] + last || local === first + last[0]) return true;
    }
  }
  return false;
}

/** Shape check: could this string be a real organization name? */
export function isPlausibleCompany(name: string): boolean {
  const t = name.trim();
  if (t.length < 2 || t.length > 40) return false;
  if (!/[A-Za-z]/.test(t)) return false;
  if (/\d{4,}/.test(t)) return false; // req ids / years
  if (t.split(/\s+/).length > 5) return false;
  // Leading preposition means we captured a fragment ("At Draper", "For The …").
  if (/^(at|to|for|from|with|in|of|on|during|about)\s/i.test(t)) return false;
  // Whole-string mailbox words and org-chart adjectives ("Global", "Info").
  if (COMPANY_WHOLE_REJECT.test(t)) return false;
  if (COMPANY_REJECT_WORDS.test(t)) return false;
  if (looksLikePerson(t)) return false;
  if (isVendorName(t)) return false;
  return true;
}

function cleanCompany(raw: string): string | null {
  let c = decodeEntities(raw)
    .replace(/[“”"']/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s,.-]+|[\s,.:;!?-]+$/g, "")
    .trim();
  if (/@/.test(c) || /\.com|\.io|\.co\b|\.org|\.net/i.test(c)) return null;
  // Chatbot/relay display names: "Panda Hiring Assistant from Panda Restaurant
  // Group" → the org AFTER "from"; "McQuade Organization via WayUp" → the org
  // BEFORE "via" (the channel comes after).
  const fromSplit = c.match(/^.+?\s+from\s+(.{2,60})$/i);
  if (fromSplit) c = fromSplit[1].trim();
  c = c.replace(/\s+via\s+.{2,40}$/i, "").trim();
  // Strip recruiting-machinery words repeatedly until stable ("Workday at X",
  // "X Talent Acquisition Group"), then drop a dangling "Team"/"Group".
  for (let i = 0; i < 3; i++) {
    const next = c.replace(COMPANY_NOISE_WORDS, " ").replace(/\s+/g, " ").trim();
    if (next === c) break;
    c = next;
  }
  c = c.replace(COMPANY_NOISE_SUBSTRINGS, " ").replace(/\s+/g, " ").trim();
  c = c.replace(/\s+(team|group)$/i, "").trim();
  // Country/legal tails ("Canon U.S.A., Inc.") and stray single-letter
  // fragments left by terminator truncation ("Canon U").
  c = c.replace(/\b(?:u\.?s\.?a?\.?|usa)\s*$/i, "").trim();
  c = c.replace(/\s+[A-Z]\.?$/, "").trim();
  c = c.replace(/^[\s,.@:;&-]+|[\s,.:;!?@&-]+$/g, "").trim();
  // "Workday at S&P Global" leaves "at S&P Global" — recover the name.
  c = c.replace(/^at\s+/i, "").trim();
  if (!c || c.length < 2) return null;
  if (/^(the|your|our|a|an|we|this|that)$/i.test(c)) return null;
  if (c.length > 40) c = c.slice(0, 40).trim();
  // Preserve intentional casing (S&P, IBM, iCIMS); only fix all-lowercase.
  return /[A-Z]/.test(c) ? c : titleCase(c);
}

/** Clean + shape-validate a company candidate; null when it isn't one. */
function companyCandidate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const c = cleanCompany(raw);
  if (!c || !isPlausibleCompany(c)) return null;
  return c;
}

// Candidate name capture: proper-noun-ish phrase (accented caps included —
// Nestlé, Société Générale).
const NAME = "([A-ZÀ-Þ][A-Za-zÀ-ÿ0-9&.'\\- ]{1,40}?)";
// Where a company name stops. "for"/"and" only terminate before lowercase or
// season/year continuations — "Marks and Spencer" and "Institute for Defense
// Analyses" must not be chopped.
const NAME_END =
  "(?=[.,!?:;\\n]|$|\\s+at\\b|\\s+(?:as|team|to|in|on|is|has|was|will|the|this|that|regarding)\\b|\\s+(?:for|and)\\s+(?:[a-z]|[Ss]ummer|[Ff]all|[Ww]inter|[Ss]pring|20\\d{2})|\\s+[-–—(])";

// NOTE: no "i" flags here — NAME's leading [A-Z] is the guard against
// capturing prose ("at this time" → "This Time"). Sentence-case variation is
// handled with explicit [Xx] leads instead.
const COMPANY_PATTERNS: RegExp[] = [
  // Employer named in vendor/recruiter mail. These run first so a
  // CodeSignal/Sova/recruiter email resolves to the real company.
  new RegExp(`${NAME} (?:invited you|is waiting for)\\b`),
  new RegExp(`\\bfrom ${NAME} to (?:take|complete|schedule)\\b`),
  new RegExp(`\\bon behalf of ${NAME}${NAME_END}`),
  new RegExp(`\\b(?:[Nn]ext [Ss]tep|[Uu]pdate|[Aa]pplication|[Aa]ssessment|[Ii]nterview|[Rr]ecruitment [Pp]rocess) (?:with|at) ${NAME}${NAME_END}`),
  new RegExp(`\\b(?:[Aa]pply(?:ing)?|[Aa]pplication|[Aa]pplied)\\s+(?:directly\\s+)?(?:to|with|at)\\s+(?:the\\s+)?${NAME}${NAME_END}`),
  new RegExp(`\\b[Yy]our (?:application|candidacy|interview|offer) (?:at|with|from) ${NAME}${NAME_END}`),
  new RegExp(`\\b[Tt]hank [Yy]ou for [Aa]pplying (?:to|at)\\s+(?:the\\s+)?${NAME}${NAME_END}`),
  new RegExp(`\\b[Ii]nterest(?:ed)? in (?:a )?(?:career|careers|position|role|opportunity|future)? ?(?:at|with) ${NAME}${NAME_END}`),
  new RegExp(`\\b[Cc]areer (?:at|with) ${NAME}${NAME_END}`),
  new RegExp(`\\b(?:interview|opportunity|position|role|internship|opening)\\s+(?:at|with)\\s+${NAME}${NAME_END}`),
  new RegExp(`\\bthe ${NAME} position of\\b`),
  new RegExp(`\\b[Jj]oining (?:the )?${NAME} [Tt]eam\\b`),
  new RegExp(`\\b[Ww]elcome to (?:the )?${NAME}${NAME_END}`),
  new RegExp(`\\b[Tt]he (?:team )?at ${NAME}${NAME_END}`),
  new RegExp(`\\b[Aa] ${NAME} (?:recruiter|hiring manager)\\b`),
  // Subject prefix: "From AAA - Application Update for …"
  new RegExp(`^From ${NAME}\\s*[-–—:]`),
  // Job-board delivery subject: "Your application to <role> at <Company>".
  new RegExp(`\\b[Aa]pplication to [^\\n]{0,60}? at ${NAME}${NAME_END}`),
];

// Signature lines: "Acme Talent Acquisition", "Sincerely, The Acme Recruiting
// Team". Anchored to a line/clause start so a nearby person's name ("Despina
// Sofou, Early Careers Recruiter") is never swallowed into the capture, and
// person-title suffixes are excluded.
const COMPANY_SIGNATURE_PATTERNS: RegExp[] = [
  new RegExp(
    `(?:^|\\n|,\\s*)\\s*(?:[Tt]he )?${NAME},?\\s+(?:[Gg]lobal\\s+)?(?:[Tt]alent [Aa]cquisition|[Tt]alent [Tt]eam|[Rr]ecruiting [Tt]eam|[Rr]ecruitment [Tt]eam|[Ee]arly [Cc]areers|[Uu]niversity [Rr]ecruiting|[Hh]iring [Tt]eam|[Pp]eople [Tt]eam|[Cc]areers [Tt]eam)(?!\\s*(?:[Rr]ecruiter|[Cc]oordinator|[Mm]anager|[Ss]pecialist|[Pp]artner|[Ll]ead|[Ss]ourcer|[Aa]ssociate|[Aa]dvisor|[Cc]onsultant))`
  ),
  // Legal-entity footer: "RTX Corporation · 1000 Wilson Blvd."
  new RegExp(`(?:^|\\n|·)\\s*${NAME} (?:Corporation|Incorporated|Inc\\.?|LLC|Ltd\\.?)(?=[\\s.,·]|$)`),
];

// Weaker patterns that lose to a clean sender display name ("the X team" also
// matches internal program/team names; bare "interest in X" often captures a
// discipline — "Investment Banking" — rather than the employer).
const COMPANY_PATTERNS_WEAK: RegExp[] = [
  new RegExp(`\\b[Tt]he ${NAME} (?:[Tt]eam|family)\\b`),
  new RegExp(`\\b[Ii]nterest(?:ed)? in ${NAME}${NAME_END}`),
];

// careers.acme.com / jobs.acme.io links inside the body reveal the employer.
const CAREERS_URL = /(?:careers?|jobs)\.(?:[a-z0-9-]+\.)?([a-z0-9-]{2,24})\.(?:com|net|org|io|co|jobs)\b/i;

function scanCompany(text: string, patterns: RegExp[]): string | null {
  for (const p of patterns) {
    const g = new RegExp(p.source, p.flags.includes("g") ? p.flags : p.flags + "g");
    for (const m of text.matchAll(g)) {
      const c = companyCandidate(m?.[1]);
      if (c) return c;
    }
  }
  return null;
}

function extractCompany(email: ParsedEmail): string {
  const { subject, body, fromName, fromEmail } = email;
  // Signatures ("Fidelity Investments Talent Acquisition") live at the END of
  // the email, past any head slice — include the tail.
  const tail = body.length > 1400 ? `\n${body.slice(-600)}` : "";
  // Two views: names wrap across lines ("at S&P\n Global"), so relationship
  // patterns run on flattened text; signature patterns need line structure.
  const lineText = decodeEntities(`${subject}\n${body.slice(0, 1400)}${tail}`).replace(/[ \t]+/g, " ");
  const flatText = `${decodeEntities(subject).replace(/\s+/g, " ")}\n${decodeEntities(
    `${body.slice(0, 1400)}${tail}`
  ).replace(/\s+/g, " ")}`;
  const domain = domainOf(fromEmail);

  // 1) Relationship patterns (flattened), then line-anchored signatures.
  const fromPatterns =
    scanCompany(flatText, COMPANY_PATTERNS) ?? scanCompany(lineText, COMPANY_SIGNATURE_PATTERNS);
  if (fromPatterns) return fromPatterns;

  // 2) Sender display name (ATS usually sets this to the company), cleaned of
  //    ATS artifacts, unless it's a person, a vendor, or fails validation.
  //    On ATS domains display names are often the RECRUITER's name, so the
  //    body's weak patterns ("The Hypergrid Team") get priority there.
  const displayCompany = (): string | null => {
    if (fromName && !looksLikePerson(fromName, fromEmail) && !isVendorName(fromName)) {
      const c = companyCandidate(fromName);
      if (c && !looksLikePerson(c, fromEmail)) return c;
    }
    return null;
  };
  const weakCompany = (): string | null => scanCompany(flatText, COMPANY_PATTERNS_WEAK);
  const step2 = isAts(domain)
    ? weakCompany() ?? displayCompany()
    : displayCompany() ?? weakCompany();
  if (step2) return step2;

  // 3) careers.X.com / jobs.X.com URL in the body.
  const urlMatch = decodeEntities(body.slice(0, 4000)).match(CAREERS_URL);
  if (urlMatch?.[1]) {
    const root = urlMatch[1];
    if (root.length > 1 && !isAts(root) && !isVendorDomain(root) && !isJobBoard(root)) {
      const c = companyCandidate(root);
      if (c) return c;
    }
  }

  // 4) Company-owned sender domain (careers@stripe.com -> Stripe). Personal
  //    mailboxes are never an employer, and two-level TLDs (rolls-royce.co.uk)
  //    must not yield "Co"/"Com".
  if (
    domain &&
    !isAts(domain) &&
    !isVendorDomain(domain) &&
    !isJobBoard(domain) &&
    !isNoise(domain) &&
    !isFreemail(domain)
  ) {
    const parts = domain.split(".");
    let idx = parts.length - 2;
    if (idx > 0 && /^(?:co|com|ac|org|net|gov|edu)$/i.test(parts[idx])) idx -= 1;
    const root = idx >= 0 ? parts[idx] : parts[0];
    if (root && root.length > 1 && !/^(mail|email|smtp|notify|notifications|info|hello|app|alerts|jobs|careers|recruiting)$/i.test(root)) {
      const c = companyCandidate(root);
      if (c) return c;
    }
    // alerts.jobs.ace.aaa.com -> aaa
    if (parts.length >= 3) {
      const c = companyCandidate(parts[parts.length - 2]);
      if (c) return c;
    }
  }

  // 5) Workday tenant slug (tmobile@myworkday.com). Last resort: slugs are
  //    lowercase and sometimes cryptic, so only accept readable ones that
  //    aren't mailbox descriptors (globalhr@, recruiting@, …).
  if (domain === "myworkday.com" || domain.endsWith(".myworkday.com")) {
    const local = fromEmail.split("@")[0].replace(/[^a-z0-9-]/gi, "");
    if (local.length >= 5 && !/hr|talent|recruit|notif|career|job|reply/i.test(local)) {
      const c = companyCandidate(local);
      if (c) return c;
    }
  }

  return "Unknown Company";
}

// ---------------------------------------------------------------------------
// Role extraction
// ---------------------------------------------------------------------------

// A real job title contains a title noun. Prose fragments don't.
const ROLE_TITLE_NOUN =
  /\b(intern(?:ship)?s?|co[\s-]?op|engineers?|engineering|developers?|scientists?|analysts?|architects?|designers?|researchers?|consultants?|specialists?|managers?|associates?|fellows?|apprentices?|technicians?|programmers?|administrators?|strategists?|trainees?|assistants?|coordinators?|accountants?|auditors?|clerks?|recruiters?|advisors?|traders?|underwriters?|technologists?|statisticians?|economists?|attorneys?|paralegals?|nurses?|teachers?|instructors?|therapists?|actuar(?:y|ies))\b/i;

// Words that mean we captured conversational prose, not a title. IMPORTANT:
// never add words that occur inside real titles ("IT Intern", "Customer
// Experience Intern", "Process Engineer", "Forward Deployed Engineer") —
// only words no posting title contains.
const ROLE_FRAGMENT_WORDS =
  /\b(you|your|our|we|us|this|that|only|about|posting|question|inquiry|relates?|related|took|seems?|thank|thanks|appreciate|interest(?:ed)?|apply(?:ing)?|application|candidacy|status|update|regarding|relation|wish|aligned|qualifications?|other|great|good|fit|match|following|received|submitted|hearing|consider(?:ation)?|please|welcome|excited|browse|taking|complet(?:e|ed|ing|ion)|day one|positions?|unfortunately|interviews?|invitations?|invites?|hiring manager|minutes?|set up|speak with|availability|such as|across|openings?|dank|ihre?|bewerbung|f[uü]r|merci|votre|candidature|remercions|gracias|solicitud|puesto)\b/i;

const ROLE_JUNK = new Set([
  "this", "that", "the", "future", "new", "right", "opportunity", "opportunities",
  "interest", "qualifications", "application", "applications", "team", "role",
  "position", "program", "update", "status", "thanks", "thank", "your", "our",
  "for", "and", "with", "here", "now", "today", "details", "information",
  "specific", "requirements", "requirement", "completion", "careers", "career",
  "day", "one", "see", "how", "from", "at", "of", "in", "on", "to", "by", "a",
  "an", "we", "you", "are", "is", "be", "will",
  "candidate", "candidates", "process", "following", "next", "steps", "step",
  "other", "others",
]);

const ROLE_LEADING_JUNK =
  /^(?:(?:at|as|of|in|on|to|by|for|with|from|the|a|an|your|our|this|that|we|you|are|is|and|or)\b|re:)\s*/i;

/** Strip req-ids/dates/noise and reject sentence-fragment junk roles. */
function sanitizeRole(role: string | null): string | null {
  if (!role) return null;
  let r = decodeEntities(role);
  for (const p of REQ_ID_PATTERNS) r = r.replace(new RegExp(p.source, p.flags.includes("i") ? "gi" : "g"), " ");
  r = r
    .replace(/\bREQ\b/gi, " ")
    .replace(/\brequisitions?\b/gi, " ")
    .replace(/\b(summer|fall|spring|winter)\s*20\d{2}\b/gi, " ")
    .replace(/\b20\d{2}\b/g, " ")
    .replace(/\b\d{4,}\b/g, " ") // bare req-id digit runs are never in titles
    .replace(/\b(remote|hybrid|onsite|on-site|paid|unpaid)\b/gi, " ")
    // Parens left holding only seasons/connectors after the strips: "( & )",
    // "(Fall )", "(Summer, )".
    .replace(/\(\s*(?:(?:summer|fall|spring|winter|and)\b[\s,&]*|[\s,&]+)*\)/gi, " ")
    .replace(/[-–—(,\s]*\b(summer|fall|spring|winter)\b[\s,.)]*$/i, " ")
    .replace(/[-–—|·•,]+\s*$/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s,.\-–—|:]+|[\s,.\-–—|:]+$/g, "")
    .trim();
  while (ROLE_LEADING_JUNK.test(r)) r = r.replace(ROLE_LEADING_JUNK, "").trim();
  r = r.replace(/^[\s,.\-–—|:]+|[\s,.\-–—|:]+$/g, "").trim();
  if (!r) return null;
  const words = r.split(/\s+/);
  if (words.length === 1 && ROLE_JUNK.has(words[0].toLowerCase())) return null;
  if (words.length <= 3 && words.every((w) => ROLE_JUNK.has(w.toLowerCase()))) return null;
  if (!/[A-Za-z]{2,}/.test(r)) return null;
  if (r.length > 70) r = r.slice(0, 70).trim();
  return r;
}

/** Full validation: sanitized + shaped like a title, not prose. */
function roleCandidate(raw: string | null | undefined): string | null {
  let r = sanitizeRole(raw ?? null);
  if (!r) return null;
  // Assessment-vendor names never belong in a job title ("HackerRank Visa
  // Intern" from a vendor-invite subject).
  r = r
    .split(/\s+/)
    .filter((w) => !isVendorName(w))
    .join(" ")
    .trim();
  if (!r) return null;
  if (ROLE_FRAGMENT_WORDS.test(r)) return null;
  // Lowercase "opportunities" is prose ("Software Development Engineering
  // opportunities at Amazon"); Title-Case can be part of a real posting name.
  if (/\bopportunit(?:y|ies)\b/.test(r)) return null;
  // A capture that crossed a sentence boundary is prose, not a title —
  // dotted abbreviations (Ph.D., U.S.) are not boundaries.
  if (/(?<!\b(?:Ph\.D|Dr|Mr|Ms|Mrs|Jr|Sr|St|Inc|Co|No|vs|U\.S|B\.S|M\.S|e\.g|i\.e))[.!?]\s+[A-Z(]/.test(r)) return null;
  if (!ROLE_TITLE_NOUN.test(r)) return null;
  if (r.split(/\s+/).length > 9) return null;
  return titleCase(r);
}

const ROLE_CHARS = "[A-Za-z][A-Za-z0-9/&.,:()'\\-+ ]{2,70}?";
const ROLE_END =
  "(?=\\s*[.!?\\n;]|\\s*,\\s*(?:[.!?\\n]|$)|\\s*,?\\s+and\\b|\\s*$|\\s+at\\b|\\s+with\\b|\\s+here\\b|\\s+was\\b|\\s+has\\b|\\s+is\\b|\\s+will\\b|\\s+\\(|\\s+20\\d{2}\\b|\\s*[-–—]\\s*20\\d{2}\\b)";

/**
 * Try every match position of a pattern, not just non-overlapping ones: when a
 * match captures prose and fails validation, re-scan from one char later so a
 * valid candidate nested inside the bad match is still found.
 */
function scanRole(text: string, pattern: RegExp): string | null {
  const g = new RegExp(pattern.source, pattern.flags.replace("g", "") + "g");
  let m: RegExpExecArray | null;
  while ((m = g.exec(text)) !== null) {
    if (m[1]) {
      const c = roleCandidate(m[1]);
      if (c) return c;
    }
    g.lastIndex = m.index + 1;
  }
  return null;
}

function extractRole(email: ParsedEmail): string | null {
  const raw = decodeEntities(`${email.subject}\n${email.body.slice(0, 2000)}`);
  // Collapse wrapping INSIDE subject and body but keep the boundary between
  // them — otherwise a subject-final title runs into "Hi Alex" and no
  // terminator can ever close the capture.
  const flat = `${decodeEntities(email.subject).replace(/\s+/g, " ")}\n${decodeEntities(
    email.body.slice(0, 2000)
  ).replace(/\s+/g, " ")}`;

  // Colon-list format needs the raw line structure:
  // "submitted for the following position(s):\n  Robotics Software Intern 88210BR"
  const colonList = raw.match(
    /following position\(?s?\)?\s*:\s*\n?\s*([A-Za-z][A-Za-z0-9/&.,()'\- +]{2,70})/i
  );
  if (colonList) {
    const c = roleCandidate(colonList[1]);
    if (c) return c;
  }

  // The requisition-line format needs the req number intact ("717004BR:
  // Software Engineer - Intern" has a letter suffix on the req).
  const reqLine = new RegExp(
    `\\b(?!20\\d{2}\\b)\\d{4,8}(?:[A-Z]{1,3})?\\b\\s*[-–—:]\\s*(${ROLE_CHARS})${ROLE_END}`
  );
  const fromReqLine = scanRole(flat, reqLine);
  if (fromReqLine) return fromReqLine;

  // Everything else matches better once req IDs and years are stripped —
  // "position of R-55821 Platform Engineer Intern" / "the Summer 2026 X
  // Internship REQ342669 position" hide the title behind tokens otherwise.
  let cleaned = flat;
  for (const p of REQ_ID_PATTERNS) {
    cleaned = cleaned.replace(new RegExp(p.source, "gi"), " ");
  }
  cleaned = cleaned
    .replace(/\bREQ\b/gi, " ")
    .replace(/\b20\d{2}\b/g, " ")
    .replace(/\b\d{5,}\b/g, " ")
    .replace(/[ \t]+/g, " "); // collapse spaces but KEEP the subject/body \n

  const patterns = [
    // Explicit "(following )role:/position:" and "role of / position of".
    new RegExp(`\\b(?:following\\s+)?(?:role|position)\\s*(?::|of)\\s*(?:the\\s+)?(${ROLE_CHARS})${ROLE_END}`, "i"),
    // "your application for the X position/role", "applying to the X role"
    new RegExp(`\\b(?:application|applying|apply|applied|candidacy|consider you)\\s+(?:for|to)\\s+(?:the\\s+|our\\s+|an?\\s+|your\\s+)?(${ROLE_CHARS})\\s+(?:position|role|opening|opportunity|posting)\\b`, "i"),
    // "the X position/role/internship/opening"
    new RegExp(`\\b(?:the|your|our)\\s+(${ROLE_CHARS})\\s+(?:position|role|internship|opening|posting)\\b`, "i"),
    // "application/applying for X" with terminator
    new RegExp(`\\b(?:application|applying|apply|applied)\\s+(?:for|to)\\s+(?:the\\s+|our\\s+|an?\\s+)?(${ROLE_CHARS})${ROLE_END}`, "i"),
    // "interest in the X opening/position" / "interest in X"
    new RegExp(`\\binterest in\\s+(?:the\\s+)?(${ROLE_CHARS})${ROLE_END}`, "i"),
    // "Online Assessment for <Title>" invite subjects — the title names the
    // application the assessment belongs to.
    new RegExp(`\\b(?:assessment|invitation)[^.!?\\n]{0,20}\\bfor\\s+(?:the\\s+|your\\s+)?(${ROLE_CHARS})${ROLE_END}`, "i"),
    // Subject formats: "Your application – TITLE", "Application received for: TITLE"
    new RegExp(`\\b(?:application|submission)[^\\n]{0,24}(?:for|–|—|-)\\s*:?\\s*(${ROLE_CHARS})${ROLE_END}`, "i"),
    // Last resort: a phrase ending in a title noun.
    new RegExp(`\\b(${ROLE_CHARS}\\b(?:intern(?:ship)?|co[\\s-]?op|engineer|developer|analyst|scientist|manager|designer|consultant|associate|researcher|apprentice))\\b`, "i"),
  ];

  for (const p of patterns) {
    const c = scanRole(cleaned, p);
    if (c) return c;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Stage detection
// ---------------------------------------------------------------------------

// Sentences with hypothetical/instructional framing must not decide a stage:
// "if you are not selected…", "you may be invited to complete an assessment",
// "check the portal to see whether you were selected".
const HEDGE_MARKERS =
  /\b(if|unless|until|without|should you|in case|in the event|likely|may be|might be|may receive|whether|once selected|be sure to|tips|guide|prep(?:are)? for|incomplete applications?|you will (?:receive|get|be sent) (?:an |a )?(?:email|e-?mail|notification|notice))\b/i;
const INSTRUCTION_MARKERS =
  /\b(check|view|track|visit|log ?in|sign in|action center|status page|dashboard|portal|faq|help center)\b/i;

// Clause-level, not sentence-level: a decision clause often carries a
// courtesy tail ("…other candidates, but we encourage you to visit our
// careers page") that must not disqualify the decision itself. Single
// newlines are soft wraps ("…for the role\nuntil we've received…"), so only
// punctuation and blank lines end a clause.
function splitClauses(haystack: string): string[] {
  return haystack
    .replace(/(?<![.!?\n])\n(?!\n)/g, " ")
    .split(/(?<=[.!?\n])|(?=,\s*(?:but|however|although|though)\b)|(?=;\s)/i);
}

function decisiveText(haystack: string): string {
  return splitClauses(haystack)
    .filter((s) => !HEDGE_MARKERS.test(s) && !INSTRUCTION_MARKERS.test(s))
    .join(" ");
}

// Funnel stages tolerate instructions ("visit the portal to complete the
// assessment") but not hypotheticals ("you may be invited to complete…").
function unhedgedText(haystack: string): string {
  return splitClauses(haystack)
    .filter((s) => !HEDGE_MARKERS.test(s))
    .join(" ");
}

// Decision language: the email TELLS the candidate the outcome of THIS
// application. Structural variants, not company-specific templates.
const REJECT_PATTERNS: RegExp[] = [
  /\bregret to inform\b/i,
  /\b(?:decided|chosen|elected)\s+(?:not\s+to|to)\s+(?:not\s+)?(?:move|proceed|go)\s+forward\b/i,
  /\bnot\s+to\s+(?:move|proceed|go)\s+forward\b/i,
  // "unable to offer" needs the candidate as object — "unable to offer visa
  // sponsorship / relocation" is boilerplate inside live invites.
  /\b(?:will not|won't|unable to|cannot|can't|not able to)\s+(?:be\s+)?(?:mov(?:e|ing)|proceed(?:ing)?|continu(?:e|ing)|progress(?:ing)?|explore|consider(?:ing)?|pursue)\b/i,
  /\b(?:unable|not able) to offer you\b/i,
  /\bnot\s+(?:be\s+)?(?:mov(?:e|ing)|progress(?:ing)?|tak(?:e|ing)|schedul(?:e|ing))\s+(?:you|your application|your candidacy|forward|ahead|further)\b/i,
  /\bmov(?:e|ed|ing)\s+forward\s+with\s+(?:other|another)\s+(?:candidates?|applicants?)\b/i,
  /\b(?:pursue|proceed with|selected|considering|chose|chosen)\s+(?:other|another)\s+candidates?\b/i,
  // "went with another candidate" / "going in a different direction" family.
  /\b(?:go|went|gone|going|moved?|moving)\b[^.!?\n]{0,15}\b(?:with (?:another|a different) candidate|in a different direction)\b/i,
  /\b(?:have|has|had|were|was)(?:n't| not)\s+(?:been\s+)?(?:selected|chosen|successful)\b/i,
  /\b(?:been|are) unsuccessful\b/i,
  /\bno longer (?:be )?under consideration\b/i,
  // Passive family: "is no longer being considered", "cannot be considered further".
  /\b(?:no longer|not|cannot|can't|won't|will not)\s+be(?:ing)?\s+considered\b/i,
  /\bnot\s+(?:be\s+)?consider(?:ing|ed)?\s+you\b/i,
  // Filled/closed/canceled — singular, plural, and perfect forms.
  /\b(?:positions?|roles?|requisitions?|postings?|openings?|internships?|req)\b[^.!?\n]{0,24}\b(?:been|be|is|are|was|were|is now|are now)\s+(?:all\s+)?(?:filled|closed|cancell?ed)\b/i,
  /\b(?:have|has|we've|we have)\s+(?:already\s+|recently\s+|now\s+)?filled\s+(?:this|the|our|all)\b/i,
  /\bwill not be filling\b/i,
  /\b(?:hiring|position|role|requisitions?|posting|recruitment)\b[^.!?\n]{0,30}\bon hold\b/i,
  /\b(?:wasn't|was not|isn't|is not)\s+the\s+right\s+fit\b/i,
  /\bmore competitive applications?\b/i,
  // "…whose qualifications better align with the requirements" — but never
  // the positive redirect "aligns with our Data Analytics Internship".
  /\b(?:better|more closely) align(?:s|ed)?\s+with\s+(?:the |our )?(?:requirements|needs|qualifications|criteria)\b/i,
  /\b(?:don't|do not|haven't|have not|didn't|did not)\s+(?:currently\s+)?m(?:ee|e)t\s+the\s+(?:requirements|qualifications|criteria)\b/i,
  /\bdecided to pursue other\b/i,
  // Delivery-platform template tokens (job boards encode the decision in
  // tracking links even when the prose is neutral).
  /\bapplication[_-]rejected\b/i,
];
// Apologetic tone alone ("Unfortunately, we get a lot of applications…") is
// NOT a decision; it only counts alongside a decisive pattern.
const REJECT_WEAK = [/\bunfortunately\b/i, /\bafter careful (?:consideration|review|evaluation)\b/i];

const OFFER_PATTERNS: RegExp[] = [
  /\b(?:pleased|excited|delighted|happy|thrilled)\s+to\s+(?:offer|extend)\b/i,
  /\bextend(?:ing)?\s+(?:you\s+)?an\s+offer\b/i,
  /\boffer\s+of\s+(?:employment|internship)\b/i,
  /\boffer letter\b/i,
  /\bformal offer\b/i,
  /\byour offer (?:letter|details|package|from)\b/i,
  /\bwe(?:'| woul)d like to offer\b/i,
  // Same sentence only — "Congratulations! … We offer flexible options" is
  // not an offer.
  /\bcongratulations\b[^.!?\n]{0,80}\boffer\b/i,
  /\bsign(?:ing)?\s+(?:your|the)\s+offer\b/i,
];

const INTERVIEW_PATTERNS: RegExp[] = [
  /\binvit(?:e|ation|ing)\b[^.!?\n]{0,60}\b(?:interview|phone screen|video interview)\b/i,
  /\b(?:schedule|set up|arrange|book)\b[^.!?\n]{0,40}\b(?:interview|screen(?:ing)? call|phone screen)\b/i,
  // A generic "schedule a call" needs hiring context in the same sentence, or
  // every sales/advising call becomes an interview.
  /\b(?:schedule|set up|arrange|book)\b[^.!?\n]{0,40}\b(?:call|chat|conversation|meeting|time)\b[^.!?\n]{0,60}\b(?:recruiter|hiring|interview|your application|your candidacy|the role|the position|your background|next step)\b/i,
  /\b(?:recruiter|hiring (?:manager|team))\b[^.!?\n]{0,50}\b(?:schedule|set up|arrange|book)\b[^.!?\n]{0,30}\b(?:call|chat|time|meeting|conversation)\b/i,
  /\bschedule time to (?:speak|talk|chat|meet)\b/i,
  /\b(?:contact|reach out to|contacting)\s+you\b[^.!?\n]{0,40}\bto schedule\b/i,
  /\bphone screen\b/i,
  /\btechnical (?:interview|screen)\b/i,
  /\bonsite interview\b/i,
  /\binterview (?:invitation|invite|request|confirmation|days?)\b/i,
  /\bselected to (?:interview|move (?:on )?to (?:the |an? )?interview)\b/i,
  /\bconfirm your (?:interview\b|(?:participation|attendance|spot)\b[^.!?\n]{0,40}\binterview)/i,
  /\bone[- ]way (?:recorded )?(?:video )?interview\b/i,
  /\b(?:recorded|digital|virtual|video) interview\b/i,
  /\b(?:would|'d) (?:like|love) to (?:speak|chat|meet|connect|talk)\b[^.!?\n]{0,60}\b(?:your application|the (?:role|position)|your background|your experience|(?:our|the) (?:team|engineers?|hiring manager))\b/i,
  // Past-tense logistics ("I've scheduled your interview for Tuesday") and
  // concrete time proposals ("Are you free Tuesday at 2:00 PM?").
  /\b(?:I|we)(?:'ve| have)? (?:scheduled|booked|arranged|confirmed)\b[^.!?\n]{0,40}\b(?:interview|call|screen|meeting|time)\b/i,
  /\bare you (?:free|available)\b[^.!?\n]{0,60}\b(?:\d{1,2}(?::\d{2})?\s*(?:a|p)\.?m\.?|monday|tuesday|wednesday|thursday|friday)\b/i,
  /\b(?:pick|grab|choose|select) a time\b[^.!?\n]{0,40}\b(?:calendar|call|chat|speak|meet|connect)\b/i,
  /\b(?:calendly\.com|cal\.com|goodtime\.io)\b/i,
  /\b(?:your|share your) availability\b[^.!?\n]{0,50}\b(?:interview|call|chat|week)\b/i,
  /\bnext (?:round|step)s? (?:in|of) (?:the |your |our )?(?:interviews?|hiring process)\b/i,
  /\bhiring (?:manager|team) (?:would like|wants|has expressed)\b/i,
];

const OA_PATTERNS: RegExp[] = [
  /\bonline assessment\b/i,
  /\bcoding (?:assessment|challenge|test|exercise)\b/i,
  /\btechnical assessment\b/i,
  /\btake[- ]home (?:assignment|assessment|challenge|test)\b/i,
  /\bhackerrank\b/i,
  /\bcodesignal\b/i,
  /\bcodility\b/i,
  /\bcomplet(?:e|ing|ed) (?:the |your |our |this )?(?:\w+[- ]){0,4}assessment\b/i,
  /\bskills? assessment\b/i,
  /\bassessment (?:invitation|link|process|experience|deadline)\b/i,
  /\bpre[- ]?(?:hire|employment) (?:assessment|test)\b/i,
  /\b(?:aptitude|psychometric) test\b/i,
  /\bcandidate assessment\b/i,
  // Assessment platforms named in the invite (Sova/SHL/Plum-style surveys).
  /\b(?:sova|shl|plum|pymetrics|karat|criteria)\b[^.!?\n]{0,50}\b(?:assessment|survey|test|exercise)\b/i,
  /\b(?:behavioral|talent|discovery) (?:assessment|survey)\b/i,
];

const APPLIED_PATTERNS: RegExp[] = [
  /\bthank you for applying\b/i,
  /\bthanks for applying\b/i,
  /\bthank you for your (?:application|recent application)\b/i,
  /\bthank you for (?:your|the) interest\b/i,
  /\bapplication (?:has been |was |is )?(?:successfully )?(?:received|submitted)\b/i,
  /\b(?:we|we've|we have) (?:successfully )?received your application\b/i,
  /\byour application (?:to|for|has been|was|is)\b/i,
  /\bsuccessfully (?:applied|submitted)\b/i,
  /\bapplication confirmation\b/i,
  /\bwe(?:'ve| have) got your application\b/i,
  /\bresume has been submitted\b/i,
  /\b(?:is|are) (?:currently )?(?:under|in) review\b/i,
  /\b(?:currently )?review(?:ing)? your (?:application|information|experience|resume)\b/i,
  // "no longer being considered" is a rejection, not a review status.
  /(?<!no longer )(?<!not )\bbeing (?:evaluated|reviewed|considered)\b/i,
  /(?<!no longer )\bunder consideration\b/i,
];

const STAGE_PATTERNS: { stage: Stage; patterns: RegExp[]; decisive?: boolean }[] = [
  { stage: "rejected", patterns: REJECT_PATTERNS, decisive: true },
  { stage: "offer", patterns: OFFER_PATTERNS, decisive: true },
  { stage: "interview", patterns: INTERVIEW_PATTERNS },
  { stage: "oa", patterns: OA_PATTERNS },
  { stage: "applied", patterns: APPLIED_PATTERNS },
];

const FUNNEL_RANK: Partial<Record<Stage, number>> = { interview: 3, oa: 2, applied: 1 };

/**
 * Decide a single email's stage from how many patterns of each stage it hits.
 * Decisive stages (rejected/offer) are matched only against non-hedged,
 * non-instructional sentences and win outright; among funnel stages the most
 * evidence wins, ties to the more advanced stage.
 */
function detectStage(haystackRaw: string): { stage: Stage; confidence: number } | null {
  const haystack = decodeEntities(haystackRaw);
  const decisive = decisiveText(haystack);
  const unhedged = unhedgedText(haystack);

  const hits: Partial<Record<Stage, number>> = {};
  for (const { stage, patterns, decisive: isDecisive } of STAGE_PATTERNS) {
    const target = isDecisive
      ? decisive
      : stage === "interview" || stage === "oa"
        ? unhedged
        : haystack;
    const n = patterns.filter((p) => p.test(target)).length;
    if (n > 0) hits[stage] = n;
  }
  if (hits.rejected && REJECT_WEAK.some((p) => p.test(decisive))) hits.rejected += 1;

  const conf = (n: number) => Math.min(0.55 + n * 0.15, 0.95);
  if (hits.rejected) return { stage: "rejected", confidence: conf(hits.rejected) };
  if (hits.offer) return { stage: "offer", confidence: conf(hits.offer) };

  let best: Stage | null = null;
  for (const s of ["interview", "oa", "applied"] as Stage[]) {
    const n = hits[s];
    if (!n) continue;
    if (best === null || n > hits[best]! || (n === hits[best]! && FUNNEL_RANK[s]! > FUNNEL_RANK[best]!)) {
      best = s;
    }
  }
  return best ? { stage: best, confidence: conf(hits[best]!) } : null;
}

// ---------------------------------------------------------------------------
// Relevance gates: marketing, nudges, auto-replies, non-job "applications"
// ---------------------------------------------------------------------------

const MARKETING_MARKERS: RegExp[] = [
  /\bunsubscribe\b/i,
  /\bupdate your (?:email )?preferences\b/i,
  /\byou (?:are receiving|received) this (?:email|message) because\b/i,
  /\bapply (?:now|today|directly)\b/i,
  /\bjobs? (?:for|matching|near) you\b/i,
  /\brecommended (?:jobs|roles|opportunities|for you)\b/i,
  /\bincrease your chances\b/i,
  /\btalent (?:community|network)\b/i,
  /\bjob alert\b/i,
  /\bdon'?t miss\b/i,
  /\bnot in consideration\b[^.!?\n]{0,60}\buntil you\b/i,
  /\bhot jobs\b/i,
  /\bapplications?\b[^.!?\n]{0,80}\b(?:will open|are (?:now )?open|open(?:ing)? soon|open on)\b/i,
  /\b(?:will open on|are now open(?: as of)?|applications? go(?:es)? live)\b/i,
  /\bencourage you to apply\b/i,
  /\bimmediate openings?\b/i,
  /\b(?:we think |we believe )?you(?:'d| would| could)? be a (?:strong|great|good|perfect) fit\b/i,
  /\bnew (?:opportunities|openings|roles) (?:open|posted|added)\b/i,
  /\bweekly (?:digest|contest|challenge)\b/i,
  /\bearn (?:a )?badge\b/i,
  /\bupgrade to\b[^.!?\n]{0,30}\bpremium\b/i,
  /\binterview (?:prep|tips|guide|questions)\b/i,
  // Board notification vocabulary — activity pings, not status updates.
  /\bapplication (?:was |has been )?viewed\b/i,
  /\bis trending\b/i,
  /\bsee how you compare\b/i,
  /\binterest in careers\b/i,
  /\bmonthly (?:newsletter|update)\b/i,
];

// "You started an application but never submitted it" — there is no
// application to track (job boards AND employer ATS reminders alike).
const INCOMPLETE_MARKERS: RegExp[] = [
  /\bstarted an application\b/i,
  /\bapplication is (?:not yet |in)?complete[d]?\b.{0,80}\b(?:finish|complete|continue)\b/i,
  /\bapplication is incomplete\b/i,
  /\b(?:finish|complete|continue) (?:the|your) application\b/i,
  /\bcontinue applying\b/i,
  /\bstill working on (?:the|your) application\b/i,
  /\bnot (?:been )?able to (?:fully )?complete (?:it|your application)\b/i,
];
// "look forward to reviewing your application" is anticipation in a
// pre-application blast, not evidence that an application exists.
const SUBMITTED_MARKERS =
  /\b(?:received your application|application (?:has been|was|is) (?:successfully )?(?:received|submitted)|successfully (?:applied|submitted)|under (?:review|consideration)|(?<!forward to )reviewing your application|thank you for applying)\b/i;

const AUTOREPLY_MARKERS =
  /\b(?:automated (?:response|reply|message)|auto[- ]?reply|do not reply to this (?:mailbox|message|email)|responses? (?:from|to) this (?:mailbox|address)|business days? delay)\b/i;

// Social-network activity digests — arbitrary third-party post text ("I
// botched a technical interview last week") must never reach stage detection.
const SOCIAL_MARKERS =
  /\b(?:reacted to (?:this|a|your) post|liked (?:this|your)|commented on|shared a post|viewed your profile|invitations? to connect|wants to connect|new connections?|work anniversar(?:y|ies)|congratulate|posts? from your network|suggested for you)\b/i;

// Account plumbing (verify email, login details, password) is not a status.
const ACCOUNT_MARKERS =
  /\b(?:verify your email|confirm your email(?: address)?|email verification|account (?:setup|security|activation)|login details|username and password|reset your password|one[- ]time (?:passcode|password)|security code)\b/i;

// Every genuine funnel email references the application relationship somehow.
// ("offer" deliberately absent: "we want to offer you a voucher" is common in
// transactional mail, and real offers always name a position/role.)
const APPLICATION_CONTEXT =
  /\b(?:applicat|applie[ds]|applying|apply|candidac|candidate|position|role\b|req(?:uisition)?|job|intern|co[- ]?op|resume|résumé|cv\b|hiring|recruit|talent|assessment|interview)/i;

const NONJOB_HOUSING =
  /\b(?:guest card|move[- ]?in date|monthly rent|leasing (?:agent|office)|property tour|floor ?plans?|apartment home)\b/i;
const NONJOB_EDU: RegExp[] = [
  /\badmissions?\b/i,
  /\bcollege application\b/i,
  /\b(?:senior|junior) year\b/i,
  /\benroll(?:ment)?\b/i,
  /\bcampus visit\b/i,
  /\bfinancial aid\b/i,
  /\bscholarships? (?:application|portal|award|deadline)\b/i,
  /\beducation foundation\b/i,
  /\bschool district\b/i,
  /\b(?:freshman|sophomore) class\b/i,
];
const NONJOB_EVENT: RegExp[] = [
  /\b(?:application|applied|accepted?|acceptance) to [^.!?\n]{0,50}\b(?:school|camp|conference|summit|hackathon|bootcamp|accelerator)\b/i,
  /\b(?:attendees?|attend(?:ing)?|rsvp|waitlist(?:ed)?|registration|register(?:ed)?)\b/i,
  /\bhand[- ]?select(?:ing|ed)\b/i,
];

function countHits(text: string, patterns: RegExp[]): number {
  return patterns.filter((p) => p.test(text)).length;
}

interface Gates {
  marketing: boolean;
  incomplete: boolean;
  autoreply: boolean;
  nonjob: boolean;
}

function relevanceGates(email: ParsedEmail, text: string): Gates {
  const domain = domainOf(email.fromEmail);
  const trusted = isAts(domain) || isVendorDomain(domain);
  const board = isJobBoard(domain);
  const noisy = isNoise(domain);

  const rejectEvidence = countHits(decisiveText(text), REJECT_PATTERNS) > 0;
  const offerEvidence = countHits(text, OFFER_PATTERNS) > 0;
  const oaEvidence = countHits(text, OA_PATTERNS) > 0;
  const interviewEvidence = countHits(text, INTERVIEW_PATTERNS) > 0;
  const submitted = SUBMITTED_MARKERS.test(text);
  const statusEvidence =
    submitted || rejectEvidence || offerEvidence || oaEvidence || interviewEvidence;
  const decisionEvidence =
    rejectEvidence || offerEvidence || oaEvidence || interviewEvidence;

  const marketingScore = countHits(text, MARKETING_MARKERS);
  // Personal outcomes (rejection/offer) beat footer noise — employers
  // routinely append talent-community/job-alert footers to real decisions —
  // but never from newsletter-class domains ("your job offer" scam-warning
  // content). Funnel vocabulary protects only when personally addressed
  // ("invite you to complete…"), or prep digests would self-protect.
  const personalInvite =
    /\b(?:invit(?:e|ed|ing) you|your (?:assessment|interview|application)|complete (?:the|your|our) (?:online )?assessment)\b/i.test(
      text
    );
  // Content ABOUT offers/rejections (scam warnings, advice columns) is not an
  // outcome for this user.
  const scamTalk =
    /\b(?:scams?|fraud(?:ulent)?|phishing|fake (?:offers?|jobs?|recruiters?)|authenticity|suspicious activity|never (?:pay|send money))\b/i.test(
      text
    );
  const outcomeProtected =
    ((rejectEvidence || offerEvidence) && !noisy && !scamTalk) ||
    (((oaEvidence || interviewEvidence) && personalInvite && !board && !noisy) ||
      (submitted && !board && !noisy && !scamTalk));
  const marketing = !trusted && marketingScore >= 2 && !outcomeProtected;

  // A decision or assessment/interview implies a submitted application, so
  // "thank you for taking the time to complete your application; however…"
  // must not read as an unfinished-application nudge.
  const incomplete = countHits(text, INCOMPLETE_MARKERS) > 0 && !statusEvidence;

  // Reply threads are correspondence the user started, not ATS status mail —
  // only a decisive decision/invite in the reply keeps it relevant.
  const autoreply =
    /^\s*(?:automatic reply|auto[- ]?reply|out of office)\b/i.test(email.subject) ||
    (/^\s*(?:RE|AW|FW|FWD)\s*:/i.test(email.subject) &&
      (AUTOREPLY_MARKERS.test(text) || !decisionEvidence));

  // Personal mailboxes never deliver employer status mail.
  const freemail = isFreemail(domain) && !decisionEvidence;

  // Social feed digests: board sender + activity vocabulary. Post text is
  // arbitrary, so no amount of stage evidence rescues these.
  const social = (board || noisy) && SOCIAL_MARKERS.test(text);

  // Account plumbing (verify email / login details) is never a status update.
  const account = ACCOUNT_MARKERS.test(text) && !decisionEvidence && !submitted;

  // Job-board mail that never references an actual application is a blast.
  const boardBlast =
    board &&
    !decisionEvidence &&
    !/\b(?:your application|you (?:recently )?applied|application (?:to|for|was|has been))\b/i.test(text);

  // Decision language without ANY application vocabulary is transactional
  // mail (trip cancellations, subscription changes), not a rejection.
  const noAppContext = !APPLICATION_CONTEXT.test(text);

  // Non-job "applications" (housing/education/events). A job title exempts;
  // decision outcomes do NOT for education — admissions decisions are still
  // admissions. Admissions-mailbox and .edu senders without a job title are
  // structural education signals on their own.
  const jobNoun = ROLE_TITLE_NOUN.test(text);
  const admissionsSender =
    /admission/i.test(email.fromEmail) || (domain.endsWith(".edu") && !jobNoun);
  const housingHits = (text.match(new RegExp(NONJOB_HOUSING.source, "gi")) ?? []).length;
  const nonjob =
    (admissionsSender && !oaEvidence && !interviewEvidence) ||
    (!jobNoun &&
      ((!decisionEvidence && (housingHits >= 2 || countHits(text, NONJOB_EVENT) >= 2)) ||
        countHits(text, NONJOB_EDU) >= 2));

  return {
    marketing: marketing || boardBlast || noAppContext,
    incomplete,
    autoreply: autoreply || freemail || account,
    nonjob: nonjob || social,
  };
}

/**
 * Structural irrelevance that even a contrary LLM verdict must not override:
 * social digests, admissions/.edu mail, account plumbing, non-job categories.
 */
function hardIrrelevant(email: ParsedEmail, text: string): boolean {
  const g = relevanceGates(email, decodeEntities(text));
  return g.nonjob || (ACCOUNT_MARKERS.test(text) && !SUBMITTED_MARKERS.test(text));
}

// ---------------------------------------------------------------------------
// Rule-based classification
// ---------------------------------------------------------------------------

export function classifyWithRules(email: ParsedEmail): Classification {
  const domain = domainOf(email.fromEmail);
  // The snippet is a hard-truncated preview ("…can't consider you for the
  // role[ until…]") that can fabricate decisive clauses — only use it when
  // there is no body.
  const haystack = decodeEntities(
    `${email.subject}\n${email.body ? email.body.slice(0, 2000) : email.snippet}`
  );
  const detected = detectStage(haystack);
  const ats = isAts(domain) || isVendorDomain(domain);
  const gates = relevanceGates(email, haystack);

  const relevant =
    (Boolean(detected) || ats) &&
    !(isNoise(domain) && !detected) &&
    !gates.marketing &&
    !gates.incomplete &&
    !gates.autoreply &&
    !gates.nonjob;

  const company = extractCompany(email);
  let role = roleCandidate(extractRole(email));
  if (role && roleIsJustCompany(role, company)) role = null;
  const req = extractReqId(decodeEntities(`${email.subject}\n${email.body.slice(0, 1200)}`));

  return {
    relevant,
    stage: detected?.stage ?? "applied",
    company,
    role,
    req,
    confidence: detected?.confidence ?? (ats ? 0.4 : 0.2),
    source: "rules",
  };
}

/**
 * True when the role is really just an echo of the company name ("At IBM" →
 * "IBM", "Visa Intern"). Long company names keep legitimate overlaps — a
 * "Design Intern" at Design Within Reach is a real title.
 */
function roleIsJustCompany(role: string, company: string): boolean {
  const rk = normRole(role);
  if (!rk) return false;
  const companyTokens = new Set(normCompany(company).split(" ").filter(Boolean));
  if (!companyTokens.size || companyTokens.size > 2) return false;
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
For each email decide "relevant": false for anything that is NOT a status update about a job application the user already submitted to an employer. NOT relevant includes: newsletters, job alerts/digests, marketing, news, social; job-board nudges to FINISH an incomplete application (WayUp/ZipRecruiter/Handshake style "finish your application", "increase your chances"); employer reminders that an application was STARTED but never submitted; "join our talent community" / "apply now" blasts about roles the user has not applied to; coding-practice or interview-prep promotions; applications to events, programs, courses, accelerators, or schools (e.g. a "Startup School"); college admissions; housing/apartment applications; auto-reply acknowledgements to the user's own inquiry.
If relevant, classify "stage". Be conservative: only advance the stage when the email EXPLICITLY does the thing. Conditional or hypothetical language NEVER sets a stage ("if you are selected...", "you may be invited to complete an assessment", "we'll likely move forward with other candidates if...", "tips in case you land an interview").
- "applied": application received / confirmation / still under review / being considered. Default when unsure.
- "oa": invites or reminds the candidate to take an online assessment, coding challenge, or take-home (including via vendors like HackerRank, CodeSignal, Sova, SHL). Recorded-answer questions embedded INSIDE an assessment battery are "oa".
- "interview": actually invites or schedules an interview, phone screen, or call (asks for availability, proposes times, says "let's schedule", confirms an interview). Anything the email itself CALLS an interview — including a ONE-WAY RECORDED VIDEO INTERVIEW — is "interview". Completion receipts keep the stage of the thing completed: assessment receipt = "oa", interview receipt = "interview".
- "offer": an actual job/internship offer is extended (offer letter, "pleased to offer"). "Unable to offer you this position" is a REJECTION, not an offer.
- "rejected": a decisive statement that THIS application is not proceeding: not selected, not moving forward, moving forward with other candidates/applicants, position filled/closed/canceled, "wasn't the right fit", "more competitive applications", requisition closed.
Extract:
- "company": the hiring ORGANIZATION's common short name (e.g. "Fidelity" not "Fidelity Investments Inc"). NEVER a person's name. NEVER the ATS (Workday/Greenhouse/Lever/iCIMS/BrassRing/ADP), NEVER an assessment vendor (HackerRank/CodeSignal/Sova/HireVue/SHL), NEVER a job board (LinkedIn/WayUp/Indeed) — those are delivery channels; find the real employer in the subject, body, or signature. Never "X Talent Acquisition" — that is X. If you truly cannot tell, use "".
- "role": ONLY the clean job title (e.g. "Software Engineer Intern"). NO requisition IDs or numbers, NO dates or "Summer 2026", NO locations, NO process words ("assessment", "interview", "OA"). Do NOT invent a role from a sentence fragment, and NEVER output placeholder values like "string", "null", or a category name — when there is no real job title, use exactly "".
- "req": the requisition/job ID for THIS application exactly as written (e.g. "REQ342669", "JR2011493", "72366", "R-2026-63180"), or "" if none is stated. This distinguishes multiple applications at the same company.`;

// Hard signals required for "promoting" emails — the LLM must not advance a
// stage the text doesn't support.
const INTERVIEW_SIGNAL = new RegExp(
  INTERVIEW_PATTERNS.map((p) => p.source).join("|"),
  "i"
);
const OFFER_SIGNAL = new RegExp(OFFER_PATTERNS.map((p) => p.source).join("|"), "i");
const OA_SIGNAL = new RegExp(OA_PATTERNS.map((p) => p.source).join("|"), "i");
const REJECT_SIGNAL = new RegExp(
  [...REJECT_PATTERNS, ...REJECT_WEAK].map((p) => p.source).join("|"),
  "i"
);

/** Prevent the model from advancing a stage the email doesn't support. */
function guardStage(stage: Stage, textRaw: string): Stage {
  const text = decodeEntities(textRaw);
  if (stage === "interview" && !INTERVIEW_SIGNAL.test(text)) {
    return OA_SIGNAL.test(text) ? "oa" : "applied";
  }
  if (stage === "offer" && !OFFER_SIGNAL.test(text)) return "applied";
  // Symmetric: an "oa" verdict on interview-worded text (e.g. a video-
  // interview completion receipt) corrects to interview, not applied.
  if (stage === "oa" && !OA_SIGNAL.test(text)) {
    return INTERVIEW_SIGNAL.test(text) ? "interview" : "applied";
  }
  if (stage === "rejected" && !REJECT_SIGNAL.test(text)) return "applied";
  return stage;
}

function mergeLlmWithRules(
  llm: Partial<Classification> & { relevant: boolean; stage: Stage },
  rules: Classification,
  text: string,
  email: ParsedEmail
): Classification {
  const fromEmail = email.fromEmail;
  // Structural non-job mail (admissions, social digests, account plumbing)
  // stays irrelevant even when the model disagrees.
  if (llm.relevant && hardIrrelevant(email, text)) {
    return { ...rules, relevant: false, source: "llm" };
  }
  // Company: the LLM's answer, but only if it is a plausible org name and not
  // a vendor/board; otherwise a VALIDATED rules value; otherwise Unknown.
  // Junk must never be resurrected just because a field is empty.
  const llmCompany =
    llm.company && llm.company !== "Unknown Company"
      ? companyCandidate(llm.company) ?? (isPlausibleCompany(llm.company) ? llm.company : null)
      : null;
  const rulesCompany =
    rules.company !== "Unknown Company" && isPlausibleCompany(rules.company)
      ? rules.company
      : null;

  // Role: LLM's cleaned title; explicit "" means "no real title" and is
  // respected. Rules roles are already validated, so they are a safe fallback
  // only when the LLM did not answer at all. Prose/process outputs from the
  // model ("Online Assessment") are rejected the same way rules roles are.
  let llmRole = sanitizeRole(llm.role ?? null);
  if (
    llmRole &&
    (ROLE_FRAGMENT_WORDS.test(llmRole) ||
      /^(?:online )?(?:assessment|interview|oa|coding (?:test|challenge))$/i.test(llmRole) ||
      // Schema echoes and category names are not titles.
      /^(?:string|null|undefined|none|n\/?a|unknown|role|title|not specified|college admissions?|admissions?|scholarship)$/i.test(llmRole))
  ) {
    llmRole = null;
  }
  const role = llm.role !== undefined ? llmRole : llmRole ?? rules.role;

  // req is the strongest grouping identity, so a hallucinated or bled req
  // splits cards: only accept an LLM req that literally appears in the email.
  const textAlnum = decodeEntities(text).replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const llmReqNorm =
    typeof llm.req === "string" ? llm.req.trim().replace(/[^A-Za-z0-9]/g, "").toUpperCase() : "";
  const req =
    llmReqNorm.length >= 4 &&
    llmReqNorm.length <= 16 &&
    !/^20\d{2}$/.test(llmReqNorm) &&
    textAlnum.includes(llmReqNorm)
      ? llmReqNorm
      : rules.req ?? null;

  // Relevance rescue: the model saying "irrelevant" permanently drops the
  // email, so a decisive rules-detected outcome (rejection/offer) from a
  // non-board, non-noise sender survives an LLM relevance miss.
  const domain = domainOf(fromEmail);
  if (
    !llm.relevant &&
    rules.relevant &&
    (rules.stage === "rejected" || rules.stage === "offer") &&
    rules.confidence >= 0.7 &&
    !isJobBoard(domain) &&
    !isNoise(domain) &&
    !isFreemail(domain)
  ) {
    return { ...rules };
  }

  return {
    relevant: llm.relevant,
    stage: guardStage(llm.stage, text),
    company: llmCompany ?? rulesCompany ?? "Unknown Company",
    role,
    req,
    confidence: 0.92,
    source: "llm",
  };
}

// After a fully-failed call, skip Gemini for a cooldown window so a brownout
// doesn't burn the whole serverless time budget on futile retries.
let geminiCooldownUntil = 0;

/** fetch Gemini with retry/backoff; silent degradation is logged, not hidden. */
async function callGemini(
  url: string,
  apiKey: string,
  payload: unknown
): Promise<string | null> {
  // 15s timeout × 3 attempts + backoff stays inside a 60s serverless budget.
  const delays = [0, 1000, 3000];
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt]) await new Promise((r) => setTimeout(r, delays[attempt]));
    try {
      const res = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify(payload),
        },
        15000
      );
      if (!res.ok) {
        console.warn(
          `[classifier] gemini attempt ${attempt + 1}/${delays.length} failed: HTTP ${res.status}`
        );
        // 4xx other than 429 won't heal on retry.
        if (res.status !== 429 && res.status < 500) return null;
        // Respect Retry-After when present (capped so we stay in budget).
        const ra = Number(res.headers.get("retry-after"));
        if (ra > 0 && attempt + 1 < delays.length) {
          delays[attempt + 1] = Math.min(5000, Math.max(delays[attempt + 1], ra * 1000));
        }
        continue;
      }
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (typeof text === "string" && text) return text;
      console.warn(`[classifier] gemini attempt ${attempt + 1}: empty response`);
    } catch (e) {
      console.warn(
        `[classifier] gemini attempt ${attempt + 1}/${delays.length} threw: ${e instanceof Error ? e.message : e}`
      );
    }
  }
  geminiCooldownUntil = Date.now() + 60_000;
  return null;
}

/**
 * Classify a batch of emails in a single Gemini call (thinking disabled for
 * speed). Falls back to rules per-email when the model couldn't classify, and
 * for the whole batch when the call ultimately fails — loudly (console.warn).
 */
export async function classifyEmails(
  emails: ParsedEmail[]
): Promise<Classification[]> {
  const ruleResults = emails.map(classifyWithRules);
  if (!llmEnabled() || emails.length === 0) return ruleResults;
  if (Date.now() < geminiCooldownUntil) {
    console.warn(
      `[classifier] gemini cooling down after failures — rules for ${emails.length} email(s)`
    );
    return ruleResults;
  }

  const apiKey = process.env.GEMINI_API_KEY!;
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  // Same window the rules and guards see — a decision stated at char 1800
  // must be visible to the model whose verdict wins.
  const emailBlocks = emails
    .map(
      (e, i) =>
        `### Email ${i}\nFrom: ${e.fromName} <${e.fromEmail}>\nSubject: ${e.subject}\nBody:\n${e.body.slice(0, 2000)}`
    )
    .join("\n\n");

  const payload = {
    contents: [
      {
        parts: [
          {
            text: `${SYSTEM_RULES}\n\nClassify ALL ${emails.length} emails below. Return a JSON array with one object per email IN ORDER, each: {"index", "relevant", "stage", "company", "role", "req"}.\n\n${emailBlocks}`,
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      thinkingConfig: { thinkingBudget: 0 },
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
            req: { type: "STRING" },
          },
          required: ["index", "relevant", "stage", "company"],
        },
      },
    },
  };

  const text = await callGemini(url, apiKey, payload);
  if (!text) {
    console.warn(
      `[classifier] gemini unavailable after retries — falling back to rules for ${emails.length} email(s)`
    );
    return ruleResults;
  }

  try {
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) {
      console.warn("[classifier] gemini returned non-array JSON — using rules");
      return ruleResults;
    }

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
      const role = typeof item.role === "string" ? item.role.trim() : undefined;
      const req = typeof item.req === "string" ? item.req : undefined;
      const emailText = `${emails[i].subject}\n${emails[i].body.slice(0, 2000)}`;
      out[i] = mergeLlmWithRules(
        { relevant: item.relevant, stage, company, role, req },
        ruleResults[i],
        emailText,
        emails[i]
      );
    }
    return out;
  } catch {
    console.warn("[classifier] gemini JSON parse failed — using rules");
    return ruleResults;
  }
}

/** Single-email convenience wrapper around the batch classifier. */
export async function classifyEmail(email: ParsedEmail): Promise<Classification> {
  const [c] = await classifyEmails([email]);
  return c;
}

// ---------------------------------------------------------------------------
// Canonical identities used to group an applicant's cards
// ---------------------------------------------------------------------------

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
  "assessment", "assessments", "skills", "online", "oa", "test", "testing", "challenge",
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
        !/\d/.test(t) &&
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
  return inter === smaller || inter / union >= 0.6;
}

export function dedupKey(company: string, role: string | null, req?: string | null): string {
  return `${normCompany(company)}::${normRole(role)}::${req ?? ""}`;
}

/**
 * Same employer under a name variant: one key's tokens are a subset of the
 * other's ("impulse" ⊂ "impulse space", "sofi" ⊂ "sofi technologies").
 * Token-level, so "apple" never matches "applebees".
 */
export function companyKeySimilar(a: string, b: string): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const ta = a.split(" ").filter(Boolean);
  const tb = b.split(" ").filter(Boolean);
  if (!ta.length || !tb.length) return false;
  const [small, big] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const bigSet = new Set(big);
  return small.every((t) => bigSet.has(t));
}
