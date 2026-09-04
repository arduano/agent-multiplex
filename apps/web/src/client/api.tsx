import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type PropsWithChildren,
} from "react";

import {
  createAccessClient,
  type AccessClient,
  type AccessClientHandle,
} from "@arduano/agent-multiplex-client/browser";

interface ApiContextValue {
  readonly client: AccessClient;
  readonly connectionKey: number;
}

const ApiContext = createContext<ApiContextValue | null>(null);

export interface ApiProviderProps extends PropsWithChildren {
  readonly token: string;
  readonly connectionKey: number;
  readonly enableWebSocket?: boolean;
}

export function ApiProvider({ token, connectionKey, enableWebSocket = true, children }: ApiProviderProps) {
  const handle = useMemo<AccessClientHandle>(() => {
    const httpUrl = new URL("/trpc", window.location.href).toString();
    const wsUrl = new URL(httpUrl);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    return createAccessClient({
      httpUrl,
      ...(enableWebSocket ? { wsUrl: wsUrl.toString() } : {}),
      ...(token ? { bearerToken: token } : {}),
    });
  }, [token, connectionKey, enableWebSocket]);

  useEffect(() => () => handle.close(), [handle]);

  const value = useMemo(
    () => ({ client: handle.client, connectionKey }),
    [handle.client, connectionKey],
  );
  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
}

export function useApi(): ApiContextValue {
  const value = useContext(ApiContext);
  if (!value) throw new Error("useApi must be rendered inside ApiProvider");
  return value;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "Unexpected gateway error";
}
