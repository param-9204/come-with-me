/**
 * Groups pipeline log messages into issue types. Log messages embed venue
 * names, counts, ids and provider org ids, so the same problem appears with
 * thousands of spellings; the signature strips those parts. Shared by the post
 * page and pipeline analytics so both group identically. Pure, no imports.
 */
export function issueSignature(message: string | null | undefined): string {
  if (!message) return "No message recorded";
  return (
    message
      .replace(/https?:\/\/\S+/g, "<url>")
      .replace(/\borg-[A-Za-z0-9]+/g, "org-…")
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
      // Quoted venue names and search terms.
      .replace(/["“][^"”]{0,120}["”]/g, "“…”")
      .replace(/\d+(?:[.,]\d+)*/g, "#")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160) || "No message recorded"
  );
}

/**
 * Apify status polls record "partial" while the actor is still running. They
 * are routine and must not count as degraded calls.
 */
export const isRoutinePoll = (operation: { stage?: unknown; operation?: unknown; status?: unknown }) =>
  operation.stage === "scrape" &&
  operation.operation === "poll_actor" &&
  operation.status === "partial";

/** Stage order as the pipeline runs, for stable sorting in tables and charts. */
export const STAGE_ORDER = [
  "run",
  "scrape",
  "media",
  "frames",
  "transcript",
  "ocr",
  "vision",
  "evidence",
  "model",
  "candidates",
  "geocode",
  "db",
];

export const stageRank = (stage: string) => {
  const index = STAGE_ORDER.indexOf(stage);
  return index === -1 ? STAGE_ORDER.length : index;
};

export const STAGE_LABELS: Record<string, string> = {
  run: "Run",
  scrape: "Scrape",
  media: "Media",
  frames: "Frames",
  transcript: "Transcript",
  ocr: "OCR",
  vision: "Vision",
  evidence: "Evidence",
  model: "Model",
  candidates: "Candidates",
  geocode: "Geocode",
  db: "Save",
};

export const stageLabel = (stage: unknown) =>
  typeof stage === "string"
    ? (STAGE_LABELS[stage] ?? stage.replace(/_/g, " "))
    : "Unknown";

export const EVIDENCE_LABELS: Record<string, string> = {
  vision_ocr: "Vision OCR",
  ocr: "Tesseract OCR",
  caption: "Caption",
  comment: "Comments",
  comment_creator: "Creator comments",
  speech: "Speech",
  account: "Tagged accounts",
  hashtags: "Hashtags",
  location_tag: "Location tag",
  alt_text: "Alt text",
  creator_bio: "Creator bio",
};

export const evidenceLabel = (source: unknown) =>
  typeof source === "string"
    ? (EVIDENCE_LABELS[source] ?? source.replace(/_/g, " "))
    : "Unknown";

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index];
}
