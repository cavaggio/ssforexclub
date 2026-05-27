const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

export interface LoginResponse {
  token: string;
  user: {
    id: number;
    username: string;
    hasAlpacaCredentials: boolean;
  };
}

export interface AlpacaAccount {
  accountNumber: string;
  buyingPower: number;
  cash: number;
  portfolioValue: number;
  daytradeCount: number;
  status: string;
  tradingBlocked: boolean;
  transfersBlocked: boolean;
  accountBlocked: boolean;
  patternDayTrader: boolean;
}

export interface AlpacaPosition {
  symbol: string;
  qty: number;
  marketValue: number;
  costBasis: number;
  unrealizedPL: number;
  unrealizedPLPercent: number;
  side: string;
  avgEntryPrice: number;
}

export interface AlpacaOrder {
  id: string;
  symbol: string;
  qty: number;
  side: string;
  orderType: string;
  timeInForce: string;
  status: string;
  filledQty: number;
  filledAvgPrice: number;
  submittedAt: string;
  filledAt?: string;
}

export interface OrderRequest {
  symbol: string;
  qty: number;
  side: 'buy' | 'sell';
  type?: 'market' | 'limit' | 'stop';
  timeInForce?: 'day' | 'gtc' | 'ioc' | 'fok';
  limitPrice?: number;
  stopPrice?: number;
}

class AlpacaApiService {
  private token: string | null = null;

  constructor() {
    this.token = localStorage.getItem('authToken');
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${API_BASE_URL}${endpoint}`;
    
    const config: RequestInit = {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(this.token && { Authorization: `Bearer ${this.token}` }),
        ...options.headers,
      },
    };

    try {
      const response = await fetch(url, config);
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      console.error(`API request failed: ${endpoint}`, error);
      throw error;
    }
  }

  // Authentication
  async login(username: string, password: string): Promise<LoginResponse> {
    const response = await this.request<LoginResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });

    this.token = response.token;
    localStorage.setItem('authToken', response.token);
    
    return response;
  }

  logout(): void {
    this.token = null;
    localStorage.removeItem('authToken');
  }

  // Alpaca Credentials
  async setAlpacaCredentials(apiKey: string, secretKey: string, paperTrading: boolean = true): Promise<void> {
    await this.request('/api/alpaca/credentials', {
      method: 'POST',
      body: JSON.stringify({ apiKey, secretKey, paperTrading }),
    });
  }

  // Account Information
  async getAccount(): Promise<AlpacaAccount> {
    return this.request<AlpacaAccount>('/api/alpaca/account');
  }

  // Positions
  async getPositions(): Promise<AlpacaPosition[]> {
    return this.request<AlpacaPosition[]>('/api/alpaca/positions');
  }

  // Orders
  async getOrders(): Promise<AlpacaOrder[]> {
    return this.request<AlpacaOrder[]>('/api/alpaca/orders');
  }

  async placeOrder(orderData: OrderRequest): Promise<AlpacaOrder> {
    return this.request<AlpacaOrder>('/api/alpaca/orders', {
      method: 'POST',
      body: JSON.stringify(orderData),
    });
  }

  // Market Data
  async getQuote(symbol: string): Promise<{ symbol: string; price: number; timestamp: string }> {
    return this.request<{ symbol: string; price: number; timestamp: string }>(`/api/alpaca/quotes/${symbol}`);
  }

  // Health Check
  async healthCheck(): Promise<{ status: string; timestamp: string }> {
    return this.request('/api/health');
  }
}

export const alpacaApi = new AlpacaApiService();