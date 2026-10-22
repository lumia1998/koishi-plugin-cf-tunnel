import type { Config } from './types';
export declare const VERSION = "2026.10.0";
export declare function resolveBinary(config: Config, cacheRoot: string, signal: AbortSignal, log: (text: string) => void): Promise<string>;
