/** A private loopback hop, so local Koishi traffic never resets the tunnel's idle clock. */
export declare class TrafficProxy {
    private probePath;
    private probeId;
    private readonly server;
    private readonly sockets;
    private readonly target;
    private opening?;
    private closed?;
    lastActivityAt: number;
    requests: number;
    bytesIn: number;
    bytesOut: number;
    constructor(target: string, probePath: string, probeId: string, onError: (error: Error) => void);
    private track;
    private touch;
    listen(signal: AbortSignal): Promise<string>;
    close(): Promise<void>;
}
