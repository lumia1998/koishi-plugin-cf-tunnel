import { Context } from 'koishi';
import type { Config, TunnelState } from './types';
export declare class Tunnel {
    private ctx;
    private config;
    private run?;
    private pending?;
    private stopping?;
    private disposed;
    private state;
    private readonly logger;
    private readonly probeId;
    private readonly probePath;
    private readonly cache;
    private readonly onExit;
    constructor(ctx: Context, config: Config);
    private connection;
    snapshot(): TunnelState;
    private update;
    private log;
    start(minutes?: number): Promise<TunnelState>;
    private open;
    private registration;
    private checkTarget;
    private checkReady;
    private terminate;
    stop(message?: string): Promise<TunnelState>;
    dispose(): Promise<void>;
}
