export const openApiDocument = {
  openapi: "3.0.3",
  info: {
    title: "swarm-llm coordinator API",
    version: "0.1.0",
    description:
      "Federated LLM inference coordinator: node/peer registry, capacity " +
      "tracking, model catalog gating, safety classification, reputation, " +
      "and locality grouping. Does not yet expose an inference-request " +
      "endpoint -- no request-routing system exists in this repo yet.",
  },
  paths: {
    "/nodes/register": {
      post: {
        summary: "Register a node",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["endpoint", "deviceTier"],
                properties: {
                  endpoint: { type: "string" },
                  deviceTier: { type: "string", enum: ["desktop", "android", "ios"] },
                  localityGroup: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Registered", content: { "application/json": { schema: { type: "object", properties: { nodeId: { type: "string" } } } } } },
          "400": { description: "Invalid request body" },
        },
      },
    },
    "/nodes/{nodeId}/heartbeat": {
      post: {
        summary: "Refresh a node's liveness",
        responses: { "204": { description: "Heartbeat accepted" }, "404": { description: "Unknown nodeId" } },
      },
    },
    "/nodes/{nodeId}/reputation/agree": {
      post: {
        summary: "Record that a node's output agreed with a redundant spot-check",
        responses: { "204": { description: "Recorded" }, "404": { description: "Unknown nodeId" } },
      },
    },
    "/nodes/{nodeId}/reputation/disagree": {
      post: {
        summary: "Record that a node's output disagreed with a redundant spot-check",
        responses: { "204": { description: "Recorded" }, "404": { description: "Unknown nodeId" } },
      },
    },
    "/nodes/{nodeId}/reputation": {
      get: {
        summary: "Get a node's reputation stats",
        responses: {
          "200": {
            description: "Reputation stats",
            content: { "application/json": { schema: { type: "object", properties: { agreements: { type: "integer" }, disagreements: { type: "integer" }, trusted: { type: "boolean" } } } } },
          },
          "404": { description: "Unknown nodeId" },
        },
      },
    },
    "/nodes": {
      get: {
        summary: "List currently active nodes",
        responses: { "200": { description: "Active nodes", content: { "application/json": { schema: { type: "array" } } } } },
      },
    },
    "/nodes/locality": {
      get: {
        summary: "List active nodes grouped by self-reported locality",
        responses: { "200": { description: "Nodes grouped by locality group", content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/capacity": {
      get: {
        summary: "This instance's active node count (used by federated peers)",
        responses: { "200": { description: "Capacity", content: { "application/json": { schema: { type: "object", properties: { activeNodes: { type: "integer" } } } } } } },
      },
    },
    "/peers/register": {
      post: {
        summary: "Register a federated peer coordinator instance",
        requestBody: {
          content: { "application/json": { schema: { type: "object", required: ["endpoint"], properties: { endpoint: { type: "string", format: "uri" } } } } },
        },
        responses: {
          "200": { description: "Registered", content: { "application/json": { schema: { type: "object", properties: { peerId: { type: "string" } } } } } },
          "400": { description: "Invalid endpoint" },
        },
      },
    },
    "/peers/{peerId}/heartbeat": {
      post: {
        summary: "Refresh a peer's liveness",
        responses: { "204": { description: "Heartbeat accepted" }, "404": { description: "Unknown peerId" } },
      },
    },
    "/peers": {
      get: {
        summary: "List currently active peers",
        responses: { "200": { description: "Active peers", content: { "application/json": { schema: { type: "array" } } } } },
      },
    },
    "/peers/{peerId}": {
      delete: {
        summary: "Deregister a peer",
        responses: { "204": { description: "Deregistered" }, "404": { description: "Unknown peerId" } },
      },
    },
    "/catalog": {
      get: {
        summary: "List models with availability gated on active node count (local + federated)",
        responses: { "200": { description: "Catalog", content: { "application/json": { schema: { type: "array" } } } } },
      },
    },
    "/classify": {
      post: {
        summary: "Safety-classify a prompt (does not run inference; shipped classifier has zero rules by default)",
        requestBody: {
          content: { "application/json": { schema: { type: "object", required: ["prompt"], properties: { prompt: { type: "string" } } } } },
        },
        responses: {
          "200": { description: "Classification result", content: { "application/json": { schema: { type: "object", properties: { safe: { type: "boolean" }, categories: { type: "array", items: { type: "string" } } } } } } },
          "400": { description: "Invalid request body" },
        },
      },
    },
  },
};
