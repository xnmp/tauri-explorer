/** Backend-to-frontend phase change for a running Git network operation. */
export interface GitNetworkPhaseEvent {
  taskId: number;
  cancellable: boolean;
}

/** Tauri event emitted when a network operation crosses a cancellation boundary. */
export const GIT_NETWORK_PHASE_EVENT = "git-network-operation-phase";

/** Browser-mock equivalent of the Tauri phase event. */
export const GIT_NETWORK_PHASE_DOM_EVENT = "tauri-explorer:git-network-operation-phase";

