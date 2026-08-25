import { supabaseAdmin } from "@/lib/supabase";
import { successResponse, errorResponse } from "@/lib/http/response";
import { logger } from "@/lib/logger";
import { parsePagination, buildPagination } from "@/lib/http/pagination";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);

    const { page, limit, offset } = parsePagination(searchParams, {
      defaultLimit: 50,
      maxLimit: 200,
    });

    const ascending = (searchParams.get("sort_order") ?? "asc") === "asc"; //sorting

    const search = searchParams.get("search")?.trim() ?? ""; //Filtering

    let query = supabaseAdmin
      .from("cities")
      .select("id, name, latitude, longitude, created_at", { count: "exact" })
      .order("name", { ascending })
      .range(offset, offset + limit - 1);

    if (search) {
      query = query.ilike("name", `%${search}%`);
    }

    const { data, error, count } = await query;

    if (error) {
      logger.error("[Cities API] Fetch error", {
        error,
      });
      return errorResponse(
        "Internal server error",
        500,
        "INTERNAL_SERVER_ERROR",
      );
    }

    const cities = (data ?? []).map((item: any) => ({
      id: item.id,
      name: item.name,
      latitude: item.latitude,
      longitude: item.longitude,
      created_at: item.created_at,
    }));
    const totalItems = count ?? 0;

    const pagination = buildPagination({
      page,
      limit,
      totalItems,
    });

    return successResponse(
      {
        cities,
      },
      200,
      {
        page,
        limit,
        total_items: totalItems,
        total_pages: pagination.total_pages,
      },
    );
  } catch (error: any) {
    logger.error("[Cities API] Unhandled error", {
      error,
    });

    const message =
      error instanceof Error ? error.message : "Internal server error";

    return errorResponse(message, 500, "INTERNAL_SERVER_ERROR");
  }
}
