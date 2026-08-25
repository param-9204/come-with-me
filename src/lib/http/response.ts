import { NextResponse } from "next/server";

interface Pagination {
  page: number;
  limit: number;
  total_items: number;
  total_pages: number;
}

export function successResponse<T>(
  data: T,
  status = 200,
  pagination?: Pagination,
) {
  return NextResponse.json(
    {
      success: true,
      ...data,
      ...(pagination && { pagination }),
    },
    { status },
  );
}

export function errorResponse(message: string, status = 500, code?: string) {
  return NextResponse.json(
    {
      success: false,
      error: message,
      ...(code ? { code } : {}),
    },
    { status },
  );
}
