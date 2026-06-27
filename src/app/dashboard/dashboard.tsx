"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { TallyLogo } from "@/components/logo";
import { FunnelView } from "./funnel";
import {
  ALL_STAGES,
  STAGES,
  STAGE_META,
  boardColumn,
  type Application,
  type Stage,
} from "@/lib/types";

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

type SortKey = "recent" | "oldest" | "company";

const COMPANY_SUFFIXES =
  /\b(inc|llc|ltd|corp|corporation|co|company|the|technologies|technology|labs|group|holdings|global|international|systems|solutions|financial|investments|investment|capital|partners)\b/g;

function companyKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(COMPANY_SUFFIXES, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function looksSameCompany(a: string, b: string): boolean {
  const ka = companyKey(a);
  const kb = companyKey(b);
  if (!ka || !kb) return false;
  return ka === kb || ka.includes(kb) || kb.includes(ka);
}

export function Dashboard({
  email,
  applications,
  lastSyncedAt,
  signedIn = true,
}: {
  email: string;
  applications: Application[];
  lastSyncedAt: string | null;
  signedIn?: boolean;
}) {
  const router = useRouter();
  const [apps, setApps] = useState<Application[]>(applications);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("recent");
  const [stageFilter, setStageFilter] = useState<Stage | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [scanLimit, setScanLimit] = useState(300);
  const [view, setView] = useState<"board" | "funnel">("board");

  useEffect(() => setApps(applications), [applications]);

  useEffect(() => {
    const saved = Number(localStorage.getItem("tally:scanLimit"));
    if (Number.isFinite(saved) && saved >= 10) setScanLimit(saved);
  }, []);

  function updateScanLimit(n: number) {
    const clamped = Math.min(Math.max(Math.round(n) || 0, 10), 1000);
    setScanLimit(clamped);
    localStorage.setItem("tally:scanLimit", String(clamped));
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = apps.filter((a) => {
      if (stageFilter && boardColumn(a.stage) !== stageFilter) return false;
      if (!q) return true;
      return (
        a.company.toLowerCase().includes(q) ||
        (a.role ?? "").toLowerCase().includes(q)
      );
    });
    list.sort((a, b) => {
      if (sort === "company") return a.company.localeCompare(b.company);
      const da = new Date(a.last_email_at).getTime();
      const db = new Date(b.last_email_at).getTime();
      return sort === "recent" ? db - da : da - db;
    });
    return list;
  }, [apps, search, sort, stageFilter]);

  const byStage = useMemo(() => {
    const map: Record<Stage, Application[]> = {
      applied: [],
      oa: [],
      interview: [],
      offer: [],
      accepted: [],
      declined: [],
      rejected: [],
    };
    for (const a of filtered) map[boardColumn(a.stage)]?.push(a);
    return map;
  }, [filtered]);

  const insights = useMemo(() => computeInsights(apps), [apps]);
  const selected = apps.find((a) => a.id === selectedId) ?? null;

  async function signIn() {
    const supabase = createClient();
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
        scopes: "https://www.googleapis.com/auth/gmail.readonly",
        queryParams: { access_type: "offline", prompt: "consent" },
      },
    });
  }

  async function handleSync() {
    if (!signedIn) {
      await signIn();
      return;
    }
    setSyncing(true);
    setMessage(null);
    try {
      const res = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxMessages: scanLimit }),
      });
      const data = await res.json();
      if (!res.ok) setMessage(data.error ?? "Sync failed.");
      else {
        setMessage(
          `Scanned ${data.scanned} emails · ${data.newEvents} new update${
            data.newEvents === 1 ? "" : "s"
          }.`
        );
        router.refresh();
      }
    } catch {
      setMessage("Sync failed. Check your connection.");
    } finally {
      setSyncing(false);
    }
  }

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/");
    router.refresh();
  }

  async function handleDeleteAccount() {
    if (
      !confirm(
        "Permanently delete your Tally account and all tracked applications? This cannot be undone."
      )
    )
      return;
    const res = await fetch("/api/account", { method: "DELETE" });
    if (!res.ok) {
      setMessage("Could not delete account.");
      return;
    }
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/");
    router.refresh();
  }

  async function patchApp(id: string, body: Record<string, unknown>) {
    const res = await fetch(`/api/applications/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      setMessage("Update failed.");
      router.refresh();
    }
  }

  function moveStage(id: string, stage: Stage) {
    setApps((prev) =>
      prev.map((a) => (a.id === id ? { ...a, stage, locked: true } : a))
    );
    patchApp(id, { stage });
  }

  function editApp(id: string, company: string, role: string) {
    setApps((prev) =>
      prev.map((a) =>
        a.id === id ? { ...a, company, role: role.trim() || null } : a
      )
    );
    patchApp(id, { company, role });
  }

  async function deleteApp(id: string) {
    setApps((prev) => prev.filter((a) => a.id !== id));
    setSelectedId(null);
    const res = await fetch(`/api/applications/${id}`, { method: "DELETE" });
    if (!res.ok) {
      setMessage("Delete failed.");
      router.refresh();
    }
  }

  async function mergeApp(targetId: string, sourceId: string) {
    setApps((prev) => prev.filter((a) => a.id !== sourceId));
    const res = await fetch(`/api/applications/${targetId}/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId }),
    });
    if (!res.ok) setMessage("Merge failed.");
    router.refresh();
  }

  const total = apps.length;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-10 border-b border-line bg-paper/85 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 py-4">
          <TallyLogo />
          <div className="flex items-center gap-4">
            {signedIn && (
              <span className="hidden text-[13px] text-faint sm:inline">
                Synced {timeAgo(lastSyncedAt)}
              </span>
            )}
            {signedIn && (
              <label
                className="hidden items-center gap-1.5 rounded-full border border-line bg-paper-raised py-1 pl-3 pr-1.5 sm:flex"
                title="How many recent emails to scan on each sync"
              >
                <span className="text-[13px] text-faint">Scan</span>
                <input
                  type="number"
                  min={10}
                  max={1000}
                  step={50}
                  value={scanLimit}
                  onChange={(e) => updateScanLimit(Number(e.target.value))}
                  className="tnum w-14 rounded-full bg-transparent px-1 text-center text-[13px] font-medium text-ink outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                />
              </label>
            )}
            <button
              onClick={handleSync}
              disabled={syncing}
              className="inline-flex items-center gap-2 rounded-full bg-ink px-4 py-2 text-[13px] font-medium text-paper transition hover:bg-ink/90 disabled:opacity-50"
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                className={syncing ? "animate-spin" : ""}
              >
                <path
                  d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              {syncing ? "Syncing…" : "Sync inbox"}
            </button>
            {signedIn && (
              <div className="group relative">
                <button className="flex h-8 w-8 items-center justify-center rounded-full border border-line-strong text-[13px] font-medium text-ink">
                  {email.charAt(0).toUpperCase()}
                </button>
                <div className="invisible absolute right-0 top-full mt-1.5 w-52 rounded-xl border border-line bg-paper-raised p-1 opacity-0 shadow-lg transition group-hover:visible group-hover:opacity-100">
                  <p className="truncate px-3 py-2 text-[13px] text-faint">{email}</p>
                  <button
                    onClick={handleSignOut}
                    className="w-full rounded-lg px-3 py-2 text-left text-sm text-ink hover:bg-black/[0.04]"
                  >
                    Sign out
                  </button>
                  <button
                    onClick={handleDeleteAccount}
                    className="w-full rounded-lg px-3 py-2 text-left text-sm text-[#8c4a40] hover:bg-[#b06a5f]/10"
                  >
                    Delete account &amp; data
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-8">
        <div className="mb-8 flex items-end justify-between gap-6">
          <div>
            <p className="eyebrow">The ledger</p>
            <div className="mt-2 flex items-baseline gap-3">
              <span className="tnum text-5xl font-semibold tracking-tight text-ink">
                {total}
              </span>
              <span className="text-sm text-muted">
                application{total === 1 ? "" : "s"} tracked
              </span>
            </div>
          </div>
        </div>

        {message && (
          <div className="mb-6 rounded-lg border border-line bg-paper-raised px-4 py-2.5 text-sm text-muted">
            {message}
          </div>
        )}

        <div className="mb-6 grid grid-cols-2 divide-line overflow-hidden rounded-xl border border-line bg-paper-raised sm:grid-cols-6 sm:divide-x">
          <StatCell
            label="Total"
            value={total}
            dot="bg-ink"
            active={stageFilter === null}
            onClick={() => setStageFilter(null)}
          />
          {STAGES.map((s) => (
            <StatCell
              key={s}
              label={STAGE_META[s].short}
              value={apps.filter((a) => boardColumn(a.stage) === s).length}
              dot={STAGE_META[s].dot}
              active={stageFilter === s}
              onClick={() => setStageFilter(stageFilter === s ? null : s)}
            />
          ))}
        </div>

        {total > 0 && <Insights insights={insights} />}

        <div className="mb-5 flex flex-wrap items-center gap-3">
          <div className="flex rounded-lg border border-line bg-paper-raised p-0.5">
            {(["board", "funnel"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`rounded-md px-3 py-1.5 text-[13px] font-medium capitalize transition ${
                  view === v ? "bg-ink text-paper" : "text-muted hover:text-ink"
                }`}
              >
                {v}
              </button>
            ))}
          </div>
          <div className="relative min-w-[220px] flex-1">
            <svg
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
            >
              <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
              <path d="m20 20-3-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search company or role"
              className="w-full rounded-lg border border-line bg-paper-raised py-2 pl-9 pr-3 text-sm text-ink placeholder-faint outline-none focus:border-line-strong"
            />
          </div>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="rounded-lg border border-line bg-paper-raised px-3 py-2 text-sm text-muted outline-none focus:border-line-strong"
          >
            <option value="recent">Most recent</option>
            <option value="oldest">Oldest</option>
            <option value="company">Company A–Z</option>
          </select>
          {stageFilter && (
            <button
              onClick={() => setStageFilter(null)}
              className="rounded-lg border border-line bg-paper-raised px-3 py-2 text-sm text-muted hover:border-line-strong"
            >
              {STAGE_META[stageFilter].short} ✕
            </button>
          )}
        </div>

        {total === 0 ? (
          <EmptyState onSync={handleSync} syncing={syncing} />
        ) : view === "funnel" ? (
          <FunnelView apps={apps} />
        ) : (
          <div className="grid grid-cols-1 gap-5 md:grid-cols-3 xl:grid-cols-5">
            {STAGES.map((stage) => (
              <Column
                key={stage}
                stage={stage}
                apps={byStage[stage]}
                onSelect={(a) => setSelectedId(a.id)}
                onDropCard={(id) => {
                  if (id) moveStage(id, stage);
                  setDragId(null);
                }}
                onDragStartCard={setDragId}
                dragId={dragId}
              />
            ))}
          </div>
        )}
      </main>

      <footer className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4 border-t border-line px-6 py-6 text-[13px] text-faint">
        <span>Read-only Gmail access · Your data stays yours.</span>
        <span className="flex gap-4">
          <a href="/privacy" className="hover:text-ink">
            Privacy
          </a>
          <a href="/terms" className="hover:text-ink">
            Terms
          </a>
        </span>
      </footer>

      {selected && (
        <DetailModal
          app={selected}
          duplicates={apps.filter(
            (a) => a.id !== selected.id && looksSameCompany(a.company, selected.company)
          )}
          onClose={() => setSelectedId(null)}
          onChangeStage={(s) => moveStage(selected.id, s)}
          onEdit={(company, role) => editApp(selected.id, company, role)}
          onDelete={() => deleteApp(selected.id)}
          onMerge={(sourceId) => mergeApp(selected.id, sourceId)}
        />
      )}
    </div>
  );
}

function StatCell({
  label,
  value,
  dot,
  active,
  onClick,
}: {
  label: string;
  value: number;
  dot: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`border-line px-4 py-3.5 text-left transition max-sm:border-b max-sm:odd:border-r ${
        active ? "bg-black/[0.04]" : "hover:bg-black/[0.02]"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
        <span className="eyebrow">{label}</span>
      </div>
      <p className="tnum mt-1.5 text-2xl font-semibold tracking-tight text-ink">
        {value}
      </p>
    </button>
  );
}

function Column({
  stage,
  apps,
  onSelect,
  onDropCard,
  onDragStartCard,
  dragId,
}: {
  stage: Stage;
  apps: Application[];
  onSelect: (a: Application) => void;
  onDropCard: (id: string | null) => void;
  onDragStartCard: (id: string) => void;
  dragId: string | null;
}) {
  const meta = STAGE_META[stage];
  const [over, setOver] = useState(false);

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!over) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onDropCard(e.dataTransfer.getData("text/plain") || dragId);
      }}
      className="flex flex-col"
    >
      <div className="mb-3 flex items-center justify-between border-b border-line pb-2.5">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${meta.dot}`} />
          <h2 className="text-[13px] font-medium text-ink">{meta.short}</h2>
        </div>
        <span className="tnum text-[13px] text-faint">{apps.length}</span>
      </div>
      <div
        className={`scroll-thin flex max-h-[calc(100vh-24rem)] flex-col gap-2.5 overflow-y-auto rounded-lg p-0.5 transition ${
          over ? "bg-black/[0.03] ring-1 ring-line-strong" : ""
        }`}
      >
        {apps.length === 0 ? (
          <p className="px-1 py-8 text-center text-xs text-faint">—</p>
        ) : (
          apps.map((app) => (
            <button
              key={app.id}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("text/plain", app.id);
                onDragStartCard(app.id);
              }}
              onClick={() => onSelect(app)}
              className={`cursor-grab rounded-lg border p-3.5 text-left transition active:cursor-grabbing ${meta.tint}`}
            >
              <p className="truncate text-sm font-medium text-ink">
                {app.company}
              </p>
              {app.role && (
                <p className="mt-0.5 truncate text-xs text-muted">{app.role}</p>
              )}
              <div className="mt-2.5 flex items-center justify-between gap-2">
                <span className="tnum text-[11px] text-faint">
                  {fmtDate(app.last_email_at)}
                </span>
                {(app.stage === "accepted" || app.stage === "declined") && (
                  <span
                    className={`rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${STAGE_META[app.stage].color}`}
                  >
                    {STAGE_META[app.stage].short}
                  </span>
                )}
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function Insights({ insights }: { insights: ReturnType<typeof computeInsights> }) {
  return (
    <div className="mb-6 grid gap-px overflow-hidden rounded-xl border border-line bg-line lg:grid-cols-5">
      <Metric label="Response rate" value={`${insights.responseRate}%`} />
      <Metric label="Interview rate" value={`${insights.interviewRate}%`} />
      <Metric label="Offer rate" value={`${insights.offerRate}%`} />
      <div className="bg-paper-raised p-4 lg:col-span-2">
        <div className="flex items-center justify-between">
          <p className="eyebrow">Applications per week</p>
          <p className="tnum text-[11px] text-faint">peak {insights.maxWeek}</p>
        </div>
        <div className="mt-3 flex h-16 items-end gap-1.5 border-b border-line-strong pb-px">
          {insights.weekly.map((w, i) => {
            const h = w.count > 0 ? Math.max(10, (w.count / insights.maxWeek) * 100) : 0;
            return (
              <div
                key={i}
                className="group/bar relative flex flex-1 items-end justify-center"
                style={{ height: "100%" }}
                title={`${w.full}: ${w.count}`}
              >
                <div
                  className="w-full max-w-[18px] rounded-t-[3px] bg-ink/75 transition group-hover/bar:bg-ink"
                  style={{ height: `${h}%`, minHeight: w.count > 0 ? 4 : 0 }}
                />
                {w.count > 0 && (
                  <span className="tnum pointer-events-none absolute -top-4 left-1/2 -translate-x-1/2 text-[10px] text-faint opacity-0 transition group-hover/bar:opacity-100">
                    {w.count}
                  </span>
                )}
              </div>
            );
          })}
        </div>
        <div className="mt-1.5 flex justify-between text-[10px] text-faint">
          <span>{insights.weekly.length} wks ago</span>
          <span>this week</span>
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-paper-raised p-4">
      <p className="eyebrow">{label}</p>
      <p className="tnum mt-1.5 text-2xl font-semibold tracking-tight text-ink">
        {value}
      </p>
    </div>
  );
}

function DetailModal({
  app,
  duplicates,
  onClose,
  onChangeStage,
  onEdit,
  onDelete,
  onMerge,
}: {
  app: Application;
  duplicates: Application[];
  onClose: () => void;
  onChangeStage: (s: Stage) => void;
  onEdit: (company: string, role: string) => void;
  onDelete: () => void;
  onMerge: (sourceId: string) => void;
}) {
  const meta = STAGE_META[app.stage];
  const events = [...(app.application_events ?? [])].sort(
    (a, b) => new Date(b.email_at).getTime() - new Date(a.email_at).getTime()
  );
  const [openId, setOpenId] = useState<string | null>(events[0]?.id ?? null);
  const [editing, setEditing] = useState(false);
  const [company, setCompany] = useState(app.company);
  const [role, setRole] = useState(app.role ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[86vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-line bg-paper-raised shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-line p-6">
          <div className="flex items-start justify-between">
            <div className="min-w-0 flex-1">
              {editing ? (
                <div className="space-y-2">
                  <input
                    value={company}
                    onChange={(e) => setCompany(e.target.value)}
                    placeholder="Company"
                    className="w-full rounded-lg border border-line bg-paper px-3 py-1.5 text-sm font-medium text-ink outline-none focus:border-line-strong"
                  />
                  <input
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                    placeholder="Role (optional)"
                    className="w-full rounded-lg border border-line bg-paper px-3 py-1.5 text-sm text-ink outline-none focus:border-line-strong"
                  />
                </div>
              ) : (
                <>
                  <h3 className="truncate text-xl font-semibold tracking-tight text-ink">
                    {app.company}
                  </h3>
                  {app.role && (
                    <p className="truncate text-sm text-muted">{app.role}</p>
                  )}
                </>
              )}
            </div>
            <button
              onClick={onClose}
              className="ml-3 rounded-lg p-1.5 text-faint hover:bg-black/[0.04] hover:text-ink"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                <path d="M18 6 6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="eyebrow">Stage</span>
            <select
              value={app.stage}
              onChange={(e) => onChangeStage(e.target.value as Stage)}
              className={`rounded-full border px-2.5 py-1 text-xs font-medium outline-none ${meta.color}`}
            >
              {ALL_STAGES.map((s) => (
                <option key={s} value={s}>
                  {STAGE_META[s].label}
                </option>
              ))}
            </select>
            <div className="ml-auto flex items-center gap-2">
              {editing ? (
                <>
                  <button
                    onClick={() => {
                      onEdit(company, role);
                      setEditing(false);
                    }}
                    className="rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-paper hover:bg-ink/90"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => {
                      setCompany(app.company);
                      setRole(app.role ?? "");
                      setEditing(false);
                    }}
                    className="rounded-full px-3 py-1.5 text-xs text-faint hover:bg-black/[0.04]"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => setEditing(true)}
                    className="rounded-full border border-line px-3.5 py-1.5 text-xs text-muted hover:border-line-strong"
                  >
                    Edit
                  </button>
                  {confirmDelete ? (
                    <button
                      onClick={onDelete}
                      className="rounded-full bg-[#b06a5f] px-3.5 py-1.5 text-xs font-medium text-paper hover:opacity-90"
                    >
                      Confirm delete
                    </button>
                  ) : (
                    <button
                      onClick={() => setConfirmDelete(true)}
                      className="rounded-full border border-[#b06a5f]/40 px-3.5 py-1.5 text-xs text-[#8c4a40] hover:bg-[#b06a5f]/10"
                    >
                      Delete
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        <div className="scroll-thin flex-1 overflow-y-auto p-6">
          {duplicates.length > 0 && (
            <div className="mb-6 rounded-xl border border-[#bb8a3a]/30 bg-[#bb8a3a]/[0.07] p-3.5">
              <p className="mb-2.5 text-xs text-[#8a6420]">
                Possible duplicate{duplicates.length === 1 ? "" : "s"} — fold into{" "}
                <span className="font-semibold">{app.company}</span>?
              </p>
              <ul className="space-y-1.5">
                {duplicates.map((d) => (
                  <li
                    key={d.id}
                    className="flex items-center justify-between gap-3 rounded-lg bg-paper px-3 py-2"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-ink">
                        {d.company}
                      </span>
                      {d.role && (
                        <span className="block truncate text-xs text-faint">
                          {d.role} · {STAGE_META[d.stage].short}
                        </span>
                      )}
                    </span>
                    <button
                      onClick={() => onMerge(d.id)}
                      className="shrink-0 rounded-full border border-line px-3 py-1 text-xs text-muted hover:border-line-strong"
                    >
                      Merge
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="eyebrow mb-3">
            {events.length} email{events.length === 1 ? "" : "s"}
          </p>
          <ol className="space-y-2">
            {events.map((evt) => {
              const m = STAGE_META[evt.stage];
              const open = openId === evt.id;
              return (
                <li key={evt.id} className="overflow-hidden rounded-xl border border-line">
                  <button
                    onClick={() => setOpenId(open ? null : evt.id)}
                    className="flex w-full items-start gap-3 bg-paper/60 p-3.5 text-left hover:bg-black/[0.02]"
                  >
                    <span className={`mt-0.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${m.color}`}>
                      {m.short}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-ink">
                        {evt.subject || "(no subject)"}
                      </span>
                      {evt.sender && (
                        <span className="block truncate text-xs text-faint">{evt.sender}</span>
                      )}
                    </span>
                    <span className="tnum whitespace-nowrap text-xs text-faint">
                      {fmtDate(evt.email_at)}
                    </span>
                  </button>
                  {open && (
                    <div className="border-t border-line bg-paper-raised p-4">
                      {evt.body ? (
                        <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-ink/80">
                          {evt.body}
                        </pre>
                      ) : (
                        <p className="text-sm text-muted">{evt.snippet || "No content available."}</p>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </div>
  );
}

function EmptyState({ onSync, syncing }: { onSync: () => void; syncing: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-line-strong bg-paper-raised py-24 text-center">
      <h3 className="text-xl font-semibold tracking-tight text-ink">
        Nothing tallied yet
      </h3>
      <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted">
        Sync your inbox and Tally will start counting confirmations, assessments,
        interviews, offers, and rejections.
      </p>
      <button
        onClick={onSync}
        disabled={syncing}
        className="mt-7 rounded-full bg-ink px-6 py-3 text-sm font-medium text-paper transition hover:bg-ink/90 disabled:opacity-50"
      >
        {syncing ? "Syncing…" : "Sync inbox"}
      </button>
    </div>
  );
}

function computeInsights(apps: Application[]) {
  const total = apps.length;
  const rank: Record<Stage, number> = {
    applied: 0,
    oa: 1,
    interview: 2,
    offer: 3,
    accepted: 3,
    declined: 3,
    rejected: 0,
  };
  const responded = apps.filter((a) => a.stage !== "applied").length;
  const interviewed = apps.filter(
    (a) => rank[a.stage] >= 2 && a.stage !== "rejected"
  ).length;
  const offers = apps.filter((a) => boardColumn(a.stage) === "offer").length;
  const pct = (n: number) => (total ? Math.round((n / total) * 100) : 0);

  const WEEKS = 10;
  const now = Date.now();
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const buckets = new Array(WEEKS).fill(0);
  for (const a of apps) {
    const t = new Date(a.first_email_at).getTime();
    const idx = Math.floor((now - t) / weekMs);
    if (idx >= 0 && idx < WEEKS) buckets[WEEKS - 1 - idx] += 1;
  }
  const weekly = buckets.map((count, i) => {
    const weeksAgo = WEEKS - 1 - i;
    const start = new Date(now - weeksAgo * weekMs);
    return {
      label: weeksAgo === 0 ? "now" : `${weeksAgo}w`,
      full:
        weeksAgo === 0
          ? "this week"
          : `week of ${start.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`,
      count,
    };
  });

  return {
    responseRate: pct(responded),
    interviewRate: pct(interviewed),
    offerRate: pct(offers),
    weekly,
    maxWeek: Math.max(1, ...buckets),
  };
}
