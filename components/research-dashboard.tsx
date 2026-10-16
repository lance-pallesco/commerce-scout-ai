"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  AlertCircle,
  ArrowUpRight,
  Bot,
  CircleDollarSign,
  Clock3,
  Download,
  FileSearch,
  FlaskConical,
  LoaderCircle,
  Play,
  Radar,
  ShieldCheck,
  Sparkles,
  Square,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { ResearchJob } from "@/lib/jobs/contracts";
import type { ProductCandidate, SourceDescriptor } from "@/lib/research/contracts";
import type { ProductEvaluation } from "@/lib/scoring/score-product";
import { cn } from "@/lib/utils";

import { Button } from "./ui/button";
import { Card } from "./ui/card";

type SourceResponse = {
  mode: "fixtures" | "live";
  liveAgentAvailable: boolean;
  sources: SourceDescriptor[];
};

type ReportResponse = {
  job: ResearchJob;
  report: { report: { mode: "deterministic_fixture" | "claude_agent"; limitations: string[] } };
  products: Array<{ product: ProductCandidate; evaluation: ProductEvaluation | null }>;
};

type FormState = {
  niche: "skincare" | "beauty" | "electronics";
  minimumPrice: string;
  maximumPrice: string;
  requestedProductCount: string;
  objective: string;
  sourceId: string;
};

const terminalStatuses = new Set(["completed", "partial", "failed", "cancelled"]);
const initialForm: FormState = {
  niche: "skincare",
  minimumPrice: "15",
  maximumPrice: "60",
  requestedProductCount: "5",
  objective: "Identify products worth further evidence-based investigation.",
  sourceId: "",
};

function formatDate(iso: string | null) {
  if (!iso) return "Not started";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

function statusClasses(status: ResearchJob["status"]) {
  return {
    pending: "bg-amber-50 text-amber-700 ring-amber-200",
    running: "bg-sky-50 text-sky-700 ring-sky-200",
    completed: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    partial: "bg-violet-50 text-violet-700 ring-violet-200",
    failed: "bg-rose-50 text-rose-700 ring-rose-200",
    cancelled: "bg-slate-100 text-slate-600 ring-slate-200",
  }[status];
}

async function asJson<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(body.error?.message ?? "The request could not be completed.");
  return body;
}

export function ResearchDashboard() {
  const [form, setForm] = useState<FormState>(initialForm);
  const [sources, setSources] = useState<SourceResponse>({
    mode: "fixtures",
    liveAgentAvailable: false,
    sources: [],
  });
  const [jobs, setJobs] = useState<ResearchJob[]>([]);
  const [selectedJob, setSelectedJob] = useState<ResearchJob | null>(null);
  const [report, setReport] = useState<ReportResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshSources = useCallback(async (niche: FormState["niche"]) => {
    const data = await asJson<SourceResponse>(
      await fetch(`/api/research-sources?niche=${encodeURIComponent(niche)}`),
    );
    setSources(data);
    setForm((current) => ({
      ...current,
      sourceId: data.sources.some((source) => source.id === current.sourceId)
        ? current.sourceId
        : (data.sources[0]?.id ?? ""),
    }));
  }, []);

  const refreshHistory = useCallback(async () => {
    const data = await asJson<{ jobs: ResearchJob[] }>(
      await fetch("/api/research-jobs", { cache: "no-store" }),
    );
    setJobs(data.jobs);
  }, []);

  const loadReport = useCallback(async (job: ResearchJob) => {
    if (!terminalStatuses.has(job.status) || ["failed", "cancelled"].includes(job.status)) {
      setReport(null);
      return;
    }
    const response = await fetch(`/api/research-jobs/${job.id}/report`, { cache: "no-store" });
    if (response.status === 409) {
      setReport(null);
      return;
    }
    setReport(await asJson<ReportResponse>(response));
  }, []);

  const refreshSelectedJob = useCallback(async () => {
    if (!selectedJob) return;
    const data = await asJson<{ job: ResearchJob }>(
      await fetch(`/api/research-jobs/${selectedJob.id}`, { cache: "no-store" }),
    );
    setSelectedJob(data.job);
    setJobs((current) => current.map((job) => (job.id === data.job.id ? data.job : job)));
    await loadReport(data.job);
  }, [loadReport, selectedJob]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void Promise.all([refreshSources(initialForm.niche), refreshHistory()]).catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Could not load research data."),
      );
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshHistory, refreshSources]);

  useEffect(() => {
    if (!selectedJob || terminalStatuses.has(selectedJob.status)) return;
    const timer = window.setInterval(() => void refreshSelectedJob().catch(() => undefined), 2_500);
    return () => window.clearInterval(timer);
  }, [refreshSelectedJob, selectedJob]);

  const chartData = useMemo(
    () =>
      (report?.products ?? []).map(({ product, evaluation }) => ({
        name: product.name.length > 20 ? `${product.name.slice(0, 20)}…` : product.name,
        score: evaluation?.score.total ?? 0,
      })),
    [report],
  );

  const updateForm = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const { job } = await asJson<{ job: ResearchJob }>(
        await fetch("/api/research-jobs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            niche: form.niche,
            minimumPrice: Number(form.minimumPrice),
            maximumPrice: Number(form.maximumPrice),
            requestedProductCount: Number(form.requestedProductCount),
            sourceIds: [form.sourceId],
            objective: form.objective,
          }),
        }),
      );
      setSelectedJob(job);
      setReport(null);
      await refreshHistory();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start research.");
    } finally {
      setSubmitting(false);
    }
  };

  const cancel = async () => {
    if (!selectedJob) return;
    try {
      const { job } = await asJson<{ job: ResearchJob }>(
        await fetch(`/api/research-jobs/${selectedJob.id}/cancel`, { method: "POST" }),
      );
      setSelectedJob(job);
      await refreshHistory();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not request cancellation.");
    }
  };

  const selectJob = async (job: ResearchJob) => {
    setSelectedJob(job);
    try {
      await loadReport(job);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load the selected report.");
    }
  };

  const running = selectedJob?.status === "running" || selectedJob?.status === "pending";

  return (
    <main className="min-h-screen bg-[#f7f8f7] text-slate-900">
      <header className="border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4 lg:px-8">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-xl bg-teal-700 text-white shadow-sm">
              <Radar className="size-5" aria-hidden="true" />
            </span>
            <div>
              <p className="text-sm font-bold tracking-tight">CommerceScout AI</p>
              <p className="text-xs text-slate-500">Autonomous e-commerce product research</p>
            </div>
          </div>
          <span className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ring-1", sources.mode === "fixtures" ? "bg-violet-50 text-violet-700 ring-violet-200" : "bg-teal-50 text-teal-700 ring-teal-200")}>
            {sources.mode === "fixtures" ? <FlaskConical className="size-3.5" /> : <Bot className="size-3.5" />}
            {sources.mode === "fixtures" ? "Fixture mode" : "Live mode"}
          </span>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-6 px-5 py-6 lg:grid-cols-[360px_minmax(0,1fr)] lg:px-8 lg:py-8">
        <aside className="space-y-5">
          <Card className="p-5">
            <div className="mb-5 flex items-start justify-between gap-4">
              <div><p className="text-sm font-bold">New research run</p><p className="mt-1 text-xs leading-5 text-slate-500">A worker persists the request, then collects only from the approved source.</p></div>
              <Sparkles className="size-5 shrink-0 text-teal-700" />
            </div>
            <form className="space-y-4" onSubmit={submit}>
              <Field label="Niche" htmlFor="niche"><select id="niche" value={form.niche} onChange={(event) => { const niche = event.target.value as FormState["niche"]; updateForm("niche", niche); void refreshSources(niche); }} className="field"><option value="skincare">Skincare</option><option value="beauty">Beauty</option><option value="electronics">Electronics</option></select></Field>
              <div className="grid grid-cols-2 gap-3"><Field label="Min price" htmlFor="minimumPrice"><input id="minimumPrice" className="field" inputMode="decimal" min="0" type="number" value={form.minimumPrice} onChange={(event) => updateForm("minimumPrice", event.target.value)} required /></Field><Field label="Max price" htmlFor="maximumPrice"><input id="maximumPrice" className="field" inputMode="decimal" min="1" type="number" value={form.maximumPrice} onChange={(event) => updateForm("maximumPrice", event.target.value)} required /></Field></div>
              <Field label="Product candidates" htmlFor="requestedProductCount"><input id="requestedProductCount" className="field" min="1" max="50" type="number" value={form.requestedProductCount} onChange={(event) => updateForm("requestedProductCount", event.target.value)} required /></Field>
              <Field label="Approved source" htmlFor="sourceId"><select id="sourceId" className="field" value={form.sourceId} onChange={(event) => updateForm("sourceId", event.target.value)} disabled={sources.sources.length === 0}>{sources.sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}</select><p className="mt-1.5 text-[11px] leading-4 text-slate-500">{sources.sources.find((source) => source.id === form.sourceId)?.sourceNotice}</p></Field>
              <Field label="Research objective" htmlFor="objective"><textarea id="objective" className="field min-h-24 resize-y" value={form.objective} onChange={(event) => updateForm("objective", event.target.value)} required /></Field>
              <Button className="w-full" type="submit" disabled={submitting || !form.sourceId}>{submitting ? <LoaderCircle className="size-4 animate-spin" /> : <Play className="size-4" />}{submitting ? "Queueing research…" : "Start research"}</Button>
            </form>
          </Card>
          <Card className="p-4"><div className="flex gap-3"><ShieldCheck className="mt-0.5 size-5 shrink-0 text-teal-700" /><p className="text-xs leading-5 text-slate-600">The runtime agent has no shell or arbitrary browser access. Sources, page limits, turns, cost, and cancellation are enforced on the server.</p></div></Card>
        </aside>

        <section className="min-w-0 space-y-6">
          {error && <div className="flex gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800"><AlertCircle className="mt-0.5 size-4 shrink-0" />{error}</div>}
          <StatusPanel job={selectedJob} running={Boolean(running)} onCancel={cancel} />
          {report ? <Results report={report} chartData={chartData} /> : <EmptyResults job={selectedJob} />}
          <History jobs={jobs} selectedId={selectedJob?.id} onSelect={selectJob} />
        </section>
      </div>
    </main>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return <label className="block" htmlFor={htmlFor}><span className="mb-1.5 block text-xs font-semibold text-slate-700">{label}</span>{children}</label>;
}

function StatusPanel({ job, running, onCancel }: { job: ResearchJob | null; running: boolean; onCancel: () => void }) {
  if (!job) return <Card className="grid min-h-52 place-items-center border-dashed p-8 text-center"><div><FileSearch className="mx-auto size-8 text-slate-300" /><p className="mt-3 font-semibold">Ready to inspect an opportunity</p><p className="mt-1 max-w-sm text-sm text-slate-500">Create a research job to track collection, analysis, scoring, and report delivery.</p></div></Card>;
  return <Card className="overflow-hidden"><div className="flex flex-col gap-5 p-5 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><p className="font-bold capitalize">{job.request.niche} opportunity research</p><span className={cn("rounded-full px-2.5 py-1 text-xs font-semibold capitalize ring-1", statusClasses(job.status))}>{job.status}</span></div><p className="mt-1.5 text-sm text-slate-500">{job.request.minimumPrice}–{job.request.maximumPrice} USD · {job.request.requestedProductCount} candidates · Started {formatDate(job.startedAt ?? job.createdAt)}</p></div><div className="flex shrink-0 gap-2">{running && <Button variant="destructive" onClick={onCancel}><Square className="size-3.5" />Cancel</Button>}{terminalStatuses.has(job.status) && !["failed", "cancelled"].includes(job.status) && <a className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-800 hover:bg-slate-50" href={`/api/research-jobs/${job.id}/export`}><Download className="size-4" />CSV</a>}</div></div><div className="border-t border-slate-100 bg-slate-50 px-5 py-4"><div className="flex items-center justify-between text-xs"><span className="flex items-center gap-2 font-semibold capitalize text-slate-700">{running && <LoaderCircle className="size-3.5 animate-spin text-teal-700" />}{job.currentStage}</span><span className="tabular-nums text-slate-500">{job.progressPercent}%</span></div><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200"><div className="h-full rounded-full bg-teal-700 transition-all" style={{ width: `${job.progressPercent}%` }} /></div>{job.sanitizedErrorMessage && <p className="mt-3 text-xs text-rose-700">{job.sanitizedErrorMessage}</p>}</div></Card>;
}

function EmptyResults({ job }: { job: ResearchJob | null }) {
  const text = job?.status === "failed" ? "Research did not complete" : job?.status === "cancelled" ? "Research was cancelled" : "Evidence-backed results will appear here";
  return <Card className="grid min-h-72 place-items-center p-8 text-center"><div><CircleDollarSign className="mx-auto size-8 text-slate-300" /><p className="mt-3 font-semibold">{text}</p><p className="mt-1 text-sm text-slate-500">{job?.status === "running" ? "The worker is collecting and evaluating source-backed product evidence." : "Scores and exports are available after persisted records are evaluated."}</p></div></Card>;
}

function Results({ report, chartData }: { report: ReportResponse; chartData: Array<{ name: string; score: number }> }) {
  const topScore = Math.max(...report.products.map(({ evaluation }) => evaluation?.score.total ?? 0), 0);
  return <><div className="grid gap-4 md:grid-cols-3"><Metric icon={<FileSearch />} label="Ranked products" value={report.products.length.toString()} detail="Persisted records" /><Metric icon={<Sparkles />} label="Top evidence score" value={`${topScore}/100`} detail="Deterministic criteria" /><Metric icon={<Clock3 />} label="Execution cost" value={`$${report.job.estimatedCostUsd.toFixed(3)}`} detail={`${report.job.elapsedTimeMs} ms recorded`} /></div><Card className="p-5"><div className="mb-4 flex items-center justify-between gap-3"><div><p className="font-bold">Evidence score comparison</p><p className="mt-1 text-xs text-slate-500">Scores reflect observed fields, category match, and selected price range—not sales potential.</p></div><span className="shrink-0 rounded-full bg-violet-50 px-2.5 py-1 text-xs font-semibold text-violet-700">{report.report.report.mode === "deterministic_fixture" ? "Synthetic fixture data" : "Claude-assisted"}</span></div><div className="h-60"><ResponsiveContainer width="100%" height="100%"><BarChart data={chartData} margin={{ left: -20 }}><CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" /><XAxis dataKey="name" tick={{ fontSize: 11, fill: "#64748b" }} interval={0} tickLine={false} axisLine={false} /><YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: "#64748b" }} tickLine={false} axisLine={false} /><Tooltip cursor={{ fill: "#f1f5f9" }} /><Bar dataKey="score" fill="#0f766e" radius={[5, 5, 0, 0]} /></BarChart></ResponsiveContainer></div></Card><Card className="overflow-hidden"><div className="border-b border-slate-100 px-5 py-4"><p className="font-bold">Product ranking</p><p className="mt-1 text-xs text-slate-500">Source links and evidence gaps are retained for review.</p></div><div className="divide-y divide-slate-100">{report.products.map(({ product, evaluation }, index) => <article className="grid gap-4 p-5 sm:grid-cols-[2.5rem_minmax(0,1fr)_auto] sm:items-center" key={product.id}><span className="grid size-9 place-items-center rounded-lg bg-slate-100 text-sm font-bold text-slate-600">{index + 1}</span><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><p className="font-semibold">{product.name}</p>{product.price !== null && <span className="text-sm text-slate-500">${product.price.toFixed(2)}</span>}</div><p className="mt-1 text-sm leading-5 text-slate-500">{product.description ?? "No source description available."}</p><div className="mt-2 flex flex-wrap gap-2 text-xs"><a className="inline-flex items-center gap-1 font-semibold text-teal-700 hover:text-teal-900" href={product.sourceUrl} target="_blank" rel="noreferrer">Source <ArrowUpRight className="size-3" /></a>{product.missingFields.map((field) => <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-700" key={field}>Missing {field}</span>)}</div></div><div className="text-left sm:text-right"><p className="text-2xl font-bold tabular-nums text-teal-800">{evaluation?.score.total ?? "—"}</p><p className="text-xs font-medium text-slate-500">evidence score</p></div></article>)}</div></Card>{report.report.report.limitations.length > 0 && <Card className="border-amber-200 bg-amber-50 p-4"><p className="text-sm font-bold text-amber-900">Research limitations</p><ul className="mt-2 space-y-1 text-sm leading-5 text-amber-800">{report.report.report.limitations.map((limitation) => <li key={limitation}>• {limitation}</li>)}</ul></Card>}</>;
}

function Metric({ icon, label, value, detail }: { icon: ReactNode; label: string; value: string; detail: string }) {
  return <Card className="p-4"><div className="flex items-start justify-between"><span className="text-slate-400">{icon}</span><span className="text-xs text-slate-500">{detail}</span></div><p className="mt-5 text-2xl font-bold tabular-nums">{value}</p><p className="mt-1 text-xs font-medium text-slate-500">{label}</p></Card>;
}

function History({ jobs, selectedId, onSelect }: { jobs: ResearchJob[]; selectedId?: string; onSelect: (job: ResearchJob) => void }) {
  return <Card className="overflow-hidden"><div className="flex items-center justify-between border-b border-slate-100 px-5 py-4"><div><p className="font-bold">Research history</p><p className="mt-1 text-xs text-slate-500">Every run retains status, timestamps, and sanitized events.</p></div><span className="text-xs font-semibold text-slate-500">{jobs.length} total</span></div>{jobs.length === 0 ? <p className="p-5 text-sm text-slate-500">No research jobs have been created.</p> : <div className="divide-y divide-slate-100">{jobs.map((job) => <button className={cn("flex w-full items-center justify-between gap-4 p-4 text-left transition-colors hover:bg-slate-50", selectedId === job.id && "bg-teal-50/50")} key={job.id} onClick={() => void onSelect(job)}><div className="min-w-0"><p className="truncate text-sm font-semibold capitalize">{job.request.niche} · {job.request.minimumPrice}–{job.request.maximumPrice} USD</p><p className="mt-1 text-xs text-slate-500">{formatDate(job.createdAt)} · {job.request.sourceIds[0]}</p></div><span className={cn("shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold capitalize ring-1", statusClasses(job.status))}>{job.status}</span></button>)}</div>}</Card>;
}
