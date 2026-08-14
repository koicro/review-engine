import {
  useCallback,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { ApiClient, ApiError } from './client';

const BASE_URL_KEY = 'review-engine.api-base';

export interface ApiSettings {
  baseUrl: string;
}

export type SessionStatus = 'checking' | 'authenticated' | 'unauthenticated' | 'unavailable';

interface ApiContextValue {
  api: ApiClient;
  settings: ApiSettings;
  sessionStatus: SessionStatus;
  signIn: (baseUrl: string, token: string) => Promise<void>;
  signOut: () => Promise<void>;
  checkSession: () => Promise<void>;
}

const ApiContext = createContext<ApiContextValue | null>(null);

function initialSettings(): ApiSettings {
  if (typeof window === 'undefined') return { baseUrl: '/api/v1' };
  return {
    baseUrl: window.localStorage.getItem(BASE_URL_KEY) || '/api/v1',
  };
}

function statusFor(error: unknown): SessionStatus {
  return error instanceof ApiError && (error.status === 401 || error.status === 403)
    ? 'unauthenticated'
    : 'unavailable';
}

export function ApiProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<ApiSettings>(initialSettings);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>('checking');
  const markUnauthorized = useCallback(() => setSessionStatus('unauthenticated'), []);
  const api = useMemo(
    () => new ApiClient({ baseUrl: settings.baseUrl, onUnauthorized: markUnauthorized }),
    [markUnauthorized, settings.baseUrl],
  );

  useEffect(() => {
    let active = true;
    api.verifySession()
      .then(() => { if (active) setSessionStatus('authenticated'); })
      .catch((error) => { if (active) setSessionStatus(statusFor(error)); });
    return () => { active = false; };
  }, [api]);

  async function signIn(baseUrl: string, token: string) {
    const cleanBaseUrl = baseUrl.trim() || '/api/v1';
    setSessionStatus('checking');
    const candidate = new ApiClient({ baseUrl: cleanBaseUrl, onUnauthorized: markUnauthorized });
    try {
      await candidate.createSession(token);
      await candidate.verifySession();
      window.localStorage.setItem(BASE_URL_KEY, cleanBaseUrl);
      setSettings({ baseUrl: cleanBaseUrl });
      setSessionStatus('authenticated');
    } catch (error) {
      setSessionStatus(statusFor(error));
      throw error;
    }
  }

  async function signOut() {
    await api.deleteSession();
    setSessionStatus('unauthenticated');
  }

  async function checkSession() {
    setSessionStatus('checking');
    try {
      await api.verifySession();
      setSessionStatus('authenticated');
    } catch (error) {
      setSessionStatus(statusFor(error));
      throw error;
    }
  }

  return (
    <ApiContext.Provider value={{ api, settings, sessionStatus, signIn, signOut, checkSession }}>
      {children}
    </ApiContext.Provider>
  );
}

export function useApi() {
  const value = useContext(ApiContext);
  if (!value) throw new Error('useApi must be used inside ApiProvider');
  return value;
}
