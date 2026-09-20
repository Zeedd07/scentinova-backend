export function parsePagination(query, { defaultLimit = 12, maxLimit = 100 } = {}) {
  const page = Math.max(1, Number(query.page) || 1)
  let limit = Number(query.limit) || defaultLimit
  if (limit < 1) limit = defaultLimit
  if (limit > maxLimit) limit = maxLimit
  const skip = (page - 1) * limit
  return { page, limit, skip }
}

export function paginationMeta(page, limit, total) {
  return {
    page,
    limit,
    total,
    pages: Math.max(1, Math.ceil(total / limit) || 1),
  }
}
