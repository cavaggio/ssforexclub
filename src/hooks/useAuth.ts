import { useState, useEffect } from 'react';
import { alpacaApi } from '../services/alpacaApi';
import type { LoginResponse } from '../services/alpacaApi';

interface User {
  id: number;
  username: string;
  hasAlpacaCredentials: boolean;
}

export const useAuth = () => {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const login = async (username: string, password: string): Promise<boolean> => {
    try {
      const response: LoginResponse = await alpacaApi.login(username, password);
      setUser(response.user);
      localStorage.setItem('user', JSON.stringify(response.user));
      return true;
    } catch (error) {
      console.error('Login failed:', error);
      return false;
    }
  };

  const logout = () => {
    alpacaApi.logout();
    setUser(null);
    localStorage.removeItem('user');
  };

  const updateUserCredentials = (hasAlpacaCredentials: boolean) => {
    if (user) {
      const updatedUser = { ...user, hasAlpacaCredentials };
      setUser(updatedUser);
      localStorage.setItem('user', JSON.stringify(updatedUser));
    }
  };

  useEffect(() => {
    const storedUser = localStorage.getItem('user');
    if (storedUser) {
      setUser(JSON.parse(storedUser));
    }
    setIsLoading(false);
  }, []);

  return { user, login, logout, updateUserCredentials, isLoading };
};