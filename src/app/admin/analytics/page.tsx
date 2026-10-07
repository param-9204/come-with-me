import { getAdminAnalytics, resolveRange } from "@/lib/admin-analytics";
import AnalyticsView from "./analytics-view";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type SearchParams = Record<string, string | string[] | undefined>;

export default async function AdminAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const one = (key: string) => {
    const value = params[key];
    return (Array.isArray(value) ? value[0] : value) || null;
  };
  const report = await getAdminAnalytics({
    range: resolveRange(params),
    userId: one("user"),
    platform: one("platform"),
  });

  return <AnalyticsView report={report} />;
}
