export class SwarmClient {
  private readonly baseUrl: string;
  private readonly authToken: string;

  constructor(baseUrl: string, authToken: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.authToken = authToken;
  }

  private authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return { ...extra, authorization: `Bearer ${this.authToken}` };
  }

  // Used by the boolean-returning methods below (heartbeat, recordAgreement,
  // recordDisagreement, peerHeartbeat, deregisterPeer). Those answer a
  // found/not-found question -- true for 204, false otherwise -- but a 401
  // is not an answer to that question at all: the request never got far
  // enough to have one. Collapsing it into `false` made an auth failure
  // indistinguishable from "that id isn't registered", so a node agent
  // holding a stale token would read its own 401 as "the coordinator forgot
  // me" and re-register forever, and a caller could never tell the two
  // apart. Only 401 is promoted to a throw here; every other status keeps
  // the documented true-if-204/false-otherwise contract those five methods
  // were built around, since widening that is a bigger API decision than
  // this fix round should make unilaterally.
  private async throwIfUnauthorized(res: Response, methodName: string): Promise<void> {
    if (res.status === 401) {
      const detail = await res.text();
      throw new Error(`${methodName} failed: 401 ${detail}`);
    }
  }

  private async postJson(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(body),
      signal,
    });
  }

  async registerNode(
    endpoint: string,
    deviceTier: "desktop" | "android" | "ios",
    localityGroup?: string,
    servesModel?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const res = await this.postJson("/nodes/register", { endpoint, deviceTier, localityGroup, servesModel }, signal);
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`registerNode failed: ${res.status} ${detail}`);
    }
    const body = await res.json();
    return body.nodeId;
  }

  async generate(prompt: string, modelId: string, n_predict?: number, signal?: AbortSignal): Promise<{ text: string }> {
    const res = await this.postJson("/generate", { prompt, modelId, n_predict }, signal);
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`generate failed: ${res.status} ${detail}`);
    }
    return res.json();
  }

  // Yields one generated text piece per SSE "data: ..." frame the
  // coordinator relays, in order, as they arrive -- does not buffer the
  // whole reply before the caller sees anything. Throws if the stream
  // emits an "event: error" frame (with that frame's message), or if the
  // initial request itself fails before any streaming could begin.
  // A trailing "data: [DONE]\n\n" frame marks a successful stream's end --
  // it is a terminal sentinel, not generated text, and is never yielded.
  async *generateStream(prompt: string, modelId: string, n_predict?: number, signal?: AbortSignal): AsyncGenerator<string> {
    const res = await this.postJson("/generate", { prompt, modelId, n_predict, stream: true }, signal);
    if (!res.ok || !res.body) {
      const detail = await res.text();
      throw new Error(`generateStream failed: ${res.status} ${detail}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? ""; // the last element may be an incomplete frame -- keep it for the next read
      for (const frame of frames) {
        if (frame.startsWith("event: error")) {
          const dataLine = frame.split("\n").find(line => line.startsWith("data: "));
          const message = dataLine ? JSON.parse(dataLine.slice("data: ".length)).error : "generation failed mid-stream";
          throw new Error(`generateStream failed mid-stream: ${message}`);
        }
        const dataLines = frame.split("\n").filter(line => line.startsWith("data: "));
        if (dataLines.length === 0) {
          continue;
        }
        const text = dataLines.map(line => line.slice("data: ".length)).join("\n");
        if (text === "[DONE]") {
          return; // terminal sentinel -- stream is complete, not literal generated text
        }
        yield text;
      }
    }
  }

  async heartbeat(nodeId: string, signal?: AbortSignal): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/nodes/${nodeId}/heartbeat`, { method: "POST", headers: this.authHeaders(), signal });
    await this.throwIfUnauthorized(res, "heartbeat");
    return res.status === 204;
  }

  async recordAgreement(nodeId: string, signal?: AbortSignal): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/nodes/${nodeId}/reputation/agree`, { method: "POST", headers: this.authHeaders(), signal });
    await this.throwIfUnauthorized(res, "recordAgreement");
    return res.status === 204;
  }

  async recordDisagreement(nodeId: string, signal?: AbortSignal): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/nodes/${nodeId}/reputation/disagree`, { method: "POST", headers: this.authHeaders(), signal });
    await this.throwIfUnauthorized(res, "recordDisagreement");
    return res.status === 204;
  }

  async getReputation(nodeId: string, signal?: AbortSignal): Promise<{ agreements: number; disagreements: number; trusted: boolean } | null> {
    const res = await fetch(`${this.baseUrl}/nodes/${nodeId}/reputation`, { headers: this.authHeaders(), signal });
    if (res.status === 404) {
      return null;
    }
    // Anything other than 404 or a real 200 must throw, matching
    // listNodes/getCapacity/etc. Blindly returning res.json() here meant a
    // 401 body -- { error: "missing or invalid Authorization header" } --
    // was handed back typed as a reputation record, so a caller reading
    // `.trusted` got `undefined` (falsy: "not trusted") from a request that
    // never actually consulted the reputation ledger at all.
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`getReputation failed: ${res.status} ${detail}`);
    }
    return res.json();
  }

  async listNodes(signal?: AbortSignal): Promise<unknown[]> {
    const res = await fetch(`${this.baseUrl}/nodes`, { headers: this.authHeaders(), signal });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`listNodes failed: ${res.status} ${detail}`);
    }
    return res.json();
  }

  async listNodesByLocality(signal?: AbortSignal): Promise<Record<string, unknown[]>> {
    const res = await fetch(`${this.baseUrl}/nodes/locality`, { headers: this.authHeaders(), signal });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`listNodesByLocality failed: ${res.status} ${detail}`);
    }
    return res.json();
  }

  async getCapacity(signal?: AbortSignal): Promise<number> {
    const res = await fetch(`${this.baseUrl}/capacity`, { headers: this.authHeaders(), signal });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`getCapacity failed: ${res.status} ${detail}`);
    }
    const body = await res.json();
    return body.activeNodes;
  }

  async registerPeer(endpoint: string, signal?: AbortSignal): Promise<string> {
    const res = await this.postJson("/peers/register", { endpoint }, signal);
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`registerPeer failed: ${res.status} ${detail}`);
    }
    const body = await res.json();
    return body.peerId;
  }

  async peerHeartbeat(peerId: string, signal?: AbortSignal): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/peers/${peerId}/heartbeat`, { method: "POST", headers: this.authHeaders(), signal });
    await this.throwIfUnauthorized(res, "peerHeartbeat");
    return res.status === 204;
  }

  async listPeers(signal?: AbortSignal): Promise<unknown[]> {
    const res = await fetch(`${this.baseUrl}/peers`, { headers: this.authHeaders(), signal });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`listPeers failed: ${res.status} ${detail}`);
    }
    return res.json();
  }

  async deregisterPeer(peerId: string, signal?: AbortSignal): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/peers/${peerId}`, { method: "DELETE", headers: this.authHeaders(), signal });
    await this.throwIfUnauthorized(res, "deregisterPeer");
    return res.status === 204;
  }

  async getCatalog(signal?: AbortSignal): Promise<unknown[]> {
    const res = await fetch(`${this.baseUrl}/catalog`, { headers: this.authHeaders(), signal });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`getCatalog failed: ${res.status} ${detail}`);
    }
    return res.json();
  }

  async classify(prompt: string, signal?: AbortSignal): Promise<{ safe: boolean; categories: string[] }> {
    const res = await this.postJson("/classify", { prompt }, signal);
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`classify failed: ${res.status} ${detail}`);
    }
    return res.json();
  }
}
