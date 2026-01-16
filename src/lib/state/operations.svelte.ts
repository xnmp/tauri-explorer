/**
 * Operations state management for progress tracking.
 * Issue: tauri-explorer-5kv
 *
 * Manages file operations (copy, move, delete) with progress tracking,
 * cancellation support, and error handling.
 */

export type OperationType = "copy" | "move" | "delete";

export interface Operation {
  id: string;
  type: OperationType;
  sourcePath: string;
  destPath?: string;
  fileName: string;
  progress: number; // 0-100
  status: "pending" | "running" | "completed" | "cancelled" | "error";
  error?: string;
  startTime: number;
  bytesProcessed?: number;
  totalBytes?: number;
}

function generateOperationId(): string {
  return `op-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createOperationsManager() {
  let operations = $state<Operation[]>([]);
  let showProgressDialog = $state(false);

  /** Start a new operation */
  function startOperation(
    type: OperationType,
    sourcePath: string,
    destPath?: string
  ): Operation {
    const fileName = sourcePath.split(/[/\\]/).pop() || sourcePath;

    const operation: Operation = {
      id: generateOperationId(),
      type,
      sourcePath,
      destPath,
      fileName,
      progress: 0,
      status: "running",
      startTime: Date.now(),
    };

    operations = [...operations, operation];
    showProgressDialog = true;

    return operation;
  }

  /** Update operation progress */
  function updateProgress(
    operationId: string,
    progress: number,
    bytesProcessed?: number,
    totalBytes?: number
  ): void {
    operations = operations.map((op) =>
      op.id === operationId
        ? {
            ...op,
            progress: Math.min(100, Math.max(0, progress)),
            bytesProcessed,
            totalBytes,
          }
        : op
    );
  }

  /** Complete an operation */
  function completeOperation(operationId: string): void {
    operations = operations.map((op) =>
      op.id === operationId
        ? { ...op, status: "completed", progress: 100 }
        : op
    );

    // Auto-hide dialog after delay if all operations complete
    setTimeout(() => {
      if (operations.every((op) => op.status === "completed" || op.status === "cancelled")) {
        cleanupCompletedOperations();
      }
    }, 2000);
  }

  /** Mark operation as error */
  function failOperation(operationId: string, error: string): void {
    operations = operations.map((op) =>
      op.id === operationId
        ? { ...op, status: "error", error }
        : op
    );
  }

  /** Cancel an operation */
  function cancelOperation(operationId: string): void {
    operations = operations.map((op) =>
      op.id === operationId && op.status === "running"
        ? { ...op, status: "cancelled" }
        : op
    );
  }

  /** Cancel all running operations */
  function cancelAllOperations(): void {
    operations = operations.map((op) =>
      op.status === "running"
        ? { ...op, status: "cancelled" }
        : op
    );
  }

  /** Remove completed/cancelled operations */
  function cleanupCompletedOperations(): void {
    operations = operations.filter(
      (op) => op.status === "running" || op.status === "pending"
    );

    if (operations.length === 0) {
      showProgressDialog = false;
    }
  }

  /** Clear a specific operation */
  function clearOperation(operationId: string): void {
    operations = operations.filter((op) => op.id !== operationId);

    if (operations.length === 0) {
      showProgressDialog = false;
    }
  }

  /** Hide the progress dialog */
  function hideDialog(): void {
    showProgressDialog = false;
  }

  /** Show the progress dialog */
  function openDialog(): void {
    showProgressDialog = true;
  }

  /** Check if there are active operations */
  function hasActiveOperations(): boolean {
    return operations.some((op) => op.status === "running");
  }

  return {
    get operations() {
      return operations;
    },
    get showProgressDialog() {
      return showProgressDialog;
    },
    get activeOperations() {
      return operations.filter((op) => op.status === "running");
    },
    get hasActiveOperations() {
      return hasActiveOperations();
    },
    startOperation,
    updateProgress,
    completeOperation,
    failOperation,
    cancelOperation,
    cancelAllOperations,
    cleanupCompletedOperations,
    clearOperation,
    hideDialog,
    openDialog,
  };
}

export const operationsManager = createOperationsManager();

/** Format bytes to human readable string */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/** Get operation type display label */
export function getOperationLabel(type: OperationType): string {
  switch (type) {
    case "copy":
      return "Copying";
    case "move":
      return "Moving";
    case "delete":
      return "Deleting";
  }
}
