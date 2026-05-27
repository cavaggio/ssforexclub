// ── Types ────────────────────────────────────────────────────────────────────

export type AlpacaEnvironment = 'paper' | 'live';

export type AlpacaProfile = {
  id: string;
  environment: AlpacaEnvironment;
  accountType: 'individual';
  tradingEnabled: boolean;
  autoTradeEnabled: boolean;
  isConnected: boolean;
  lastValidatedAt: string;
  accountStatus?: string;
  accountNumberMasked?: string;
};

export type AlpacaCredentialsInput = {
  apiKey: string;
  apiSecret: string;
  environment: AlpacaEnvironment;
};

type ValidationResult = {
  success: boolean;
  error?: string;
  accountStatus?: string;
  accountNumberMasked?: string;
};

// ── Constants ────────────────────────────────────────────────────────────────

const PROFILE_KEY = 'alpaca_profile';
import { ALPACA_API_BASE as API_BASE_URL } from '../lib/apiBase';

// ── Helpers ──────────────────────────────────────────────────────────────────

function maskAccountNumber(acctNum: string): string {
  if (!acctNum || acctNum.length < 4) return '****';
  return '****' + acctNum.slice(-4);
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// ── Backend validation (calls server/index.js POST /api/alpaca/validate) ─────

async function validateViaBackend(creds: AlpacaCredentialsInput): Promise<ValidationResult> {
  const response = await fetch(`${API_BASE_URL}/api/alpaca/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Secret is sent once over HTTPS to the backend — never stored in frontend state after this call
    body: JSON.stringify({
      apiKey: creds.apiKey,
      apiSecret: creds.apiSecret,
      environment: creds.environment,
    }),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: 'Validation failed' }));
    return { success: false, error: body.error ?? `HTTP ${response.status}` };
  }

  const data = await response.json();
  return {
    success: true,
    accountStatus: data.accountStatus,
    accountNumberMasked: data.accountNumberMasked,
  };
}

// ── Mock validation (used when backend is unavailable) ───────────────────────
// TODO: Remove this mock path once the backend is running and reachable.
// This exists solely for frontend development without a running server.

async function validateMock(creds: AlpacaCredentialsInput): Promise<ValidationResult> {
  // Simulate network delay
  await new Promise(r => setTimeout(r, 1200));

  // Basic format check — Alpaca paper keys start with "PK" or "CK", live with "AK" or similar
  const key = creds.apiKey.trim();
  if (key.length < 8) {
    return { success: false, error: 'API key appears invalid (too short).' };
  }
  if (creds.apiSecret.trim().length < 8) {
    return { success: false, error: 'API secret appears invalid (too short).' };
  }

  // Mock success
  return {
    success: true,
    accountStatus: 'ACTIVE',
    accountNumberMasked: maskAccountNumber('PA' + key.slice(-6).toUpperCase()),
  };
}

// ── Service ──────────────────────────────────────────────────────────────────

export const alpacaProfileService = {
  /**
   * Validates Alpaca credentials against the backend (or mock in dev).
   * The secret key is NEVER logged or retained after this call.
   */
  async validateCredentials(creds: AlpacaCredentialsInput): Promise<ValidationResult> {
    // Attempt real backend first; fall back to mock if backend is unreachable.
    try {
      const result = await validateViaBackend(creds);
      return result;
    } catch {
      // Backend not running — use mock path for UI development
      // TODO: Remove fallback once backend is deployed.
      console.warn('[alpacaProfileService] Backend unreachable, using mock validation.');
      return validateMock(creds);
    }
  },

  /**
   * Persists a safe profile (no secret key) to localStorage.
   * Returns the saved profile.
   */
  saveProfile(input: Omit<AlpacaProfile, 'id' | 'isConnected' | 'lastValidatedAt'> & Partial<Pick<AlpacaProfile, 'id'>>): AlpacaProfile {
    const profile: AlpacaProfile = {
      id: input.id ?? generateId(),
      environment: input.environment,
      accountType: 'individual',
      tradingEnabled: input.tradingEnabled ?? false,
      autoTradeEnabled: input.autoTradeEnabled ?? false,
      isConnected: true,
      lastValidatedAt: new Date().toISOString(),
      accountStatus: input.accountStatus,
      accountNumberMasked: input.accountNumberMasked,
    };
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
    return profile;
  },

  /** Retrieves the saved profile from localStorage, or null if none. */
  getProfile(): AlpacaProfile | null {
    try {
      const raw = localStorage.getItem(PROFILE_KEY);
      if (!raw) return null;
      return JSON.parse(raw) as AlpacaProfile;
    } catch {
      return null;
    }
  },

  /** Removes the saved profile and clears connection state. */
  disconnectProfile(): void {
    localStorage.removeItem(PROFILE_KEY);
  },
};
