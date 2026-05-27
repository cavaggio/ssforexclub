// Resolves the base URL for backend API calls.
// In production, all requests go through Supabase Edge Functions.
// In local dev (no VITE_SUPABASE_URL), falls back to the local Express server.

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;

// alpaca-proxy edge function handles all /api/alpaca/* routes
export const ALPACA_API_BASE = supabaseUrl
  ? `${supabaseUrl}/functions/v1/alpaca-proxy`
  : (import.meta.env.VITE_API_URL || 'http://localhost:3001');

// claude-advisor edge function handles all /api/claude/* routes
export const CLAUDE_API_BASE = supabaseUrl
  ? `${supabaseUrl}/functions/v1/claude-advisor`
  : (import.meta.env.VITE_API_URL || 'http://localhost:3001');
