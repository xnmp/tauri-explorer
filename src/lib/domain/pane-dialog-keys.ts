/** Editable dialog controls retain keys unless a command explicitly declares
 * workspace focus navigation. Destination modality is admitted separately. */
export function allowsPaneDialogCommandInput(command: { allowInDialogInput?: boolean } | undefined, editable: boolean): boolean {
  return command !== undefined && (!editable || command.allowInDialogInput === true);
}
