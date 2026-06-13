/**
 * Operations state management for progress tracking.
 * Issue: tauri-explorer-5kv
 *
 * Manages file operations (copy, move, delete) with progress tracking,
 * cancellation support, and error handling.
 */

export type OperationType = "copy" | "move" | "delete" | "compress";

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
  retryHandler?: () => Promise<void>;
}

function generateOperationId(): string {
  return `op-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const DIALOG_DELAY_MS = 1500;

/** How long a cancelled id stays observable for in-flight workers before
 *  being dropped (prevents unbounded growth of the cancelled set). */
const CANCELLED_ID_TTL_MS = 60_000;

function createOperationsManager() {
  let operations = $state<Operation[]>([]);
  let showProgressDialog = $state(false);
  let dialogTimerId: ReturnType<typeof setTimeout> | null = null;
  // Tracks ids that were cancelled so in-flight workers can still see the
  // cancellation after the row has been removed from the visible list.
  // Entries expire after CANCELLED_ID_TTL_MS so the set can't grow unbounded.
  const cancelledIds = new Set<string>();

  function markCancelled(operationId: string): void {
    cancelledIds.add(operationId);
    setTimeout(() => cancelledIds.delete(operationId), CANCELLED_ID_TTL_MS);
  }

  function closeDialogIfEmpty(): void {
    if (operations.length === 0) {
      if (dialogTimerId) {
        clearTimeout(dialogTimerId);
        dialogTimerId = null;
      }
      showProgressDialog = false;
    }
  }

  /** Start a new operation */
  function startOperation(
    type: OperationType,
    sourcePath: string,
    destPath?: string,
    retryHandler?: () => Promise<void>
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
      retryHandler,
    };

    operations = [...operations, operation];

    // Only show progress dialog if the operation takes longer than the delay
    if (!showProgressDialog && !dialogTimerId) {
      dialogTimerId = setTimeout(() => {
        dialogTimerId = null;
        if (operations.some((op) => op.status === "running")) {
          showProgressDialog = true;
        }
      }, DIALOG_DELAY_MS);
    }

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

  /** Mark operation as error — show dialog immediately so user sees the error */
  function failOperation(operationId: string, error: string): void {
    operations = operations.map((op) =>
      op.id === operationId
        ? { ...op, status: "error", error }
        : op
    );
    showProgressDialog = true;
  }

  /** Retry a failed operation */
  async function retryOperation(operationId: string): Promise<void> {
    const op = operations.find((o) => o.id === operationId);
    if (!op || op.status !== "error" || !op.retryHandler) return;

    operations = operations.map((o) =>
      o.id === operationId
        ? { ...o, status: "running", progress: 0, error: undefined }
        : o
    );

    try {
      await op.retryHandler();
    } catch (err) {
      failOperation(operationId, String(err));
    }
  }

  /** Cancel an operation. Removes it from the list immediately so the
   * progress dialog dismisses without lingering. In-flight worker code
   * still observes the cancelled status via `isOperationCancelled` because
   * we keep the id reachable through a short-lived cancelled set. */
  function cancelOperation(operationId: string): void {
    markCancelled(operationId);
    operations = operations.filter((op) => op.id !== operationId);
    closeDialogIfEmpty();
  }

  /** Check if an operation has been cancelled */
  function isOperationCancelled(operationId: string): boolean {
    return cancelledIds.has(operationId);
  }

  /** Cancel all running operations and dismiss the progress dialog. */
  function cancelAllOperations(): void {
    for (const op of operations) {
      if (op.status === "running") markCancelled(op.id);
    }
    operations = operations.filter((op) => op.status !== "running");
    closeDialogIfEmpty();
  }

  /** Remove completed/cancelled operations */
  function cleanupCompletedOperations(): void {
    for (const op of operations) {
      if (op.status !== "running" && op.status !== "pending") {
        cancelledIds.delete(op.id);
      }
    }
    operations = operations.filter(
      (op) => op.status === "running" || op.status === "pending"
    );
    closeDialogIfEmpty();
  }

  /** Clear a specific operation */
  function clearOperation(operationId: string): void {
    cancelledIds.delete(operationId);
    operations = operations.filter((op) => op.id !== operationId);
    closeDialogIfEmpty();
  }

  /** Hide the progress dialog */
  function hideDialog(): void {
    if (dialogTimerId) {
      clearTimeout(dialogTimerId);
      dialogTimerId = null;
    }
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
    retryOperation,
    cancelOperation,
    isOperationCancelled,
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
    case "compress":
      return "Compressing";
  }
}
