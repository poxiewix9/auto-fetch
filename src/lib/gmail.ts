// Server-side Gmail API helpers. Refreshes a Google access token from a stored
// refresh token, then lists/fetches messages and decodes their payloads.

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

/** fetch() with an abort timeout so a stuck request can't stall the sync. */
export async function fetchWithTimeout(
  url: string,
  opts: RequestInit = {},
  ms = 20000
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export interface GmailMessageMeta {
  id: string;
  threadId: string;
}

export interface ParsedEmail {
  id: string;
  threadId: string;
  subject: string;
  fromName: string;
  fromEmail: string;
  date: Date;
  snippet: string;
  body: string;
}

/** Exchange a stored refresh token for a fresh access token. */
export async function getAccessToken(refreshToken: string): Promise<string> {
  const res = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    throw new Error(`Token refresh failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

async function gmailFetch<T>(path: string, token: string): Promise<T> {
  const res = await fetchWithTimeout(`${GMAIL_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Gmail API ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

/** List message IDs matching a Gmail search query, paging up to maxTotal. */
export async function listMessages(
  token: string,
  query: string,
  maxTotal = 150
): Promise<GmailMessageMeta[]> {
  const out: GmailMessageMeta[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      q: query,
      maxResults: String(Math.min(100, maxTotal - out.length)),
    });
    if (pageToken) params.set("pageToken", pageToken);

    const data = await gmailFetch<{
      messages?: GmailMessageMeta[];
      nextPageToken?: string;
    }>(`/messages?${params.toString()}`, token);

    if (data.messages) out.push(...data.messages);
    pageToken = data.nextPageToken;
  } while (pageToken && out.length < maxTotal);

  return out;
}

interface RawPayload {
  mimeType?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string };
  parts?: RawPayload[];
}

interface RawMessage {
  id: string;
  threadId: string;
  snippet?: string;
  internalDate?: string;
  payload?: RawPayload;
}

export async function getMessage(token: string, id: string): Promise<ParsedEmail> {
  const msg = await gmailFetch<RawMessage>(`/messages/${id}?format=full`, token);
  const payload = msg.payload ?? {};

  const subject = getHeader(payload, "Subject");
  const from = getHeader(payload, "From");
  const { name, email } = parseFrom(from);

  const date = msg.internalDate
    ? new Date(Number(msg.internalDate))
    : new Date(getHeader(payload, "Date") || Date.now());

  return {
    id: msg.id,
    threadId: msg.threadId,
    subject,
    fromName: name,
    fromEmail: email,
    date,
    snippet: msg.snippet ?? "",
    body: extractBody(payload),
  };
}

function getHeader(payload: RawPayload, name: string): string {
  const target = name.toLowerCase();
  const found = payload.headers?.find((h) => h.name.toLowerCase() === target);
  return found?.value ?? "";
}

function parseFrom(from: string): { name: string; email: string } {
  // Formats: "Display Name <addr@x.com>" or "addr@x.com"
  const match = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (match) {
    return { name: match[1].trim(), email: match[2].trim().toLowerCase() };
  }
  const email = from.trim().toLowerCase();
  return { name: "", email };
}

/** Fetch the authenticated account's own email address. */
export async function getProfileEmail(token: string): Promise<string> {
  try {
    const data = await gmailFetch<{ emailAddress?: string }>("/profile", token);
    return (data.emailAddress ?? "").toLowerCase();
  } catch {
    return "";
  }
}

/** Decode Gmail's Base64URL data into UTF-8 text. */
export function decodeBase64Url(data: string): string {
  if (!data) return "";
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf-8");
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function findPart(payload: RawPayload, mimeType: string): string {
  if (payload.mimeType === mimeType && payload.body?.data) {
    return payload.body.data;
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const found = findPart(part, mimeType);
      if (found) return found;
    }
  }
  return "";
}

/**
 * Strip quoted reply/forward history so only the newest message remains.
 * Cuts at the first reply marker and drops leading "> " quote lines.
 */
export function stripQuotedText(text: string): string {
  const lines = text.split(/\r?\n/);
  const markers = [
    /^\s*On\b.{0,300}\bwrote:\s*$/i, // Gmail "On <date> <name> wrote:"
    /^\s*-{2,}\s*Original Message\s*-{2,}/i,
    /^\s*-{2,}\s*Forwarded message\s*-{2,}/i,
    /^\s*_{10,}\s*$/, // Outlook divider
    /^\s*From:\s.+\s*$/i, // Outlook quoted header block
    /^\s*Sent from my\b/i,
    /^\s*Get Outlook for\b/i,
  ];

  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (markers.some((m) => m.test(lines[i]))) {
      cut = i;
      break;
    }
  }

  const kept = lines
    .slice(0, cut)
    .filter((l) => !/^\s*>/.test(l)); // drop inline quoted lines

  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function extractBody(payload: RawPayload): string {
  const plain = findPart(payload, "text/plain");
  if (plain) return stripQuotedText(decodeBase64Url(plain));

  const html = findPart(payload, "text/html");
  if (html) return stripQuotedText(htmlToText(decodeBase64Url(html)));

  if (payload.body?.data)
    return stripQuotedText(decodeBase64Url(payload.body.data));
  return "";
}

/**
 * Gmail search query that captures the common application funnel stages while
 * limiting noise. `afterEpochSeconds` lets us only fetch new mail since last sync.
 */
export function buildQuery(afterEpochSeconds?: number): string {
  // High-precision application phrases (avoid bare "interview"/"offer" which
  // match newsletters) plus known ATS senders.
  const phrases = [
    '"thank you for applying"',
    '"thanks for applying"',
    '"thank you for your application"',
    '"thank you for your interest in"',
    '"application received"',
    '"received your application"',
    '"your application to"',
    '"your application for"',
    '"your application has been"',
    '"application was submitted"',
    '"online assessment"',
    '"coding assessment"',
    '"coding challenge"',
    '"take-home"',
    '"hackerrank"',
    '"codesignal"',
    '"schedule a"',
    '"phone screen"',
    '"technical interview"',
    '"interview invitation"',
    '"invite you to interview"',
    '"move forward with your application"',
    '"not to move forward"',
    '"we regret to inform"',
    '"pleased to offer"',
    '"offer of employment"',
  ];
  const senders = [
    "greenhouse.io",
    "lever.co",
    "myworkday.com",
    "myworkdayjobs.com",
    "ashbyhq.com",
    "icims.com",
    "smartrecruiters.com",
    "jobvite.com",
    "workable.com",
    "bamboohr.com",
    "hirevue.com",
  ];
  const terms = [...phrases, ...senders.map((s) => `from:${s}`)];
  // Exclude mail you sent (your own replies), chats, and newsletter/news noise.
  const excludes =
    "-from:me -in:sent -in:chats -category:promotions -category:social -in:spam -from:nytimes.com -from:cnn.com -from:quora.com -from:substack.com -from:medium.com";
  let q = `(${terms.join(" OR ")}) ${excludes}`;
  if (afterEpochSeconds) q += ` after:${afterEpochSeconds}`;
  return q;
}
