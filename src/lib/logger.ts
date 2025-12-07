import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';

/**
 * Log levels for the application logger
 */
export type LogLevel = 'debug' | 'info' | 'warning' | 'error';

/**
 * Log a message to the application logs (shown in Logs tab)
 */
export async function log(
  level: LogLevel,
  message: string,
  sessionId?: string
): Promise<void> {
  try {
    await invoke('add_log', {
      level,
      message,
      sessionId: sessionId ?? null,
    });
  } catch (e) {
    console.error('Failed to add log:', e);
  }
}

/**
 * Log an info message
 */
export async function logInfo(message: string, sessionId?: string): Promise<void> {
  await log('info', message, sessionId);
}

/**
 * Log a debug message
 */
export async function logDebug(message: string, sessionId?: string): Promise<void> {
  await log('debug', message, sessionId);
}

/**
 * Log a warning message
 */
export async function logWarning(message: string, sessionId?: string): Promise<void> {
  await log('warning', message, sessionId);
}

/**
 * Log an error message
 */
export async function logError(message: string, sessionId?: string): Promise<void> {
  await log('error', message, sessionId);
}

/**
 * Show a toast and log an error message
 */
export async function toastError(message: string, sessionId?: string): Promise<void> {
  toast.error(message);
  await logError(message, sessionId);
}

/**
 * Show a toast and log an info message
 */
export async function toastInfo(message: string, sessionId?: string): Promise<void> {
  toast.info(message);
  await logInfo(message, sessionId);
}

/**
 * Show a toast and log a success message
 */
export async function toastSuccess(message: string, sessionId?: string): Promise<void> {
  toast.success(message);
  await logInfo(message, sessionId);
}
