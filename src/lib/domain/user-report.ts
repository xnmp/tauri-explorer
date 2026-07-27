export type UserReportKind = "bug" | "feature";

export interface UserReportDraft {
  title: string;
  body: string;
  kind: UserReportKind;
  contact?: string;
}

export interface SubmittedUserReport {
  url: string;
  number: number;
}

export type UserReportErrorKind =
  | "malformed_input"
  | "network_unreachable"
  | "rate_limited"
  | "daily_cap"
  | "server_rejected";

export interface UserReportError {
  kind: UserReportErrorKind;
  message: string;
}
