export interface AccessTokenProvider {
  getAccessToken(): Promise<string>;
  invalidate(): void;
}
