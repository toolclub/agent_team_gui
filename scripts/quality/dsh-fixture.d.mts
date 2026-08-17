/** Type surface used by the quality-script regression tests. */
export declare class DshWebFixture {
  baseUrl: string | undefined
  rpcCounter: number
  timeoutMs: number
  rpc(endpoint: string, payload?: unknown): Promise<unknown>
  officialRpc(method: string, payload?: unknown): Promise<unknown>
  createBrowserSession(): Promise<string>
  engageBrowserSession(sessionId: string): Promise<void>
}
