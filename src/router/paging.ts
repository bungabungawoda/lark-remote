import { clampInt } from '../common/clamp.js';

export function pageInfo(
  totalCount: number,
  offset: number,
  pageSize: number,
): { totalPages: number; safeOffset: number; currentPage: number } {
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const maxOffset = Math.max(0, (totalPages - 1) * pageSize);
  const safeOffset = clampInt(offset, 0, maxOffset);
  const currentPage = Math.floor(safeOffset / pageSize) + 1;
  return { totalPages, safeOffset, currentPage };
}

export function pageSlice<T>(
  items: readonly T[],
  offset: number,
  pageSize: number,
): {
  totalCount: number;
  totalPages: number;
  safeOffset: number;
  currentPage: number;
  pageItems: T[];
  hasPagination: boolean;
} {
  const { totalPages, safeOffset, currentPage } = pageInfo(items.length, offset, pageSize);
  return {
    totalCount: items.length,
    totalPages,
    safeOffset,
    currentPage,
    pageItems: items.slice(safeOffset, safeOffset + pageSize),
    hasPagination: items.length > pageSize,
  };
}
