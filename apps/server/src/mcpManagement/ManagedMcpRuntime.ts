/** Resolved on the server, including sensitive values omitted from catalog snapshots. */
export type ManagedMcpRuntimeServer = {
  readonly id: string;
  readonly enabled: boolean;
  readonly transport:
    | {
        readonly type: "stdio";
        readonly command: string;
        readonly args: ReadonlyArray<string>;
        readonly env: Readonly<Record<string, string>>;
        readonly cwd?: string;
      }
    | {
        readonly type: "http";
        readonly url: string;
        readonly headers: Readonly<Record<string, string>>;
      };
};

export interface ManagedMcpRuntimeConfig {
  readonly revision: number;
  readonly servers: ReadonlyArray<ManagedMcpRuntimeServer>;
}
