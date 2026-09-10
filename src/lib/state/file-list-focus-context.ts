import { getContext, setContext } from "svelte";

/** FileList owns the request across editor teardown and virtual row replacement. */
export type CaptureFileListFocusReturn = () => (accepted: boolean) => void;
const FILE_LIST_FOCUS_RETURN = Symbol("file-list-focus-return");

export function setFileListFocusReturn(capture: CaptureFileListFocusReturn): void {
  setContext(FILE_LIST_FOCUS_RETURN, capture);
}

export function getFileListFocusReturn(): CaptureFileListFocusReturn | undefined {
  return getContext<CaptureFileListFocusReturn | undefined>(FILE_LIST_FOCUS_RETURN);
}
