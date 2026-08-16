export class SwarmClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private async postJson(path: string, body: unknown): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async registerNode(endpoint: string, deviceTier: "desktop" | "android" | "ios", localityGroup?: string): Promise<string> {
    const res = await this.postJson("/nodes/register", { endpoint, deviceTier, localityGroup });
    if (!res.ok) {
      throw new Error(`registerNode failed: ${res.status}`);
    }
    const body = await res.json();
    return body.nodeId;
  }

  async heartbeat(nodeId: string): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/nodes/${nodeId}/heartbeat`, { method: "POST" });
    return res.status === 204;
  }

  async recordAgreement(nodeId: string): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/nodes/${nodeId}/reputation/agree`, { method: "POST" });
    return res.status === 204;
  }

  async recordDisagreement(nodeId: string): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/nodes/${nodeId}/reputation/disagree`, { method: "POST" });
    return res.status === 204;
  }

  async getReputation(nodeId: string): Promise<{ agreements: number; disagreements: number; trusted: boolean } | null> {
    const res = await fetch(`${this.baseUrl}/nodes/${nodeId}/reputation`);
    if (res.status === 404) {
      return null;
    }
    return res.json();
  }

  async listNodes(): Promise<unknown[]> {
    const res = await fetch(`${this.baseUrl}/nodes`);
    return res.json();
  }

  async listNodesByLocality(): Promise<Record<string, unknown[]>> {
    const res = await fetch(`${this.baseUrl}/nodes/locality`);
    return res.json();
  }

  async getCapacity(): Promise<number> {
    const res = await fetch(`${this.baseUrl}/capacity`);
    const body = await res.json();
    return body.activeNodes;
  }

  async registerPeer(endpoint: string): Promise<string> {
    const res = await this.postJson("/peers/register", { endpoint });
    if (!res.ok) {
      throw new Error(`registerPeer failed: ${res.status}`);
    }
    const body = await res.json();
    return body.peerId;
  }

  async peerHeartbeat(peerId: string): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/peers/${peerId}/heartbeat`, { method: "POST" });
    return res.status === 204;
  }

  async listPeers(): Promise<unknown[]> {
    const res = await fetch(`${this.baseUrl}/peers`);
    return res.json();
  }

  async deregisterPeer(peerId: string): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/peers/${peerId}`, { method: "DELETE" });
    return res.status === 204;
  }

  async getCatalog(): Promise<unknown[]> {
    const res = await fetch(`${this.baseUrl}/catalog`);
    return res.json();
  }

  async classify(prompt: string): Promise<{ safe: boolean; categories: string[] }> {
    const res = await this.postJson("/classify", { prompt });
    return res.json();
  }
}
