"use client";

import { useState } from "react";
import type {
  SocialContent,
  AiAnalysisResult,
  OcrComparisonResult,
  PipelineStep,
} from "@/lib/types/social";

// ─── Helpers ───────────────────────────────────────────────────────────────────
const fmt = (n: number | null | undefined) =>
  n != null ? n.toLocaleString() : "—";

type BadgeVariant = "default" | "accent" | "success" | "warn" | "destructive";

const Badge = ({
  label,
  variant = "default",
}: {
  label: string;
  variant?: BadgeVariant;
}) => {
  const styles: Record<BadgeVariant, string> = {
    default:     "bg-zinc-800 text-zinc-300 border-zinc-700",
    accent:      "bg-indigo-500/15 text-indigo-400 border-indigo-500/30",
    success:     "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    warn:        "bg-amber-500/15 text-amber-400 border-amber-500/30",
    destructive: "bg-red-500/15 text-red-400 border-red-500/30",
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium border ${styles[variant]}`}
    >
      {label}
    </span>
  );
};

const ConfBar = ({ v }: { v: number }) => (
  <div className="flex items-center gap-2">
    <div className="flex-1 bg-zinc-800 rounded-full h-1">
      <div
        className="h-1 rounded-full bg-indigo-500"
        style={{ width: `${Math.round(v * 100)}%` }}
      />
    </div>
    <span className="text-[11px] text-zinc-500 w-7 text-right tabular-nums">
      {Math.round(v * 100)}%
    </span>
  </div>
);

// ─── Card ──────────────────────────────────────────────────────────────────────
function Card({
  title,
  icon,
  right,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          {icon && <span className="shrink-0 text-zinc-500">{icon}</span>}
          <h3 className="text-sm font-medium text-zinc-200 truncate">{title}</h3>
        </div>
        {right && <div className="shrink-0">{right}</div>}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

// ─── Stat Cell ─────────────────────────────────────────────────────────────────
const StatCell = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div className="bg-zinc-800 rounded-md p-3 text-center">
    <p className="text-base font-semibold text-zinc-100 tabular-nums">{value}</p>
    <p className="text-[10px] text-zinc-500 uppercase tracking-wider mt-0.5">{label}</p>
  </div>
);

// ─── Tag Pill ──────────────────────────────────────────────────────────────────
const Pill = ({ children }: { children: React.ReactNode }) => (
  <span className="px-2 py-0.5 bg-zinc-800 text-zinc-300 text-xs rounded-md border border-zinc-700">
    {children}
  </span>
);

// ─── Row Item ─────────────────────────────────────────────────────────────────
const Row = ({ children }: { children: React.ReactNode }) => (
  <div className="flex items-center justify-between bg-zinc-800/60 rounded-md px-3 py-2.5 border border-zinc-700/50">
    {children}
  </div>
);

// ─── Pipeline Steps ────────────────────────────────────────────────────────────
function PipelineSteps({ steps }: { steps: PipelineStep[] }) {
  return (
    <div className="space-y-1">
      {steps.map((s) => (
        <div
          key={s.step}
          className={`flex items-center justify-between px-3 py-2 rounded-md border-l-2 text-xs ${
            s.status === "success"
              ? "border-emerald-500 bg-emerald-500/5"
              : s.status === "error"
              ? "border-red-500 bg-red-500/5"
              : "border-zinc-700 bg-zinc-800/30 opacity-60"
          }`}
        >
          <div className="flex items-center gap-2.5">
            <span className="font-mono text-zinc-600 w-4 shrink-0">
              {s.status === "success" ? "✓" : s.status === "error" ? "✗" : "−"}
            </span>
            <span className={s.status === "skipped" ? "text-zinc-600" : "text-zinc-300"}>
              <span className="font-mono text-zinc-600 mr-1">{s.step}.</span>
              {s.name}
            </span>
          </div>
          <div className="flex items-center gap-3 text-zinc-600 shrink-0">
            {s.details && (
              <span className="max-w-[180px] truncate hidden sm:inline">{s.details}</span>
            )}
            {s.durationMs > 0 && (
              <span className="tabular-nums">{s.durationMs}ms</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── OCR Comparison ────────────────────────────────────────────────────────────
function OcrComparisonDemo({ ocr }: { ocr: OcrComparisonResult }) {
  const [activeTab, setActiveTab] = useState<"apify" | "gpt">("gpt");
  const [frameView, setFrameView] = useState<"list" | "frames">("list");

  const apify = ocr.apifyOcr;
  const gpt = ocr.gptVision;

  return (
    <div className="space-y-5">
      {/* Tab bar */}
      <div className="flex items-end justify-between border-b border-zinc-800">
        <div className="flex gap-0">
          {(["gpt", "apify"] as const).map((id) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
                activeTab === id
                  ? "text-zinc-100 border-indigo-500"
                  : "text-zinc-500 border-transparent hover:text-zinc-300"
              }`}
            >
              {id === "gpt" ? "GPT-4o Vision" : "Apify OCR (Tesseract)"}
            </button>
          ))}
        </div>
        <button
          onClick={() => setFrameView(frameView === "list" ? "frames" : "list")}
          className="text-xs text-zinc-500 hover:text-zinc-300 px-3 py-1.5 mb-1 rounded-md hover:bg-zinc-800 transition-colors"
        >
          {frameView === "list" ? "Per-Frame View" : "Summary View"}
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4">
        <div
          className={`rounded-lg p-4 border transition-colors bg-zinc-800/30 ${
            activeTab === "gpt" ? "border-indigo-500/40" : "border-zinc-800 opacity-50"
          }`}
        >
          <div className="flex items-center gap-2 mb-3">
            <div className="w-1.5 h-1.5 rounded-full bg-indigo-400 shrink-0" />
            <span className="text-xs font-semibold text-zinc-300">GPT-4o Vision</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {[
              { label: "Texts",     value: gpt.allTexts.length },
              { label: "Brands",    value: gpt.allBrands.length },
              { label: "Locations", value: gpt.allLocations.length },
              { label: "Prices",    value: gpt.allPrices.length },
            ].map(({ label, value }) => (
              <StatCell key={label} label={label} value={value} />
            ))}
          </div>
          <p className="text-[10px] text-zinc-600 mt-3 text-center tabular-nums">
            {gpt.totalFramesProcessed} frames · {gpt.processingTimeMs}ms
          </p>
        </div>

        <div
          className={`rounded-lg p-4 border transition-colors bg-zinc-800/30 ${
            activeTab === "apify" ? "border-zinc-500/50" : "border-zinc-800 opacity-50"
          }`}
        >
          <div className="flex items-center gap-2 mb-3">
            <div className="w-1.5 h-1.5 rounded-full bg-zinc-500 shrink-0" />
            <span className="text-xs font-semibold text-zinc-300">Apify Tesseract OCR</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {[
              { label: "Texts",     value: apify.allTexts.length },
              { label: "Brands",    value: "—" },
              { label: "Locations", value: "—" },
              { label: "Prices",    value: "—" },
            ].map(({ label, value }) => (
              <StatCell key={label} label={label} value={value} />
            ))}
          </div>
          <p className="text-[10px] text-zinc-600 mt-3 text-center tabular-nums">
            {apify.totalFramesProcessed} frames · {apify.processingTimeMs}ms
          </p>
        </div>
      </div>



      {/* Content display */}
      {frameView === "list" ? (
        <div className="space-y-4">
          {activeTab === "gpt" ? (
            <>
              {gpt.allTexts.length > 0 && (
                <div>
                  <p className="text-[11px] text-zinc-500 uppercase tracking-wider mb-2">Visible Texts</p>
                  <div className="flex flex-wrap gap-1.5">
                    {gpt.allTexts.map((t, i) => <Pill key={i}>{t}</Pill>)}
                  </div>
                </div>
              )}
              {gpt.allBrands.length > 0 && (
                <div>
                  <p className="text-[11px] text-zinc-500 uppercase tracking-wider mb-2">Brands</p>
                  <div className="flex flex-wrap gap-1.5">
                    {gpt.allBrands.map((b, i) => <Pill key={i}>{b}</Pill>)}
                  </div>
                </div>
              )}
              {gpt.allLocations.length > 0 && (
                <div>
                  <p className="text-[11px] text-zinc-500 uppercase tracking-wider mb-2">Locations</p>
                  <div className="flex flex-wrap gap-1.5">
                    {gpt.allLocations.map((l, i) => <Pill key={i}>{l}</Pill>)}
                  </div>
                </div>
              )}
              {gpt.allPrices.length > 0 && (
                <div>
                  <p className="text-[11px] text-zinc-500 uppercase tracking-wider mb-2">Prices / Offers</p>
                  <div className="flex flex-wrap gap-1.5">
                    {gpt.allPrices.map((p, i) => <Pill key={i}>{p}</Pill>)}
                  </div>
                </div>
              )}
              {gpt.allTexts.length === 0 && gpt.allBrands.length === 0 && (
                <p className="text-zinc-600 text-sm text-center py-4">No text detected in video frames.</p>
              )}
            </>
          ) : (
            <>
              {apify.allTexts.length > 0 ? (
                <div>
                  <p className="text-[11px] text-zinc-500 uppercase tracking-wider mb-2">Extracted Texts (Raw)</p>
                  <div className="flex flex-wrap gap-1.5">
                    {apify.allTexts.map((t, i) => <Pill key={i}>{t}</Pill>)}
                  </div>
                </div>
              ) : (
                <p className="text-zinc-600 text-sm text-center py-4">
                  No text extracted. Tesseract struggles with stylized social-media fonts.
                </p>
              )}
            </>
          )}
        </div>
      ) : (
        /* Per-frame view */
        <div className="space-y-2">
          {(activeTab === "gpt" ? gpt.frames : apify.frames).map((frame: any) => (
            <div
              key={frame.frameIndex}
              className="bg-zinc-800/40 rounded-md p-3 border border-zinc-700/50"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-mono text-zinc-500">
                  Frame {frame.frameIndex} · {frame.timestamp.toFixed(1)}s
                </span>
                {activeTab === "gpt" && (
                  <span className="text-[11px] text-zinc-400 tabular-nums">
                    {Math.round(frame.confidence * 100)}% conf
                  </span>
                )}
              </div>
              {activeTab === "gpt" ? (
                <div className="space-y-1.5">
                  {frame.description && (
                    <p className="text-xs text-zinc-500 italic">{frame.description}</p>
                  )}
                  <div className="flex flex-wrap gap-1">
                    {frame.texts?.map((t: string, i: number) => (
                      <span key={i} className="text-[11px] bg-zinc-700 text-zinc-300 px-1.5 py-0.5 rounded">{t}</span>
                    ))}
                    {frame.brands?.map((b: string, i: number) => (
                      <span key={`b${i}`} className="text-[11px] bg-zinc-700 text-zinc-300 px-1.5 py-0.5 rounded">{b}</span>
                    ))}
                    {frame.texts?.length === 0 && frame.brands?.length === 0 && (
                      <span className="text-xs text-zinc-600">No text in this frame</span>
                    )}
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {frame.texts?.map((t: string, i: number) => (
                    <span key={i} className="text-[11px] bg-zinc-700 text-zinc-300 px-1.5 py-0.5 rounded">{t}</span>
                  ))}
                  {frame.texts?.length === 0 && (
                    <span className="text-xs text-zinc-600">Nothing detected</span>
                  )}
                </div>
              )}
            </div>
          ))}
          {(activeTab === "gpt" ? gpt.frames : apify.frames).length === 0 && (
            <p className="text-zinc-600 text-sm text-center py-4">No frame data available.</p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Icons ─────────────────────────────────────────────────────────────────────
const IconLink      = () => <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.1-1.1m-.757-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg>;
const IconBolt      = () => <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>;
const IconBrain     = () => <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>;
const IconMapPin    = () => <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" /></svg>;
const IconMega      = () => <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z" /></svg>;
const IconMic       = () => <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>;
const IconUsers     = () => <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /></svg>;
const IconEye       = () => <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>;
const IconTag       = () => <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z" /></svg>;
const IconHash      = () => <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14" /></svg>;
const IconTarget    = () => <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><circle cx="12" cy="12" r="3" /><path strokeLinecap="round" strokeLinejoin="round" d="M12 2v3m0 14v3M2 12h3m14 0h3" /></svg>;
const IconStar      = () => <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" /></svg>;
const IconChart     = () => <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>;
const IconClipboard = () => <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>;
const IconCode      = () => <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" /></svg>;
const IconSearch    = () => <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>;
const IconArrow     = () => <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M14 5l7 7m0 0l-7 7m7-7H3" /></svg>;
const IconSpinner   = () => <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" /></svg>;
const IconChevron   = ({ up }: { up?: boolean }) => <svg className={`w-4 h-4 transition-transform ${up ? "" : "rotate-180"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>;

// ─── Main Page ─────────────────────────────────────────────────────────────────
export default function Page() {
  const [url, setUrl] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<string>("summary");
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});

  const [scrapedData, setScrapedData]       = useState<SocialContent | null>(null);
  const [rawApifyData, setRawApifyData]     = useState<any>(null);
  const [aiAnalysis, setAiAnalysis]         = useState<AiAnalysisResult | null>(null);
  const [ocrComparison, setOcrComparison]   = useState<OcrComparisonResult | null>(null);
  const [transcript, setTranscript]         = useState<string>("");
  const [place, setPlace]                   = useState<any>(null);
  const [pipelineSteps, setPipelineSteps]   = useState<PipelineStep[]>([]);
  const [socialPostId, setSocialPostId]     = useState<string | null>(null);

  // Audio Upload States
  const [isUploadingAudio, setIsUploadingAudio] = useState(false);
  const [audioError, setAudioError]             = useState<string | null>(null);
  const [uploadedAudio, setUploadedAudio]       = useState<{
    id: string;
    fileName: string;
    publicUrl: string;
    sizeBytes: number;
    mimeType: string;
  } | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url) return;
    setIsLoading(true);
    setError(null);
    setScrapedData(null);
    setRawApifyData(null);
    setAiAnalysis(null);
    setOcrComparison(null);
    setTranscript("");
    setPlace(null);
    setPipelineSteps([]);
    setSocialPostId(null);
    setUploadedAudio(null);
    setAudioError(null);

    // Helpers to manage pipeline step UI state
    const addOrUpdateStep = (stepNum: number, name: string, status: 'success' | 'error' | 'skipped' | 'pending', durationMs: number, details = '') => {
      setPipelineSteps(prev => {
        const existing = prev.find(s => s.step === stepNum);
        if (existing) {
          return prev.map(s => s.step === stepNum ? { ...s, status, durationMs, details } : s);
        }
        return [...prev, { step: stepNum, name, status, durationMs, details }].sort((a, b) => a.step - b.step);
      });
    };

    let start = Date.now();
    let contentData: any = null;
    let rawApifyDataObj: any = null;
    let whisperTranscript = '';
    let ocrResultsList: any[] = [];
    let audioUploadObj: any = null;

    try {
      // ── STEP 1: Initiate Apify Scrape ──
      addOrUpdateStep(1, 'Apify Scrape (Initiating)', 'pending', 0, 'Starting run...');
      const initiateStart = Date.now();
      const initRes = await fetch("/api/process-url/scrape/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const initData = await initRes.json();
      if (!initRes.ok || !initData.success) {
        throw new Error(initData.error || "Failed to initiate scrape.");
      }
      const { runId, actorId } = initData;
      addOrUpdateStep(1, `Apify Scrape (Actor running)`, 'pending', Date.now() - initiateStart, `Apify Run ID: ${runId.slice(0, 8)}...`);

      // Poll scrape status
      let pollCount = 0;
      while (true) {
        pollCount++;
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        const statusRes = await fetch(`/api/process-url/scrape/status?runId=${runId}&actorId=${actorId}`);
        const statusData = await statusRes.json();
        
        if (!statusRes.ok || !statusData.success) {
          throw new Error(statusData.error || "Failed to poll status.");
        }

        const apifyStatus = statusData.status;
        console.log(`[Client Scraper] Poll ${pollCount}: ${apifyStatus}`);
        
        if (apifyStatus === 'SUCCEEDED') {
          contentData = statusData.data;
          rawApifyDataObj = statusData.raw;
          setScrapedData(contentData);
          setRawApifyData(rawApifyDataObj);
          addOrUpdateStep(1, 'Apify Scrape', 'success', Date.now() - start, `Succeeded after ${pollCount} polls`);
          break;
        } else if (apifyStatus === 'FAILED' || apifyStatus === 'ABORTED' || apifyStatus === 'TIMED-OUT') {
          throw new Error(`Apify scraping run ended with status: ${apifyStatus}`);
        } else {
          // Still running
          addOrUpdateStep(1, 'Apify Scrape (Polling)', 'pending', Date.now() - start, `Status: ${apifyStatus} (Poll #${pollCount})`);
        }
      }

      if (!contentData) {
        throw new Error("No content returned from scraper.");
      }

      const isVideo = !!contentData.videoUrl && (contentData.contentType === 'video' || contentData.contentType === 'reel');

      // ── STEP 2 & 3: Transcribe and OCR in Parallel ──
      const mediaProcessingStart = Date.now();

      // Define transcription task
      const transcriptionPromise = (async () => {
        const transcribeStart = Date.now();
        if (isVideo) {
          addOrUpdateStep(2, 'Whisper Transcription', 'pending', 0, 'Downloading media and transcribing...');
          try {
            const transcribeRes = await fetch("/api/process-url/transcribe", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ videoUrl: contentData.videoUrl }),
            });
            const transcribeData = await transcribeRes.json();
            
            if (transcribeRes.ok && transcribeData.success) {
              whisperTranscript = transcribeData.transcript;
              audioUploadObj = transcribeData.audioUpload;
              setTranscript(whisperTranscript);
              if (audioUploadObj) setUploadedAudio(audioUploadObj);
              addOrUpdateStep(2, 'Whisper Transcription', 'success', Date.now() - transcribeStart, 'Completed successfully');
            } else {
              throw new Error(transcribeData.error || 'Unknown transcription error');
            }
          } catch (err: any) {
            console.warn('[Client Transcription] Failed, proceeding without transcript:', err.message);
            addOrUpdateStep(2, 'Whisper Transcription', 'skipped', Date.now() - transcribeStart, `Failed: ${err.message}`);
          }
        } else {
          addOrUpdateStep(2, 'Whisper Transcription', 'skipped', 0, 'Image post - skipped');
        }
      })();

      // Define OCR task
      const ocrPromise = (async () => {
        const ocrStart = Date.now();
        if (isVideo) {
          addOrUpdateStep(3, 'Frame OCR (Extract & Tesseract)', 'pending', 0, 'Starting frame extraction and OCR...');
          // Capture 1 frame per second of the video, capped at a maximum of 30 frames
          const duration = contentData.videoDuration || 15;
          const numFrames = Math.min(30, Math.round(duration));
          const timestamps: { index: number; timestamp: number }[] = [];
          const interval = duration / numFrames;
          for (let i = 0; i < numFrames; i++) {
            const ts = i * interval;
            if (ts < duration) {
              timestamps.push({ index: i, timestamp: ts });
            }
          }

          addOrUpdateStep(3, `Frame OCR (Processing ${timestamps.length} frames)`, 'pending', 0, 'Extracting and processing frames in parallel...');

          // Fire single ocr frame calls in parallel
          const ocrPromises = timestamps.map(async (item) => {
            try {
              const res = await fetch("/api/process-url/ocr-frame", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  videoUrl: contentData.videoUrl,
                  frameIndex: item.index,
                  timestamp: item.timestamp,
                  isVideo: true
                }),
              });
              const resData = await res.json();
              if (res.ok && resData.success && resData.ocrFrameResult) {
                return resData.ocrFrameResult;
              }
            } catch (e) {
              console.error(`Frame OCR error for index ${item.index}:`, e);
            }
            return null;
          });

          const ocrResultsRaw = await Promise.all(ocrPromises);
          ocrResultsList = ocrResultsRaw.filter(Boolean);
          addOrUpdateStep(3, 'Frame OCR', 'success', Date.now() - ocrStart, `Processed ${ocrResultsList.length}/${timestamps.length} frames`);
        } else {
          // Image carousel OCR
          const imageUrls = (contentData.images && contentData.images.length > 0)
            ? contentData.images
            : [contentData.displayUrl || contentData.videoUrl].filter(Boolean) as string[];

          if (imageUrls.length > 0) {
            addOrUpdateStep(3, `Image OCR (Processing ${imageUrls.length} images)`, 'pending', 0, 'Running OCR on images...');
            
            const ocrPromises = imageUrls.map(async (imageUrl: string, index: number) => {
              try {
                const res = await fetch("/api/process-url/ocr-frame", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    imageUrl,
                    frameIndex: index,
                    isVideo: false
                  }),
                });
                const resData = await res.json();
                if (res.ok && resData.success && resData.ocrFrameResult) {
                  return resData.ocrFrameResult;
                }
              } catch (e) {
                console.error(`Image OCR error for index ${index}:`, e);
              }
              return null;
            });

            const ocrResultsRaw = await Promise.all(ocrPromises);
            ocrResultsList = ocrResultsRaw.filter(Boolean);
            addOrUpdateStep(3, 'Image OCR', 'success', Date.now() - ocrStart, `Processed ${ocrResultsList.length}/${imageUrls.length} images`);
          } else {
            addOrUpdateStep(3, 'Frame OCR', 'skipped', 0, 'No media to OCR - skipped');
          }
        }
      })();

      // Run Whisper and OCR concurrently!
      await Promise.all([transcriptionPromise, ocrPromise]);

      // ── STEP 4: AI Analysis & Save ──
      const analyzeStart = Date.now();
      addOrUpdateStep(4, 'AI Analysis & Save', 'pending', 0, 'Running GPT-4o analysis and place extraction...');
      
      const analyzeRes = await fetch("/api/process-url/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: contentData,
          rawApifyData: rawApifyDataObj,
          transcript: whisperTranscript,
          apifyOcrFrames: ocrResultsList,
          url,
          audioUploadId: audioUploadObj?.id
        }),
      });

      const analyzeData = await analyzeRes.json();
      if (!analyzeRes.ok || !analyzeData.success) {
        throw new Error(analyzeData.error || "Failed to complete AI analysis and database saves.");
      }

      // Populate states with returned data
      if (analyzeData.aiAnalysis)    setAiAnalysis(analyzeData.aiAnalysis);
      if (analyzeData.ocrComparison) setOcrComparison(analyzeData.ocrComparison);
      if (analyzeData.place)         setPlace(analyzeData.place);
      if (analyzeData.socialPostId)  setSocialPostId(analyzeData.socialPostId);
      if (analyzeData.audioUpload)   setUploadedAudio(analyzeData.audioUpload);

      addOrUpdateStep(4, 'AI Analysis & Save', 'success', Date.now() - analyzeStart, 'Enrichment complete and results stored in database');

    } catch (err: any) {
      console.error('[Pipeline Orchestration] Error:', err);
      setError(err.message || "Failed to complete the pipeline.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleAudioUpload = async (file: File) => {
    if (!file) return;
    setIsUploadingAudio(true);
    setAudioError(null);
    setUploadedAudio(null);

    const formData = new FormData();
    formData.append("file", file);
    if (socialPostId) {
      formData.append("socialPostId", socialPostId);
    }

    try {
      const response = await fetch("/api/upload-audio", {
        method: "POST",
        body: formData,
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to upload audio file.");
      }
      setUploadedAudio(data);
    } catch (err: any) {
      setAudioError(err.message || "An upload error occurred.");
    } finally {
      setIsUploadingAudio(false);
    }
  };



  const toggleSection = (id: string) =>
    setCollapsedSections((prev) => ({ ...prev, [id]: !prev[id] }));

  const hasResults = !!(scrapedData || aiAnalysis || ocrComparison || place);

  const navSections = [
    { id: "summary", label: "Summary" },
    { id: "ocr",     label: "OCR" },
  ];

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-200 selection:bg-indigo-500/30">
      <div className="max-w-5xl mx-auto px-4 md:px-6 py-10 space-y-8">

        {/* ── Header ── */}
        <div className="space-y-6">
          <div className="space-y-1">
            <div className="inline-flex items-center gap-1.5 text-xs text-zinc-500 mb-2">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              Come With Me · Intelligence Engine
            </div>
            <h1 className="text-2xl font-semibold text-zinc-100 tracking-tight">
              Social Media Intelligence Scraper
            </h1>
            <p className="text-sm text-zinc-500">
              Paste an Instagram Reel or TikTok link to extract metadata, transcribe audio,
              run OCR on video frames, and generate a full AI intelligence report.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-zinc-600">
                <IconLink />
              </div>
              <input
                type="url"
                placeholder="https://www.instagram.com/p/... or https://www.tiktok.com/@..."
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/50 transition-colors"
                required
              />
            </div>
            <button
              type="submit"
              disabled={isLoading}
              className="flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium px-5 py-2.5 rounded-lg transition-colors min-w-[120px]"
            >
              {isLoading ? (
                <>
                  <IconSpinner />
                  Processing…
                </>
              ) : (
                <>
                  Analyze
                  <IconArrow />
                </>
              )}
            </button>
          </form>
          {isLoading && pipelineSteps.length > 0 && (
            <div className="border border-zinc-800 rounded-lg p-4 bg-zinc-900/50 mt-4">
              <p className="text-xs text-zinc-500 uppercase tracking-wider mb-3">Pipeline</p>
              <PipelineSteps steps={pipelineSteps} />
            </div>
          )}
        </div>

        {/* ── Error ── */}
        {error && (
          <div className="bg-red-950/40 border border-red-900/50 rounded-lg p-4 flex items-start gap-3">
            <svg className="w-4 h-4 text-red-500 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <div>
              <p className="text-sm font-medium text-red-400">Pipeline Error</p>
              <p className="text-xs text-red-500/80 mt-0.5">{error}</p>
              <p className="text-xs text-zinc-600 mt-1">Partial data below may still be available.</p>
            </div>
          </div>
        )}

        {/* ── Results ── */}
        {hasResults && (
          <>
            {/* Section Nav */}
            <div className="sticky top-4 z-40 bg-zinc-950/90 backdrop-blur border-b border-zinc-800">
              <div className="flex gap-0 overflow-x-auto scrollbar-none">
                {navSections.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => {
                      setActiveSection(s.id);
                      document
                        .getElementById(`sec-${s.id}`)
                        ?.scrollIntoView({ behavior: "smooth", block: "start" });
                    }}
                    className={`px-4 py-3 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
                      activeSection === s.id
                        ? "text-zinc-100 border-indigo-500"
                        : "text-zinc-500 border-transparent hover:text-zinc-300"
                    }`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            {/* ── SUMMARY ── */}
            <div id="sec-summary" className="space-y-4 scroll-mt-16">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">
                  Summary &amp; Metrics
                </p>
                <button
                  onClick={() => toggleSection("summary")}
                  className="text-xs text-zinc-500 hover:text-zinc-300 flex items-center gap-1 transition-colors"
                >
                  <IconChevron up={!collapsedSections.summary} />
                </button>
              </div>

              {!collapsedSections.summary && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  {/* Social Metadata */}
                  {scrapedData && (
                    <Card
                      title="Social Metadata"
                      icon={<IconBolt />}
                      right={<Badge label={scrapedData.platform.toUpperCase()} variant="accent" />}
                    >
                      <div className="space-y-3">
                        {scrapedData.images && scrapedData.images.length > 0 && (
                          <div className="space-y-1.5">
                            <p className="text-[11px] text-zinc-500 font-medium">Post Images ({scrapedData.images.length})</p>
                            <div className="flex gap-2.5 overflow-x-auto pb-2 pt-0.5 scrollbar-thin scrollbar-thumb-zinc-800 scrollbar-track-transparent snap-x snap-mandatory">
                              {scrapedData.images.map((imgUrl, idx) => (
                                <div key={idx} className="shrink-0 snap-start w-48 h-48 relative rounded-md overflow-hidden bg-zinc-900 border border-zinc-800 group">
                                  <img
                                    src={imgUrl}
                                    alt={`Post Image ${idx + 1}`}
                                    className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                                    loading="lazy"
                                    referrerPolicy="no-referrer"
                                  />
                                  <div className="absolute bottom-2 right-2 bg-black/70 backdrop-blur-xs text-[10px] text-zinc-300 px-1.5 py-0.5 rounded font-mono">
                                    {idx + 1}/{scrapedData.images?.length}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {!scrapedData.videoUrl && scrapedData.displayUrl && (!scrapedData.images || scrapedData.images.length === 0) && (
                          <div className="space-y-1.5">
                            <p className="text-[11px] text-zinc-500 font-medium">Post Image</p>
                            <div className="w-48 h-48 relative rounded-md overflow-hidden bg-zinc-900 border border-zinc-800">
                              <img
                                src={scrapedData.displayUrl}
                                alt="Post Cover"
                                className="w-full h-full object-cover"
                                loading="lazy"
                                referrerPolicy="no-referrer"
                              />
                            </div>
                          </div>
                        )}
                        {scrapedData.videoUrl && (
                          <div className="bg-zinc-800/60 rounded-md px-3 py-2.5 flex items-center gap-3">
                            <svg className="w-4 h-4 text-zinc-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" /></svg>
                            <div className="flex-1">
                              <p className="text-[11px] text-zinc-500 mb-1">Audio Track</p>
                              <audio
                                src={scrapedData.videoUrl}
                                controls
                                className="w-full h-8 bg-zinc-900 rounded-md"
                              />
                            </div>
                          </div>
                        )}
                        <div className="bg-zinc-800/60 rounded-md px-3 py-2.5">
                          <p className="text-[11px] text-zinc-500 mb-0.5">Creator</p>
                          <p className="font-medium text-zinc-100 text-sm">@{scrapedData.authorUsername}</p>
                          {scrapedData.authorFullName && (
                            <p className="text-xs text-zinc-500 mt-0.5">{scrapedData.authorFullName}</p>
                          )}
                        </div>
                        <div className="grid grid-cols-3 gap-2">
                          {[
                            { label: "Views",    value: scrapedData.metrics.views },
                            { label: "Likes",    value: scrapedData.metrics.likes },
                            { label: "Comments", value: scrapedData.metrics.comments },
                            { label: "Shares",   value: scrapedData.metrics.shares },
                            { label: "Saves",    value: scrapedData.metrics.saves },
                            { label: "Plays",    value: scrapedData.metrics.plays },
                          ].map(({ label, value }) => (
                            <StatCell key={label} label={label} value={fmt(value)} />
                          ))}
                        </div>
                        {(scrapedData.videoDuration || scrapedData.dimensions) && (
                          <div className="flex gap-2 flex-wrap">
                            {scrapedData.videoDuration && <Badge label={`${scrapedData.videoDuration}s`} />}
                            {scrapedData.dimensions && (
                              <Badge label={`${scrapedData.dimensions.width}×${scrapedData.dimensions.height}`} />
                            )}
                            {scrapedData.paidPartnership && <Badge label="Paid Partnership" variant="warn" />}
                            {scrapedData.productType && <Badge label={scrapedData.productType} />}
                          </div>
                        )}
                        {scrapedData.musicInfo && (
                          <div className="bg-zinc-800/60 rounded-md px-3 py-2.5 flex items-center gap-3">
                            <svg className="w-4 h-4 text-zinc-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2z" /></svg>
                            <div className="min-w-0">
                              <p className="text-xs font-medium text-zinc-200 truncate">{scrapedData.musicInfo.song_name}</p>
                              <p className="text-[11px] text-zinc-500">{scrapedData.musicInfo.artist_name}</p>
                            </div>
                            {scrapedData.musicInfo.uses_original_audio && (
                              <Badge label="Original" variant="success" />
                            )}
                          </div>
                        )}
                      </div>
                    </Card>
                  )}

                  {/* AI Content Analysis */}
                  {aiAnalysis && (
                    <Card
                      title="AI Content Analysis"
                      icon={<IconBrain />}
                      right={aiAnalysis.content.primary_category
                        ? <Badge label={aiAnalysis.content.primary_category} variant="accent" />
                        : undefined}
                    >
                      <div className="space-y-3">
                        {aiAnalysis.content.summary && (
                          <div className="bg-zinc-800/60 rounded-md px-3 py-2.5">
                            <p className="text-[11px] text-zinc-500 mb-1">Summary</p>
                            <p className="text-sm text-zinc-300 leading-relaxed">{aiAnalysis.content.summary}</p>
                          </div>
                        )}
                        {aiAnalysis.content?.topics && aiAnalysis.content.topics.length > 0 && (
                          <div>
                            <p className="text-[11px] text-zinc-500 mb-2">Topics</p>
                            <div className="flex flex-wrap gap-1.5">
                              {aiAnalysis.content.topics.map((t, i) => <Pill key={i}>{t}</Pill>)}
                            </div>
                          </div>
                        )}
                        <div className="grid grid-cols-2 gap-2">
                          {aiAnalysis.content_style?.tone && aiAnalysis.content_style.tone.length > 0 && (
                            <div className="bg-zinc-800/60 rounded-md px-3 py-2.5">
                              <p className="text-[11px] text-zinc-500 mb-1">Tone</p>
                              <div className="flex flex-wrap gap-1">
                                {aiAnalysis.content_style.tone.map((t, i) => (
                                  <span key={i} className="text-xs text-zinc-300">{t}</span>
                                ))}
                              </div>
                            </div>
                          )}
                          {aiAnalysis.influencer_analysis?.niche && (
                            <div className="bg-zinc-800/60 rounded-md px-3 py-2.5">
                              <p className="text-[11px] text-zinc-500 mb-1">Niche</p>
                              <p className="text-xs text-zinc-300">{aiAnalysis.influencer_analysis.niche}</p>
                            </div>
                          )}
                        </div>
                        {aiAnalysis.engagement?.engagement_rate != null && (
                          <div className="bg-zinc-800/60 rounded-md px-3 py-2.5">
                            <p className="text-[11px] text-zinc-500 mb-1">Engagement Rate</p>
                            <p className="text-base font-semibold text-zinc-100 tabular-nums">
                              {aiAnalysis.engagement.engagement_rate.toFixed(2)}%
                            </p>
                            {aiAnalysis.engagement.engagement_rate_formula && (
                              <p className="text-[11px] text-zinc-600 mt-0.5">
                                {aiAnalysis.engagement.engagement_rate_formula}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    </Card>
                  )}

                  {/* Identified Location */}
                  {place && (
                    <Card
                      title="Identified Location"
                      icon={<IconMapPin />}
                      right={place.category ? <Badge label={place.category} variant="success" /> : undefined}
                    >
                      <div className="space-y-3">
                        <div className="bg-zinc-800/60 rounded-md px-3 py-3">
                          <h3 className="text-base font-semibold text-zinc-100">{place.name}</h3>
                          <p className="text-sm text-zinc-400 mt-0.5">
                            {place.city}{place.neighborhood ? `, ${place.neighborhood}` : ""}
                          </p>
                          {place.address && (
                            <p className="text-xs text-zinc-600 mt-1">{place.address}</p>
                          )}
                        </div>
                        {place.description && (
                          <div className="bg-zinc-800/60 rounded-md px-3 py-2.5">
                            <p className="text-[11px] text-zinc-500 mb-1">Why It&apos;s Worth Going</p>
                            <p className="text-sm text-zinc-300 leading-relaxed">{place.description}</p>
                          </div>
                        )}
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] text-zinc-600">Confidence</span>
                          <div className="flex-1">
                            <ConfBar v={place.confidence || 0} />
                          </div>
                        </div>
                      </div>
                    </Card>
                  )}

                  {/* Promotional Analysis */}
                  {aiAnalysis?.promotion && (
                    <Card title="Promotional Analysis" icon={<IconMega />}>
                      <div className="space-y-3">
                        <div className="grid grid-cols-3 gap-2">
                          {[
                            { label: "Promotional", val: aiAnalysis.promotion.is_promotional },
                            { label: "Sponsored",   val: aiAnalysis.promotion.is_sponsored },
                            { label: "Paid Part.",  val: aiAnalysis.promotion.is_paid_partnership },
                          ].map(({ label, val }) => (
                            <div key={label} className="bg-zinc-800/60 rounded-md px-2 py-2.5 text-center">
                              <p className={`text-sm font-semibold ${val === true ? "text-amber-400" : val === false ? "text-emerald-400" : "text-zinc-600"}`}>
                                {val === null ? "?" : val ? "Yes" : "No"}
                              </p>
                              <p className="text-[10px] text-zinc-500 mt-0.5">{label}</p>
                            </div>
                          ))}
                        </div>
                        {aiAnalysis.promotion?.call_to_actions && aiAnalysis.promotion.call_to_actions.length > 0 && (
                          <div>
                            <p className="text-[11px] text-zinc-500 mb-2">Calls to Action</p>
                            <div className="flex flex-wrap gap-1.5">
                              {aiAnalysis.promotion.call_to_actions.map((c, i) => <Pill key={i}>{c}</Pill>)}
                            </div>
                          </div>
                        )}
                        {aiAnalysis.promotion?.offers && aiAnalysis.promotion.offers.length > 0 && (
                          <div>
                            <p className="text-[11px] text-zinc-500 mb-2">Offers / Deals</p>
                            <div className="flex flex-wrap gap-1.5">
                              {aiAnalysis.promotion.offers.map((o, i) => <Pill key={i}>{o}</Pill>)}
                            </div>
                          </div>
                        )}
                      </div>
                    </Card>
                  )}

                  {/* Whisper Transcript */}
                  {transcript && (
                    <Card title="Audio Transcript" icon={<IconMic />}>
                      <blockquote className="text-sm text-zinc-400 leading-relaxed italic border-l-2 border-zinc-700 pl-3">
                        &ldquo;{transcript}&rdquo;
                      </blockquote>
                      {uploadedAudio && (
                        <div className="mt-4 pt-3 border-t border-zinc-800/80 space-y-2">
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Audio Track</p>
                          <audio controls src={uploadedAudio.publicUrl} className="w-full h-8 bg-zinc-950 rounded-md" />
                        </div>
                      )}
                    </Card>
                  )}

                  {/* Audience & Intent */}
                  {aiAnalysis?.audience?.primary_audience && (
                    <Card title="Audience &amp; Intent" icon={<IconUsers />}>
                      <div className="space-y-3">
                        <div className="bg-zinc-800/60 rounded-md px-3 py-2.5">
                          <p className="text-[11px] text-zinc-500 mb-1">Primary Audience</p>
                          <p className="text-sm font-medium text-zinc-200">{aiAnalysis.audience.primary_audience}</p>
                          {aiAnalysis.audience.intent && (
                            <p className="text-xs text-zinc-500 mt-0.5">Intent: {aiAnalysis.audience.intent}</p>
                          )}
                        </div>
                        {aiAnalysis.audience.interests && aiAnalysis.audience.interests.length > 0 && (
                          <div className="flex flex-wrap gap-1.5">
                            {aiAnalysis.audience.interests.map((i, idx) => <Pill key={idx}>{i}</Pill>)}
                          </div>
                        )}
                        {aiAnalysis.audience.geographic_focus && aiAnalysis.audience.geographic_focus.length > 0 && (
                          <p className="text-xs text-zinc-500">
                            Geo Focus:{" "}
                            <span className="text-zinc-300">{aiAnalysis.audience.geographic_focus.join(", ")}</span>
                          </p>
                        )}
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] text-zinc-600">Confidence</span>
                          <div className="flex-1">
                            <ConfBar v={aiAnalysis.audience.confidence || 0} />
                          </div>
                        </div>
                      </div>
                    </Card>
                  )}
                </div>
              )}
            </div>

            {/* ── OCR DEMO ── */}
            <div id="sec-ocr" className="space-y-4 scroll-mt-16">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">
                  OCR Comparison
                </p>
                <button
                  onClick={() => toggleSection("ocr")}
                  className="text-xs text-zinc-500 hover:text-zinc-300 flex items-center gap-1 transition-colors"
                >
                  <IconChevron up={!collapsedSections.ocr} />
                </button>
              </div>
              {!collapsedSections.ocr && (
                <Card
                  title="Apify Tesseract vs GPT-4o Vision"
                  icon={<IconEye />}
                >
                  {ocrComparison ? (
                    <OcrComparisonDemo ocr={ocrComparison} />
                  ) : (
                    <p className="text-sm text-zinc-600 text-center py-6">
                      No video frames processed. OCR comparison only works for video/reel content.
                    </p>
                  )}
                </Card>
              )}
            </div>


          </>
        )}

        {/* ── Empty state ── */}
        {!hasResults && !isLoading && (
          <div className="text-center py-20 text-zinc-700">
            <div className="flex justify-center mb-4">
              <IconSearch />
            </div>
            <p className="text-sm font-medium text-zinc-500 mb-1">Paste a link to get started</p>
            <p className="text-xs">Supports Instagram Reels &amp; TikTok videos</p>
          </div>
        )}

      </div>
    </div>
  );
}
