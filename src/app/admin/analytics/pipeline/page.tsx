import { resolveRange } from "@/lib/admin-analytics";
import { getPipelineHealth } from "@/lib/admin-pipeline";
import PipelineView from "./pipeline-view";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AdminPipelinePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const platform = Array.isArray(params.platform)
    ? params.platform[0]
    : params.platform;
  const report = await getPipelineHealth({
    range: resolveRange(params),
    platform: platform || null,
  });

  return <PipelineView report={report} />;
}
