export interface Pagination {
  page: number;
  limit: number;
  offset: number;
}

export function parsePagination(
  searchParams: URLSearchParams,
  options?: {
    defaultLimit?: number;
    maxLimit?: number;
  }
): Pagination {
  const defaultLimit = options?.defaultLimit ?? 10;
  const maxLimit = options?.maxLimit ?? 100;

  const rawPage = Number(
    searchParams.get('page') ?? '1'
  );

  const rawLimit = Number(
    searchParams.get('limit') ?? defaultLimit
  );

  const page = Number.isFinite(rawPage)
    ? Math.max(Math.floor(rawPage), 1)
    : 1;

  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.floor(rawLimit), 1), maxLimit)
    : defaultLimit;

  return {
    page,
    limit,
    offset: (page - 1) * limit,
  };
}

export function buildPagination(params: {
  page: number;
  limit: number;
  totalItems: number;
}) {
  const {
    page,
    limit,
    totalItems,
  } = params;

  const totalPages = Math.ceil(
    totalItems / limit
  );

  return {
    page,
    limit,
    total_items: totalItems,
    total_pages: totalPages,
    has_next: page < totalPages,
    has_prev: page > 1,
  };
}