/** Plugin file view ids are persisted with pane layouts, so they are bounded,
 *  plugin-scoped tokens (e.g. "trace.view"). */
export const FILE_VIEW_ID = /^[A-Za-z0-9][\w.-]{0,127}$/;
export const isFileViewId = (value: unknown): value is string => typeof value === "string" && FILE_VIEW_ID.test(value);
