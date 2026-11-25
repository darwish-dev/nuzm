/**
 * How much a customer may write to the AI builder (owner request 2026-11-26). One source for the API validators and the AI engine; the console mirrors the same numbers
 * in `apps/web/lib/appbuilder.ts` (a test keeps them equal). A text over the limit is REFUSED with a validation error, never cut: the customer's requirements are kept
 * whole, and model context and token budgets are managed by the AI engine (data blocks, context packs, routing by context window), not by shortening the request.
 */
export const PROMPT_LIMITS = {
  /** the first description / brief / requirement of a project (website, web app, mobile, template plan) */
  projectPromptChars: 30_000,
  /** one follow-up chat message or change instruction */
  chatMessageChars: 20_000,
} as const;
