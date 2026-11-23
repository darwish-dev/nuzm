/**
 * Limits of the read-only agent tools (D-46, SCR-K-10 §3 and §4). Per call and per run. Every one is a hard ceiling: a call over a limit gets a structured refusal, never a silent
 * truncation of the request (a RESULT may be truncated, and says so).
 */
export const AGENT_TOOL_LIMITS = {
  /** per run */
  maxCallsPerRun: 60,
  maxResultBytesPerRun: 400_000,
  /** per call */
  maxResultBytesPerCall: 40_000,
  maxReadChars: 16_000,
  maxListLimit: 200,
  defaultListLimit: 100,
  maxSearchLimit: 50,
  defaultSearchLimit: 20,
  snippetChars: 200,
  queryMaxChars: 200,
  globMaxChars: 120,
  globMaxWildcards: 8,
  pathMaxChars: 300,
  pathMaxSegments: 20,
  segmentMaxChars: 120,
  /** work bounds of a search: files and bytes looked at in one call */
  searchMaxFiles: 2_000,
  searchMaxBytes: 4_000_000,
  searchMaxFileBytes: 1_000_000,
  /** inspect_project */
  inspectMaxDeps: 80,
  inspectMaxScripts: 30,
  inspectMaxTopLevel: 40,
  inspectMaxExtensions: 12,
} as const;

/** The reason codes a tool result can carry. The text of a message is fixed in code: it never quotes an argument, a path, a file or an exception. */
export type ToolErrorCode =
  | 'invalid_arguments'
  | 'invalid_path'
  | 'not_found'
  | 'not_permitted'
  | 'too_large'
  | 'unknown_tool'
  | 'internal_error';
