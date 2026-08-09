/**
 * File upload size limit constant.
 *
 * Aligned with Feishu im/v1/files API limit (30MB for file_type=stream).
 * Single source of truth — router and connector both import from here.
 */
export const MAX_FILE_UPLOAD_SIZE = 30 * 1024 * 1024; // 30MB
