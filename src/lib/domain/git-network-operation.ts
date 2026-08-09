/** Backend-to-frontend phase change for a running Git network operation. */
export interface GitNetworkPhaseEvent {
  taskId: number;
  cancellable: boolean;
}
