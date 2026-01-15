/**
 * Application configuration.
 * Centralizes environment-dependent settings.
 */

// In Vite, environment variables are accessed via import.meta.env
// For Tauri apps, we use a consistent port for the Python backend
const DEFAULT_API_PORT = 8008;

function getApiBaseUrl(): string {
  // Check for environment override (useful for testing)
  if (typeof import.meta !== "undefined" && import.meta.env?.VITE_API_URL) {
    return import.meta.env.VITE_API_URL;
  }

  // Default: localhost with standard port
  return `http://127.0.0.1:${DEFAULT_API_PORT}/api`;
}

export const config = {
  apiBaseUrl: getApiBaseUrl(),
} as const;
