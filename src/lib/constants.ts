/** Maximum number of results returned per source when called from the orchestrator tool. */
export const MAX_RESULTS_PER_SOURCE = 5;

/** Page size for the paginated catalog flows (searchMedia, searchBooks, searchGames). */
export const CATALOG_PAGE_SIZE = 10;

/**
 * Longest `/feedback` comment accepted.
 *
 * There was no cap at all: the only ceiling was body-parser's undeclared 100 KB, so a
 * single thumbs-down could append 100 KB of free text to Langfuse, once per request the
 * rate limiter allows. 2 000 characters is well above anything a feedback box collects and
 * far below a figure worth storing by accident.
 */
export const FEEDBACK_COMMENT_MAX_LENGTH = 2000;
