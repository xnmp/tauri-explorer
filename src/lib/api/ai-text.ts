/**
 * Default-profile text generation for core window features (AI filter, #1506).
 * Native owns the profile, credentials, deadlines and per-window cancellation;
 * `describeText` lets a caller refuse before assembling any request content.
 */
import { invoke } from "./common";
import type { TextDescription, TextResult } from "$lib/domain/text-connections";

export interface WindowTextRequest {
  requestId: string;
  instructions: string;
  input: string;
  maxOutputTokens: number;
  expectedConfigurationRevision?: number;
}

export const describeText = () => invoke<TextDescription>("ai_text_describe");
export const generateText = (request: WindowTextRequest) => invoke<TextResult>("ai_text_generate", { ...request });
export const cancelText = (requestId: string) => invoke<boolean>("ai_text_cancel", { requestId });
