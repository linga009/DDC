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
      "and returns the generated text -- or, with \"stream\": true in the " +
      "request body, relays the node's generation as a real Server-Sent " +
      "Events stream (text/event-stream), one data: frame per token, " +
      "terminated by a data: [DONE] sentinel on success or an " +
      "event: error frame on mid-stream failure. A model whose catalog " +
      "entry declares requiredNodeCount > 1 is routed differently: the " +
      "coordinator keeps a pool of pre-warmed, launcher-assembled " +
      "pipelines for it and sends the request to the least-recently-used " +
      "pooled pipeline's driver, ahead of reputation ranking, assembling " +
      "one synchronously only when that pool is empty. No model in the " +
      "default catalog declares requiredNodeCount > 1, so that machinery " +
      "stays dormant unless an operator configures it.\n\n" +
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
        description:
          "A registration whose canonical identity (see README's Endpoint identity section) is already ACTIVE " +
          "under a DIFFERENT endpoint is rejected outright (409, naming the pinned endpoint) before anything is " +
          "verified or stored -- registering under an alias of a machine someone else already registered never " +
          "silently reassigns or refreshes that entry. Otherwise, verification is ALWAYS attempted by calling " +
          "POST /identity on the submitted endpoint with a single-use nonce: deviceTier/servesModel in the request " +
          "body are validated for shape but then REPLACED with whatever the endpoint's own /identity response " +
          "reports, and a claimed servesModel the endpoint does not confirm is rejected outright (502), not " +
          "silently downgraded. Only when the endpoint is genuinely unreachable (not merely a non-2xx response -- " +
          "the swarm-rpc-server compute-contributor pattern, see README) AND no servesModel was claimed AND no " +
          "already-verified servesModel is on record for this identity does registration fall back to trusting " +
          "the caller's bare deviceTier claim, since a raw RPC backend has no HTTP /identity route to answer at " +
          "all. This narrows, but does not fully close, the trust model around node identity: it does not stop a " +
          "squatter from registering an identity FIRST (a disclosed residual -- proof-of-endpoint-possession is out " +
          "of scope for this phase), only from having a later, legitimate owner's verified data silently attached " +
          "to the squatter's pinned entry. localityGroup and availableMemoryMb are NOT verified this way and remain " +
          "exactly as supplied here, unchanged, for whichever endpoint is already pinned. See README's Known gaming " +
          "vectors.",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["endpoint", "deviceTier"],
                properties: {
                  endpoint: { type: "string" },
                  deviceTier: { type: "string", enum: ["desktop", "android", "ios"], description: "Validated for shape only -- the stored value comes from the endpoint's own /identity response." },
                  localityGroup: { type: "string" },
                  servesModel: { type: "string", description: "Validated for shape only -- the stored value comes from the endpoint's own /identity response." },
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
          "409": {
            description:
              "This identity is already registered under a different endpoint -- the pinned endpoint is named in " +
              "the error message. Registration is refused rather than silently reassigning it.",
            content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } },
          },
          "502": {
            description:
              "The endpoint could not be verified: unreachable, timed out (5s), a non-2xx response from its own " +
              "POST /identity, an oversized response body, an unparseable body, a mismatched nonce, or (when " +
              "servesModel was claimed) an /identity answer that does not confirm it.",
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
        description:
          "Unlike POST /nodes/register and POST /launchers/register, this is NOT verified against the endpoint " +
          "itself: a peer is another coordinator, which has no POST /identity route to call. The endpoint's claim is " +
          "trusted outright.",
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
    "/launchers/register": {
      post: {
        summary: "Register a swarm-launcher",
        description:
          "A registration whose canonical identity is already ACTIVE under a DIFFERENT endpoint is rejected " +
          "outright (409, naming the pinned endpoint) before anything is verified or stored -- the same rule " +
          "POST /nodes/register enforces, applied here too since a swarm-launcher's POST /pipeline is this " +
          "project's own documented RCE-shaped surface. Otherwise, verifies this registration by calling " +
          "POST /identity on the endpoint itself with a single-use nonce (no Authorization header -- a " +
          "swarm-launcher's /identity route deliberately has none, matching its own 127.0.0.1-only trust " +
          "boundary). agentPort in the request body is validated for shape but then DISCARDED: the value actually " +
          "stored is whatever the launcher's own /identity response reports. servesModels is NOT verified this way " +
          "and remains exactly as supplied here, unchanged -- a launcher can spawn any model present under its own " +
          "--models-dir, so it has no fixed answer to \"what do you serve\" the way a running node agent does.",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["endpoint", "servesModels", "agentPort"],
                properties: {
                  endpoint: { type: "string" },
                  servesModels: { type: "array", items: { type: "string" } },
                  agentPort: { type: "integer", description: "Validated for shape only -- the stored value comes from the launcher's own /identity response." },
                },
              },
            },
          },
        },
        responses: {
          "401": UNAUTHORIZED_RESPONSE,
          "200": { description: "Registered", content: { "application/json": { schema: { type: "object", properties: { launcherId: { type: "string" } } } } } },
          "400": {
            description: "Invalid request body",
            content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } },
          },
          "409": {
            description:
              "This identity is already registered under a different endpoint -- the pinned endpoint is named in " +
              "the error message. Registration is refused rather than silently reassigning it.",
            content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } },
          },
          "502": {
            description:
              "The launcher could not be verified: unreachable, timed out (5s), a non-2xx response from its own " +
              "POST /identity, an oversized response body, an unparseable body, a mismatched nonce, or an " +
              "out-of-range (not 1-65535) agentPort.",
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
        summary: "Classify a prompt, route it to an active node serving the requested model, and return the generated text -- as one JSON response by default, or as a real Server-Sent Events stream when \"stream\": true is set in the request body. No retry and no fallback to a different node on failure.",
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
                  stream: {
                    type: "boolean",
                    description:
                      "When true, the 200 response is text/event-stream instead of application/json: " +
                      "one \"data: <token>\\n\\n\" frame per generated token, in order, terminated by a " +
                      "\"data: [DONE]\\n\\n\" sentinel on success or an \"event: error\\ndata: " +
                      "{\"error\":...}\\n\\n\" frame if generation fails after streaming has already " +
                      "begun. Every other response status (400/401/502/503) is unaffected by this field " +
                      "and is still a plain JSON error body, since those failures are detected before any " +
                      "streaming commitment is made.",
                  },
                },
              },
            },
          },
        },
        responses: {
          "401": UNAUTHORIZED_RESPONSE,
          "200": {
            description: "Generated text. The response shape depends on whether the request set \"stream\": true.",
            content: {
              "application/json": {
                schema: { type: "object", properties: { text: { type: "string" } } },
              },
              "text/event-stream": {
                schema: {
                  type: "string",
                  description:
                    "A sequence of SSE frames: \"data: <token>\\n\\n\" for each generated token, in " +
                    "order, followed by a terminal \"data: [DONE]\\n\\n\" frame. A mid-stream failure " +
                    "instead ends the sequence with an \"event: error\\ndata: {\"error\":\"<message>\"}\\n\\n\" " +
                    "frame -- no [DONE] follows an error frame, the two are mutually exclusive on the wire.",
                },
              },
            },
          },
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
    "/v1/models": {
      get: {
        summary: "List the model catalog in OpenAI's /v1/models shape. Requires auth (unlike real OpenAI, this is live swarm-backed data, not a fixed list) -- lists every catalog entry regardless of current per-model node availability, mirroring GET /catalog's own behavior; a currently-unavailable model still returns the same 503 from /v1/chat/completions or /generate that an unavailable model always has.",
        responses: {
          "401": UNAUTHORIZED_RESPONSE,
          "200": {
            description: "The model catalog, OpenAI-shaped",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    object: { type: "string" },
                    data: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          object: { type: "string" },
                          created: { type: "integer" },
                          owned_by: { type: "string" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/v1/chat/completions": {
      post: {
        summary: "OpenAI-compatible chat completions. Classifies the flattened prompt, routes to a reputation-ranked active node serving the requested model, and returns a real generated reply with real token counts (not estimates) -- as one JSON chat.completion object by default, or a real SSE stream of chat.completion.chunk objects when \"stream\": true is set. No chat-template awareness (messages[] is flattened into a plain-text transcript -- see README), no sampling-parameter support (the engine is greedy-only; temperature/top_p/etc. are accepted but silently have no effect), no tool calls, and no n>1.",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["model", "messages"],
                properties: {
                  model: { type: "string" },
                  messages: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["role", "content"],
                      properties: {
                        role: { type: "string", enum: ["system", "user", "assistant"] },
                        content: { type: "string" },
                      },
                    },
                  },
                  max_tokens: { type: "integer", minimum: 1, maximum: 512, nullable: true },
                  stream: { type: "boolean" },
                  stream_options: {
                    type: "object",
                    properties: { include_usage: { type: "boolean" } },
                    description: "Only include_usage is honored; when stream is true and this is true, one extra trailing chunk with an empty choices array and a top-level usage object is sent just before [DONE].",
                  },
                },
              },
            },
          },
        },
        responses: {
          "401": UNAUTHORIZED_RESPONSE,
          "200": {
            description: "A chat.completion object (application/json) or a chat.completion.chunk SSE stream (text/event-stream), depending on \"stream\".",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    object: { type: "string" },
                    created: { type: "integer" },
                    model: { type: "string" },
                    choices: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          index: { type: "integer" },
                          message: { type: "object", properties: { role: { type: "string" }, content: { type: "string" } } },
                          finish_reason: { type: "string" },
                        },
                      },
                    },
                    usage: {
                      type: "object",
                      properties: {
                        prompt_tokens: { type: "integer" },
                        completion_tokens: { type: "integer" },
                        total_tokens: { type: "integer" },
                      },
                    },
                  },
                },
              },
              "text/event-stream": {
                schema: {
                  type: "string",
                  description: "A sequence of \"data: <chat.completion.chunk JSON>\\n\\n\" frames terminated by \"data: [DONE]\\n\\n\", or an \"event: error\\ndata: {\"error\":{...}}\\n\\n\" frame on mid-stream failure.",
                },
              },
            },
          },
          "400": {
            description: "Invalid request, an unknown model, or a prompt classified unsafe -- always OpenAI's {error: {message, type, code}} envelope.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    error: {
                      type: "object",
                      properties: { message: { type: "string" }, type: { type: "string" }, code: { type: "string", nullable: true } },
                    },
                  },
                },
              },
            },
          },
          "503": {
            description: "No active node currently serves the requested model",
            content: { "application/json": { schema: { type: "object", properties: { error: { type: "object" } } } } },
          },
          "502": {
            description: "The selected node was unreachable or returned a malformed response",
            content: { "application/json": { schema: { type: "object", properties: { error: { type: "object" } } } } },
          },
        },
      },
    },
  },
};
