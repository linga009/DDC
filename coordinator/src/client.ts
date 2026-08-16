export class SwarmClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private async postJson(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  }

  async registerNode(endpoint: string, deviceTier: "desktop" | "android" | "ios", localityGroup?: string, signal?: AbortSignal): Promise<string> {
    const res = await this.postJson("/nodes/register", { endpoint, deviceTier, localityGroup }, signal);
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`registerNode failed: ${res.status} ${detail}`);
    }
    const body = await res.json();
    return body.nodeId;
  }

  async heartbeat(nodeId: string, signal?: AbortSignal): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/nodes/${nodeId}/heartbeat`, { method: "POST", signal });
    return res.status === 204;
  }

  async recordAgreement(nodeId: string, signal?: AbortSignal): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/nodes/${nodeId}/reputation/agree`, { method: "POST", signal });
    return res.status === 204;
  }

  async recordDisagreement(nodeId: string, signal?: AbortSignal): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/nodes/${nodeId}/reputation/disagree`, { method: "POST", signal });
    return res.status === 204;
  }

  async getReputation(nodeId: string, signal?: AbortSignal): Promise<{ agreements: number; disagreements: number; trusted: boolean } | null> {
    const res = await fetch(`${this.baseUrl}/nodes/${nodeId}/reputation`, { signal });
    if (res.status === 404) {
      return null;
    }
    return res.json();
  }

  async listNodes(signal?: AbortSignal): Promise<unknown[]> {
    const res = await fetch(`${this.baseUrl}/nodes`, { signal });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`listNodes failed: ${res.status} ${detail}`);
    }
    return res.json();
  }

  async listNodesByLocality(signal?: AbortSignal): Promise<Record<string, unknown[]>> {
    const res = await fetch(`${this.baseUrl}/nodes/locality`, { signal });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`listNodesByLocality failed: ${res.status} ${detail}`);
    }
    return res.json();
  }

  async getCapacity(signal?: AbortSignal): Promise<number> {
    const res = await fetch(`${this.baseUrl}/capacity`, { signal });
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
    const res = await fetch(`${this.baseUrl}/peers/${peerId}/heartbeat`, { method: "POST", signal });
    return res.status === 204;
  }

  async listPeers(signal?: AbortSignal): Promise<unknown[]> {
    const res = await fetch(`${this.baseUrl}/peers`, { signal });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`listPeers failed: ${res.status} ${detail}`);
    }
    return res.json();
  }

  async deregisterPeer(peerId: string, signal?: AbortSignal): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/peers/${peerId}`, { method: "DELETE", signal });
    return res.status === 204;
  }

  async getCatalog(signal?: AbortSignal): Promise<unknown[]> {
    const res = await fetch(`${this.baseUrl}/catalog`, { signal });
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
