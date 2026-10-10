import { invoke, isTauri } from "./common";
import { listen } from "@tauri-apps/api/event";
import { editableConfiguration, type TextConfiguration, type TextResult, type ServiceError } from "$lib/domain/text-connections";
export interface ConnectionCheck { available: boolean; error?: ServiceError }
export const TEXT_CONFIGURATION_CHANGED = "ai:text-configuration-changed";
export const readTextConnections = () => invoke<TextConfiguration>("ai_connections_read");
export const saveTextConnections = (configuration: TextConfiguration, expectedRevision: number) => invoke<TextConfiguration>("ai_connections_save", { configuration: editableConfiguration(configuration), expectedRevision });
export const setTextCredential = (profileId: string, key: string, expectedRevision: number) => invoke<TextConfiguration>("ai_connection_set_credential", { profileId, key, expectedRevision });
export const clearTextCredential = (profileId: string, expectedRevision: number) => invoke<TextConfiguration>("ai_connection_clear_credential", { profileId, expectedRevision });
export const checkTextConnection = (profileId: string) => invoke<ConnectionCheck>("ai_connection_check", { profileId });
export const testTextConnection = (profileId: string, requestId: string, expectedConfigurationRevision: number) => invoke<TextResult>("ai_connection_test", { profileId, requestId, expectedConfigurationRevision });
export const cancelTextConnectionTest = (requestId: string) => invoke<void>("ai_connection_cancel_test", { requestId });
export async function watchTextConnections(onRevision: (revision: number) => void): Promise<() => void> {
  if (isTauri()) return listen<{ revision: number }>(TEXT_CONFIGURATION_CHANGED, event => onRevision(event.payload.revision));
  const receive = (event: Event) => onRevision((event as CustomEvent<{ revision: number }>).detail.revision);
  window.addEventListener(TEXT_CONFIGURATION_CHANGED, receive);
  return () => window.removeEventListener(TEXT_CONFIGURATION_CHANGED, receive);
}
