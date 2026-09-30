import type { ServerResponse } from "node:http";

/** End long-lived responses before HTTP shutdown waits for connections. */
export class EventStreams {
  private closing = false;
  private readonly streams = new Map<ServerResponse, () => void>();

  track(response: ServerResponse, cleanup: () => void): void {
    let cleaned = false;
    const dispose = () => {
      if (cleaned) return;
      cleaned = true;
      this.streams.delete(response);
      cleanup();
    };
    response.once("close", dispose);
    if (this.closing) {
      dispose();
      response.end();
      return;
    }
    this.streams.set(response, dispose);
  }

  close(): void {
    this.closing = true;
    for (const [response, dispose] of this.streams) {
      dispose();
      response.end();
    }
  }
}
