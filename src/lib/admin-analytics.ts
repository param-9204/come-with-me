import "server-only";

import { supabaseAdmin } from "@/lib/supabase";

/**
 * Admin analytics are aggregated in Node from lightweight columns. This is fine
 * for thousands of rows; past roughly 50k posts move the bucketing into SQL
 * (an RPC or materialized view) because every request reads the full tables.
 *
 * Definitions used across /admin, /admin/analytics and /admin/users/:id:
 * - Post: a canonical social_posts row. Placeholder rows (pending_ content id)
 *   are excluded and merged duplicates count toward the post they merged into.
 * - A user's posts: posts they created (social_posts.user_id) plus posts they
 *   submitted again later (social_post_accesses), each counted once.
 * - Active user: submitted a post or saved a place in the period. Profiles do
 *   not record sign-in times, so app opens without either action are invisible.
 * - Days are UTC calendar days.
 */

type Row = Record<string, unknown>;

export type RangeKey = "7d" | "30d" | "90d" | "12m" | "all" | "custom";
export type DateRange = { key: RangeKey; from: string; to: string };

export type AnalyticsProfile = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  avatarUrl: string | null;
  clerkUserId: string | null;
  signupMethod: string | null;
  lastSignInMethod: string | null;
  createdAt: string | null;
};

type Post = {
  id: string;
  userId: string | null;
  platform: string;
  contentType: string;
  status: string;
  category: string | null;
  author: string | null;
  likes: number | null;
  views: number | null;
  comments: number | null;
  createdAt: string;
};
type Submission = { userId: string; postId: string; at: string };
type Save = {
  userId: string;
  postId: string | null;
  placeId: string | null;
  status: string | null;
  at: string;
};
type Dataset = {
  profiles: AnalyticsProfile[];
  posts: Post[];
  submissions: Submission[];
  saves: Save[];
  warnings: string[];
};

export type Breakdown = { key: string; label: string; count: number };
export type SeriesPoint = {
  date: string;
  posts: number;
  activeUsers: number;
  newUsers: number;
  saves: number;
};
export type Kpi = { value: number; previous: number | null };
export type UserRow = {
  id: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  joinedAt: string | null;
  postsInRange: number;
  postsTotal: number;
  savesInRange: number;
  savesTotal: number;
  lastActiveAt: string | null;
};

export type AnalyticsReport = {
  range: DateRange;
  previous: DateRange;
  granularity: "day" | "week";
  scope: { userId: string | null; platform: string | null };
  scopedUser: AnalyticsProfile | null;
  kpis: {
    totalUsers: number;
    newUsers: Kpi;
    activeUsers: Kpi;
    posts: Kpi;
    saves: Kpi;
    completionRate: number | null;
    unattributedPosts: number;
    postsPerActiveUser: number | null;
  };
  engagement: {
    postsWithMetrics: number;
    medianViews: number | null;
    medianLikes: number | null;
    totalViews: number;
    totalLikes: number;
    totalComments: number;
  };
  series: SeriesPoint[];
  breakdowns: {
    platform: Breakdown[];
    contentType: Breakdown[];
    category: Breakdown[];
    status: Breakdown[];
    creators: Breakdown[];
  };
  users: UserRow[];
  platforms: string[];
  warnings: string[];
};

const PAGE_SIZE = 1000;
const DAY_MS = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const str = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;
const num = (value: unknown) =>
  value !== null && value !== "" && Number.isFinite(Number(value))
    ? Number(value)
    : null;
const dayOf = (iso: string) => iso.slice(0, 10);
const addDays = (day: string, amount: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + amount * DAY_MS)
    .toISOString()
    .slice(0, 10);
const daysBetween = (from: string, to: string) =>
  Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS,
  ) + 1;
const today = () => new Date().toISOString().slice(0, 10);
const inRange = (iso: string | null, range: { from: string; to: string }) =>
  Boolean(iso) && dayOf(iso!) >= range.from && dayOf(iso!) <= range.to;

async function fetchAll(
  table: string,
  columns: string,
  warnings: string[],
): Promise<Row[]> {
  const rows: Row[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await supabaseAdmin
      .from(table)
      .select(columns)
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) {
      warnings.push(`${table}: ${error.message}`);
      return rows;
    }
    rows.push(...((data ?? []) as unknown as Row[]));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

function toProfile(row: Row): AnalyticsProfile {
  return {
    id: String(row.id),
    name: str(row.display_name),
    email: str(row.email),
    phone: str(row.phone),
    avatarUrl: str(row.avatar_url),
    clerkUserId: str(row.clerk_user_id),
    signupMethod: str(row.signup_method),
    lastSignInMethod: str(row.last_sign_in_method),
    createdAt: str(row.created_at),
  };
}

// Filter changes re-render the admin pages, so the full-table read is reused
// for a short window per server instance. Numbers can lag by up to 30 seconds.
const CACHE_MS = 30_000;
let cache: { at: number; data: Promise<Dataset> } | null = null;

function loadDataset(): Promise<Dataset> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  const data = readDataset();
  cache = { at: Date.now(), data };
  data
    .then((result) => {
      if (result.warnings.length && cache?.data === data) cache = null;
    })
    .catch(() => {
      if (cache?.data === data) cache = null;
    });
  return data;
}

async function readDataset(): Promise<Dataset> {
  const warnings: string[] = [];
  const [profileRows, postRows, accessRows, saveRows] = await Promise.all([
    fetchAll(
      "profiles",
      "id, display_name, email, phone, avatar_url, clerk_user_id, signup_method, last_sign_in_method, created_at",
      warnings,
    ),
    fetchAll(
      "social_posts",
      "id, user_id, platform, content_type, content_id, status, primary_category, author_username, likes, views, comments, merged_into_post_id, created_at",
      warnings,
    ),
    fetchAll(
      "social_post_accesses",
      "id, user_id, social_post_id, created_at",
      warnings,
    ),
    fetchAll(
      "saved_places",
      "id, user_id, place_id, social_post_id, status, created_at",
      warnings,
    ),
  ]);

  // Duplicate rows point at their canonical post; follow the chain once.
  const mergedInto = new Map<string, string>();
  for (const row of postRows) {
    const target = str(row.merged_into_post_id);
    if (target) mergedInto.set(String(row.id), target);
  }
  const canonical = (id: string) => mergedInto.get(id) ?? id;

  const posts: Post[] = [];
  const submissions = new Map<string, Submission>();
  const submit = (userId: string, postId: string, at: string) => {
    const key = `${userId}:${postId}`;
    const existing = submissions.get(key);
    if (!existing || at < existing.at)
      submissions.set(key, { userId, postId, at });
  };

  for (const row of postRows) {
    const createdAt = str(row.created_at);
    if (!createdAt) continue;
    const id = String(row.id);
    const userId = str(row.user_id);
    if (userId) submit(userId, canonical(id), createdAt);
    const contentId = str(row.content_id) || "";
    if (mergedInto.has(id) || /pending/i.test(contentId)) continue;
    if (str(row.status) === "merged") continue;
    posts.push({
      id,
      userId,
      platform: str(row.platform) || "unknown",
      contentType: str(row.content_type) || "post",
      status: str(row.status) || "pending",
      category: str(row.primary_category),
      author: str(row.author_username),
      likes: num(row.likes),
      views: num(row.views),
      comments: num(row.comments),
      createdAt,
    });
  }
  for (const row of accessRows) {
    const userId = str(row.user_id);
    const postId = str(row.social_post_id);
    const at = str(row.created_at);
    if (userId && postId && at) submit(userId, canonical(postId), at);
  }

  const postIds = new Set(posts.map((post) => post.id));
  return {
    profiles: profileRows.map(toProfile),
    posts,
    // Submissions of URLs that never produced a post (failed placeholders) are
    // dropped so user totals always reconcile with the posts list.
    submissions: [...submissions.values()].filter((item) =>
      postIds.has(item.postId),
    ),
    saves: saveRows.flatMap((row) => {
      const userId = str(row.user_id);
      const at = str(row.created_at);
      if (!userId || !at) return [];
      const postId = str(row.social_post_id);
      return [
        {
          userId,
          postId: postId ? canonical(postId) : null,
          placeId: str(row.place_id),
          status: str(row.status),
          at,
        },
      ];
    }),
    warnings,
  };
}

export function resolveRange(
  params: Record<string, string | string[] | undefined>,
): DateRange | null {
  const one = (key: string) => {
    const value = params[key];
    return (Array.isArray(value) ? value[0] : value)?.trim() || "";
  };
  const end = today();
  const key = one("range") as RangeKey;
  const from = one("from");
  const to = one("to");
  if (DAY.test(from) && DAY.test(to) && from <= to)
    return { key: "custom", from, to };
  if (key === "7d") return { key, from: addDays(end, -6), to: end };
  if (key === "90d") return { key, from: addDays(end, -89), to: end };
  if (key === "12m") return { key, from: addDays(end, -364), to: end };
  if (key === "all") return null;
  return { key: "30d", from: addDays(end, -29), to: end };
}

const titleCase = (value: string) =>
  value.toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
const PLATFORM_LABELS: Record<string, string> = {
  tiktok: "TikTok",
  youtube: "YouTube",
};
const platformLabel = (value: string) =>
  PLATFORM_LABELS[value.toLowerCase()] ?? titleCase(value);

function breakdown(
  values: Array<string | null>,
  label: (key: string) => string = (key) => key,
  limit = Infinity,
): Breakdown[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = value ?? "";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const sorted = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, count]) => ({ key, label: label(key), count }));
  if (sorted.length <= limit) return sorted;
  const rest = sorted.slice(limit).reduce((sum, item) => sum + item.count, 0);
  return [
    ...sorted.slice(0, limit),
    { key: "__other", label: `Other (${sorted.length - limit})`, count: rest },
  ];
}

const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

const weekStart = (day: string) => {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return addDays(day, -((weekday + 6) % 7));
};

function buildReport(
  data: Dataset,
  requestedRange: DateRange | null,
  options: { userId?: string | null; platform?: string | null },
): AnalyticsReport {
  const userId = options.userId && UUID.test(options.userId) ? options.userId : null;
  const platform = options.platform || null;
  const postById = new Map(data.posts.map((post) => [post.id, post]));
  const platformOk = (postId: string | null) =>
    !platform || (postId ? postById.get(postId)?.platform === platform : false);

  const earliest = [
    ...data.posts.map((post) => post.createdAt),
    ...data.profiles.map((profile) => profile.createdAt || ""),
  ]
    .filter(Boolean)
    .sort()[0];
  const range: DateRange = requestedRange ?? {
    key: "all",
    from: earliest ? dayOf(earliest) : today(),
    to: today(),
  };
  const length = daysBetween(range.from, range.to);
  const previous: DateRange = {
    key: "custom",
    from: addDays(range.from, -length),
    to: addDays(range.from, -1),
  };

  // Scoped activity. With a user filter, a post's date is when that user
  // submitted it; platform-wide, it is when the post was first created.
  const submissions = data.submissions.filter(
    (item) => (!userId || item.userId === userId) && platformOk(item.postId),
  );
  const saves = data.saves.filter(
    (item) => (!userId || item.userId === userId) && platformOk(item.postId),
  );
  const postEvents: Array<{ post: Post; at: string }> = userId
    ? submissions.flatMap((item) => {
        const post = postById.get(item.postId);
        return post ? [{ post, at: item.at }] : [];
      })
    : data.posts
        .filter((post) => !platform || post.platform === platform)
        .map((post) => ({ post, at: post.createdAt }));

  const postsIn = (window: { from: string; to: string }) =>
    postEvents.filter((event) => inRange(event.at, window));
  const activeIn = (window: { from: string; to: string }) =>
    new Set([
      ...submissions.filter((s) => inRange(s.at, window)).map((s) => s.userId),
      ...saves.filter((s) => inRange(s.at, window)).map((s) => s.userId),
    ]);
  const newUsersIn = (window: { from: string; to: string }) =>
    data.profiles.filter((profile) => inRange(profile.createdAt, window))
      .length;
  const savesIn = (window: { from: string; to: string }) =>
    saves.filter((save) => inRange(save.at, window)).length;

  const currentPosts = postsIn(range);
  const activeUsers = activeIn(range);
  const attributed = new Set(data.submissions.map((item) => item.postId));
  const completed = currentPosts.filter(
    (event) => event.post.status === "completed",
  ).length;
  const hasPrevious = range.key !== "all";

  const withViews = currentPosts
    .map((event) => event.post.views)
    .filter((value): value is number => value !== null && value > 0);
  const withLikes = currentPosts
    .map((event) => event.post.likes)
    .filter((value): value is number => value !== null && value > 0);
  const sum = (key: "views" | "likes" | "comments") =>
    currentPosts.reduce((total, event) => total + (event.post[key] ?? 0), 0);

  // Weekly buckets keep long ranges readable (≈52 bars for a year).
  const granularity: "day" | "week" = length > 92 ? "week" : "day";
  const bucketOf = (iso: string) =>
    granularity === "week" ? weekStart(dayOf(iso)) : dayOf(iso);
  const buckets = new Map<
    string,
    SeriesPoint & { users: Set<string> }
  >();
  for (
    let day = granularity === "week" ? weekStart(range.from) : range.from;
    day <= range.to;
    day = addDays(day, granularity === "week" ? 7 : 1)
  ) {
    buckets.set(day, {
      date: day,
      posts: 0,
      activeUsers: 0,
      newUsers: 0,
      saves: 0,
      users: new Set(),
    });
  }
  const bucket = (iso: string | null) =>
    iso && inRange(iso, range) ? buckets.get(bucketOf(iso)) : undefined;
  currentPosts.forEach((event) => {
    const target = bucket(event.at);
    if (target) target.posts += 1;
  });
  submissions.forEach((item) => bucket(item.at)?.users.add(item.userId));
  saves.forEach((item) => {
    const target = bucket(item.at);
    if (!target) return;
    target.saves += 1;
    target.users.add(item.userId);
  });
  if (!userId)
    data.profiles.forEach((profile) => {
      const target = bucket(profile.createdAt);
      if (target) target.newUsers += 1;
    });
  const series = [...buckets.values()].map(({ users, ...point }) => ({
    ...point,
    activeUsers: users.size,
  }));

  const statusLabel = (key: string) =>
    ["pending", "scraped", "processing"].includes(key)
      ? "Processing"
      : titleCase(key || "unknown");

  const byUser = <T extends { userId: string; postId: string | null }>(
    items: T[],
  ) => {
    const grouped = new Map<string, T[]>();
    for (const item of items) {
      if (!platformOk(item.postId)) continue;
      const list = grouped.get(item.userId);
      if (list) list.push(item);
      else grouped.set(item.userId, [item]);
    }
    return grouped;
  };
  const submissionsByUser = byUser(data.submissions);
  const savesByUser = byUser(data.saves);
  const users: UserRow[] = data.profiles.map((profile) => {
    const own = submissionsByUser.get(profile.id) ?? [];
    const ownSaves = savesByUser.get(profile.id) ?? [];
    const lastActiveAt =
      [...own.map((item) => item.at), ...ownSaves.map((item) => item.at)]
        .sort()
        .at(-1) ?? null;
    return {
      id: profile.id,
      name: profile.name,
      email: profile.email,
      avatarUrl: profile.avatarUrl,
      joinedAt: profile.createdAt,
      postsInRange: own.filter((item) => inRange(item.at, range)).length,
      postsTotal: own.length,
      savesInRange: ownSaves.filter((item) => inRange(item.at, range)).length,
      savesTotal: ownSaves.length,
      lastActiveAt,
    };
  });

  return {
    range,
    previous,
    granularity,
    scope: { userId, platform },
    scopedUser: userId
      ? (data.profiles.find((profile) => profile.id === userId) ?? null)
      : null,
    kpis: {
      totalUsers: data.profiles.length,
      newUsers: {
        value: newUsersIn(range),
        previous: hasPrevious ? newUsersIn(previous) : null,
      },
      activeUsers: {
        value: activeUsers.size,
        previous: hasPrevious ? activeIn(previous).size : null,
      },
      posts: {
        value: currentPosts.length,
        previous: hasPrevious ? postsIn(previous).length : null,
      },
      saves: {
        value: savesIn(range),
        previous: hasPrevious ? savesIn(previous) : null,
      },
      completionRate: currentPosts.length
        ? completed / currentPosts.length
        : null,
      unattributedPosts: userId
        ? 0
        : currentPosts.filter((event) => !attributed.has(event.post.id))
            .length,
      postsPerActiveUser: activeUsers.size
        ? submissions.filter((item) => inRange(item.at, range)).length /
          activeUsers.size
        : null,
    },
    engagement: {
      postsWithMetrics: withViews.length,
      medianViews: median(withViews),
      medianLikes: median(withLikes),
      totalViews: sum("views"),
      totalLikes: sum("likes"),
      totalComments: sum("comments"),
    },
    series,
    breakdowns: {
      platform: breakdown(
        currentPosts.map((event) => event.post.platform),
        platformLabel,
      ),
      contentType: breakdown(
        currentPosts.map((event) => event.post.contentType),
        titleCase,
      ),
      // Categories arrive in mixed case ("TRAVEL", "Travel"); fold them.
      category: breakdown(
        currentPosts.map(
          (event) => event.post.category?.toLowerCase() ?? null,
        ),
        (key) => (key ? titleCase(key) : "Uncategorized"),
        8,
      ),
      status: breakdown(
        currentPosts.map((event) =>
          ["pending", "scraped", "processing"].includes(event.post.status)
            ? "processing"
            : event.post.status,
        ),
        statusLabel,
      ),
      creators: breakdown(
        currentPosts.map((event) => event.post.author),
        (key) => (key ? `@${key}` : "Unknown creator"),
      ).slice(0, 8),
    },
    users,
    platforms: [...new Set(data.posts.map((post) => post.platform))].sort(),
    warnings: data.warnings,
  };
}

export async function getAdminAnalytics(options: {
  range: DateRange | null;
  userId?: string | null;
  platform?: string | null;
}): Promise<AnalyticsReport> {
  const data = await loadDataset();
  return buildReport(data, options.range, options);
}

export type AdminOverview = {
  range: DateRange;
  platforms: string[];
  totalPosts: number;
  totalUsers: number;
  posts7d: Kpi;
  activeUsers7d: Kpi;
  newUsers7d: Kpi;
  saves7d: Kpi;
  warnings: string[];
};

/** Last-7-days headline numbers for the /admin posts page. */
export async function getAdminOverview(): Promise<AdminOverview> {
  const data = await loadDataset();
  const end = today();
  const report = buildReport(
    data,
    { key: "7d", from: addDays(end, -6), to: end },
    {},
  );
  return {
    range: report.range,
    platforms: report.platforms,
    totalPosts: data.posts.length,
    totalUsers: data.profiles.length,
    posts7d: report.kpis.posts,
    activeUsers7d: report.kpis.activeUsers,
    newUsers7d: report.kpis.newUsers,
    saves7d: report.kpis.saves,
    warnings: data.warnings,
  };
}

export type ActivityItem =
  | {
      kind: "post";
      at: string;
      postId: string;
      author: string | null;
      platform: string;
      caption: string | null;
      status: string;
    }
  | {
      kind: "save";
      at: string;
      placeName: string | null;
      placeCity: string | null;
      saveStatus: string | null;
      postId: string | null;
    };

export type AdminUserDetail = {
  profile: AnalyticsProfile;
  stats: {
    postsTotal: number;
    posts30d: number;
    savesTotal: number;
    saves30d: number;
    beenHere: number;
    wantToGo: number;
    activeDays: number;
    firstActiveAt: string | null;
    lastActiveAt: string | null;
  };
  weekly: Array<{ date: string; posts: number; saves: number }>;
  platforms: Breakdown[];
  categories: Breakdown[];
  activity: ActivityItem[];
  warnings: string[];
};

export async function getAdminUserDetail(
  userId: string,
): Promise<AdminUserDetail | null> {
  if (!UUID.test(userId)) return null;
  const data = await loadDataset();
  const profile = data.profiles.find((item) => item.id === userId);
  if (!profile) return null;

  const postById = new Map(data.posts.map((post) => [post.id, post]));
  const submissions = data.submissions
    .filter((item) => item.userId === userId)
    .sort((a, b) => b.at.localeCompare(a.at));
  const saves = data.saves
    .filter((item) => item.userId === userId)
    .sort((a, b) => b.at.localeCompare(a.at));
  const end = today();
  const last30 = { from: addDays(end, -29), to: end };
  const allDates = [
    ...submissions.map((item) => item.at),
    ...saves.map((item) => item.at),
  ].sort();

  const weeks: AdminUserDetail["weekly"] = [];
  const firstWeek = weekStart(addDays(end, -7 * 11));
  for (let week = firstWeek; week <= end; week = addDays(week, 7))
    weeks.push({ date: week, posts: 0, saves: 0 });
  const weekIndex = new Map(weeks.map((week, index) => [week.date, index]));
  submissions.forEach((item) => {
    const index = weekIndex.get(weekStart(dayOf(item.at)));
    if (index !== undefined) weeks[index].posts += 1;
  });
  saves.forEach((item) => {
    const index = weekIndex.get(weekStart(dayOf(item.at)));
    if (index !== undefined) weeks[index].saves += 1;
  });

  // Captions and place names are only needed for the visible timeline.
  const recentPosts = submissions.slice(0, 20);
  const recentSaves = saves.slice(0, 20);
  const placeIds = [
    ...new Set(
      recentSaves
        .map((item) => item.placeId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const [captionResult, placeResult] = await Promise.all([
    recentPosts.length
      ? supabaseAdmin
          .from("social_posts")
          .select("id, caption")
          .in(
            "id",
            recentPosts.map((item) => item.postId),
          )
      : Promise.resolve({ data: [] as Row[] }),
    placeIds.length
      ? supabaseAdmin
          .from("places")
          .select("id, name, city")
          .in("id", placeIds)
      : Promise.resolve({ data: [] as Row[] }),
  ]);
  const captions = new Map(
    ((captionResult.data ?? []) as Row[]).map((row) => [
      String(row.id),
      str(row.caption),
    ]),
  );
  const places = new Map(
    ((placeResult.data ?? []) as Row[]).map((row) => [String(row.id), row]),
  );

  const activity: ActivityItem[] = [
    ...recentPosts.map((item): ActivityItem => {
      const post = postById.get(item.postId);
      return {
        kind: "post",
        at: item.at,
        postId: item.postId,
        author: post?.author ?? null,
        platform: post?.platform ?? "unknown",
        caption: captions.get(item.postId)?.slice(0, 140) ?? null,
        status: post?.status ?? "pending",
      };
    }),
    ...recentSaves.map((item): ActivityItem => {
      const place = item.placeId ? places.get(item.placeId) : undefined;
      return {
        kind: "save",
        at: item.at,
        placeName: str(place?.name),
        placeCity: str(place?.city),
        saveStatus: item.status,
        postId: item.postId,
      };
    }),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 25);

  const userPosts = submissions
    .map((item) => postById.get(item.postId))
    .filter((post): post is Post => Boolean(post));

  return {
    profile,
    stats: {
      postsTotal: submissions.length,
      posts30d: submissions.filter((item) => inRange(item.at, last30)).length,
      savesTotal: saves.length,
      saves30d: saves.filter((item) => inRange(item.at, last30)).length,
      beenHere: saves.filter((item) => item.status === "BEEN_HERE").length,
      wantToGo: saves.filter((item) => item.status === "WANT_TO_GO").length,
      activeDays: new Set(allDates.map(dayOf)).size,
      firstActiveAt: allDates[0] ?? null,
      lastActiveAt: allDates.at(-1) ?? null,
    },
    weekly: weeks,
    platforms: breakdown(
      userPosts.map((post) => post.platform),
      platformLabel,
    ),
    categories: breakdown(
      userPosts.map((post) => post.category?.toLowerCase() ?? null),
      (key) => (key ? titleCase(key) : "Uncategorized"),
      6,
    ),
    activity,
    warnings: data.warnings,
  };
}
