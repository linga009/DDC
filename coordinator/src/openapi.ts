// Every operation in this document requires the shared bearer token, so
// every one of them can answer 401. Defined once and referenced from each
// operation's `responses` rather than repeated inline: this is a
// hand-written document, and fifteen copies of the same block is fifteen
// chances for them to drift apart.
const UNAUTHORIZED_RESPONSE = {
  description:
    "Missing or invalid Authorization header. Every endpoint in this document requires " +
    "`Authorization: Bearer <SWARM_AUTH_TOKEN>`; only the static dashboard routes and this " +
    "OpenAPI document itself are reachable without it. The response carries " +
    "`WWW-Authenticate: Bearer`.",
  content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } },
};

export const openApiDocument = {
  openapi: "3.0.3",
  info: {
    title: "swarm-llm coordinator API",
    version: "0.1.0",
    description:
      "Federated LLM inference coordinator: node/peer registry, capacity " +
      "tracking, model catalog gating, safety classification, reputation, " +
      "locality grouping, and request routing. POST /generate is the " +
      "first inference-request endpoint in this repo -- it classifies a " +
      "prompt, routes it to a single active node whose self-reported " +
      "servesModel matches (reputation-ranked with a random tie-break " +
      "among equal scores, no locality-awareness, no retry/fallback), " +
      "and returns the generated text. Dynamic node " +
      "selection, pre-warming, and streaming are not implemented yet.\n\n" +
      "Authentication: every endpoint described here requires a shared " +
      "secret, sent as `Authorization: Bearer <token>`. The operator sets it " +
      "on the coordinator as the SWARM_AUTH_TOKEN environment variable (the " +
      "coordinator refuses to start without it) and the same one token is " +
      "used swarm-wide -- there are no per-client or per-node credentials. " +
      "Only the static dashboard routes and this document itself are " +
      "reachable unauthenticated, which is why you can read this without a " +
      "token and find out that you need one. A generated client must be " +
      "configured to send the bearer token or every call will 401. Note " +
      "that traffic is plain HTTP with no TLS, so the token crosses the " +
      "network in cleartext -- run this on a trusted LAN or behind an SSH " +
      "tunnel / WireGuard.",
  },
  // Applied document-wide rather than per-operation: the coordinator's auth
  // check runs before routing, so it is genuinely uniform across every path
  // below, and a top-level requirement is what OpenAPI codegen reads to wire
  // a token parameter into every generated method.
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        description:
          "The shared SWARM_AUTH_TOKEN, sent as `Authorization: Bearer <token>`. " +
          "Note that the coordinator matches the scheme case-SENSITIVELY (`Bearer`, " +
          "not `bearer`) -- deliberately stricter than RFC 7235.",
      },
    },
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
                  servesModel: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "401": UNAUTHORIZED_RESPONSE,
          "200": { description: "Registered", content: { "application/json": { schema: { type: "object", properties: { nodeId: { type: "string" } } } } } },
          "400": {
            description: "Invalid request body",
            content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } },
          },
        },
      },
    },
    "/nodes/{nodeId}/heartbeat": {
      post: {
        summary: "Refresh a node's liveness",
        parameters: [{ name: "nodeId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "401": UNAUTHORIZED_RESPONSE, "204": { description: "Heartbeat accepted" }, "404": { description: "Unknown nodeId" } },
      },
    },
    "/nodes/{nodeId}/reputation/agree": {
      post: {
        summary: "Record that a node's output agreed with a redundant spot-check",
        parameters: [{ name: "nodeId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "401": UNAUTHORIZED_RESPONSE, "204": { description: "Recorded" }, "404": { description: "Unknown nodeId" } },
      },
    },
    "/nodes/{nodeId}/reputation/disagree": {
      post: {
        summary: "Record that a node's output disagreed with a redundant spot-check",
        parameters: [{ name: "nodeId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "401": UNAUTHORIZED_RESPONSE, "204": { description: "Recorded" }, "404": { description: "Unknown nodeId" } },
      },
    },
    "/nodes/{nodeId}/reputation": {
      get: {
        summary: "Get a node's reputation stats",
        parameters: [{ name: "nodeId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "401": UNAUTHORIZED_RESPONSE,
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
        responses: {
          "401": UNAUTHORIZED_RESPONSE,
          "200": {
            description: "Active nodes",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      nodeId: { type: "string" },
                      endpoint: { type: "string" },
                      deviceTier: { type: "string" },
                      localityGroup: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/nodes/locality": {
      get: {
        summary: "List active nodes grouped by self-reported locality",
        responses: { "401": UNAUTHORIZED_RESPONSE, "200": { description: "Nodes grouped by locality group", content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/capacity": {
      get: {
        summary: "This instance's active node count (used by federated peers)",
        responses: { "401": UNAUTHORIZED_RESPONSE, "200": { description: "Capacity", content: { "application/json": { schema: { type: "object", properties: { activeNodes: { type: "integer" } } } } } } },
      },
    },
    "/peers/register": {
      post: {
        summary: "Register a federated peer coordinator instance",
        requestBody: {
          content: { "application/json": { schema: { type: "object", required: ["endpoint"], properties: { endpoint: { type: "string", format: "uri" } } } } },
        },
        responses: {
          "401": UNAUTHORIZED_RESPONSE,
          "200": { description: "Registered", content: { "application/json": { schema: { type: "object", properties: { peerId: { type: "string" } } } } } },
          "400": {
            description: "Invalid endpoint",
            content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } },
          },
        },
      },
    },
    "/peers/{peerId}/heartbeat": {
      post: {
        summary: "Refresh a peer's liveness",
        parameters: [{ name: "peerId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "401": UNAUTHORIZED_RESPONSE, "204": { description: "Heartbeat accepted" }, "404": { description: "Unknown peerId" } },
      },
    },
    "/peers": {
      get: {
        summary: "List currently active peers",
        responses: {
          "401": UNAUTHORIZED_RESPONSE,
          "200": {
            description: "Active peers",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      peerId: { type: "string" },
                      endpoint: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/peers/{peerId}": {
      delete: {
        summary: "Deregister a peer",
        parameters: [{ name: "peerId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "401": UNAUTHORIZED_RESPONSE, "204": { description: "Deregistered" }, "404": { description: "Unknown peerId" } },
      },
    },
    "/catalog": {
      get: {
        summary: "List models with availability gated on active node count (local + federated)",
        responses: {
          "401": UNAUTHORIZED_RESPONSE,
          "200": {
            description: "Catalog",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      displayName: { type: "string" },
                      minActiveNodes: { type: "integer" },
                      available: { type: "boolean" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/classify": {
      post: {
        summary:
          "Safety-classify a prompt (does not run inference). The coordinator loads a real curated " +
          "keyword/pattern ruleset from coordinator/safety_rules.json at startup, covering 10 categories: " +
          "violence_and_weapons, csam, self_harm, illegal_drugs, hate_speech_and_extremism, harassment, " +
          "fraud_and_scams, malware_and_hacking, adult_sexual_content, " +
          "misinformation_and_election_interference. This is pattern-matching, NOT semantic content " +
          "understanding -- it catches prompts containing a configured term or pattern and nothing else, " +
          "so the same request rephrased, misspelled, or translated will not be caught. Each category is " +
          "reported at most once, however many rules in it matched.",
        requestBody: {
          content: { "application/json": { schema: { type: "object", required: ["prompt"], properties: { prompt: { type: "string" } } } } },
        },
        responses: {
          "401": UNAUTHORIZED_RESPONSE,
          "200": {
            description:
              "Classification result. If the underlying classifier throws or times out, the endpoint fails " +
              'closed and returns { safe: false, categories: ["classifier_error"] } rather than a distinct ' +
              "error status -- callers should treat the literal category \"classifier_error\" as a signal " +
              "that classification did not actually run.",
            content: { "application/json": { schema: { type: "object", properties: { safe: { type: "boolean" }, categories: { type: "array", items: { type: "string" } } } } } },
          },
          "400": {
            description: "Invalid request body",
            content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } },
          },
        },
      },
    },
    "/generate": {
      post: {
        summary: "Classify a prompt, route it to an active node serving the requested model, and return the generated text. No inference-request endpoint existed before this; still no streaming (the response arrives complete or not at all), no retry, and no fallback to a different node on failure.",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["prompt", "modelId"],
                properties: {
                  prompt: { type: "string" },
                  modelId: { type: "string" },
                  n_predict: { type: "integer", minimum: 1, maximum: 512 },
                },
              },
            },
          },
        },
        responses: {
          "401": UNAUTHORIZED_RESPONSE,
          "200": { description: "Generated text", content: { "application/json": { schema: { type: "object", properties: { text: { type: "string" } } } } } },
          "400": {
            description:
              "Invalid request, or the prompt was classified unsafe. Two distinct shapes are possible: a " +
              "generic validation error ({ error: string }), or a classify-rejected prompt, which returns " +
              "the safety verdict itself ({ safe: false, categories: string[] }) instead.",
            content: {
              "application/json": {
                schema: {
                  oneOf: [
                    { type: "object", properties: { error: { type: "string" } }, required: ["error"] },
                    { type: "object", properties: { safe: { type: "boolean" }, categories: { type: "array", items: { type: "string" } } }, required: ["safe", "categories"] },
                  ],
                },
              },
            },
          },
          "503": {
            description: "No active node currently serves the requested model",
            content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } },
          },
          "502": {
            description: "The selected node was unreachable or returned a malformed response",
            content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } },
          },
        },
      },
    },
  },
};
