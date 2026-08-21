# Dashboard Chat Interface — Design

## Background

This extends [Plan 10](docs/superpowers/plans/2026-08-16-web-chat-client.md)
(Web chat/dashboard client). That plan built the browser dashboard
(`coordinator/public/index.html`, `app.js`, `style.css`) but explicitly
deferred real inference — the dashboard's own classify-demo notice says so
today: *"A real inference-request endpoint (`POST /generate`) now exists
and works, but this dashboard's demo button isn't wired up to call it."*

`POST /generate` has existed and worked since Phase A
([`2026-08-16-coordinator-request-routing.md`](docs/superpowers/plans/2026-08-16-coordinator-request-routing.md)),
and has since been hardened by the entire Security Hardening initiative —
shared-token auth (Phase 1), a real curated safety-classifier ruleset
(Phase 2), sybil-resistant node identity (Phase 3), reputation-ranked node
selection (Phase 4). The chat panel this design adds gets all of that for
free: it calls the exact same endpoint the classify demo already calls
`/classify` through, with the same `authedFetch` helper.

Read fresh against the current codebase before writing this doc: the
dashboard's current 3 files (61/103/73 lines, no framework, no build
step), `server.ts`'s `POST /generate` handler (`{prompt, modelId,
n_predict?}` → `{text}` on `200`; distinct `{error}` on `400`/`503`/`502`
and `{safe:false, categories}` on a safety-blocked `400`), `client.ts`'s
already-existing typed `generate()`, and `catalog.ts`'s `CatalogEntry {id,
displayName, minActiveNodes}` — already fetched in full by the dashboard's
existing `refreshStatus()` poll, just not rendered beyond `displayName`/
`minActiveNodes`/`available`. Confirmed via `grep` that no chat-template
mechanism exists anywhere in `core/` — `/complete` is raw text completion,
whatever string is sent as `prompt` is what gets tokenized and continued.

## Goals

- Let a user hold a multi-turn conversation against a real model through
  the browser dashboard, using the existing `POST /generate` endpoint —
  no new backend endpoint, no backend changes at all.
- Reuse the dashboard's existing patterns exactly: `sessionStorage`-based
  token auth via `authedFetch`, plain HTML/CSS/JS with no framework or
  build step, `.notice`-style upfront disclosure blocks matching the
  classify demo's own.
- Bound the growth of resent conversation history so a long conversation
  degrades gracefully (oldest turns silently dropped) instead of
  eventually erroring out once a node's context window is exceeded.
- Give honest, specific feedback for each of `/generate`'s distinct
  failure shapes (malformed-request `400`, safety-blocked `400`, `503` no
  node currently serves the model, `502` node unreachable/malformed
  response) rather than one generic "error" message for all four.

## Non-Goals

- **No streaming.** Phase D (token streaming) isn't built —
  `InferenceEngine::complete()` is fully blocking. A reply arrives whole
  or the request times out (`GENERATE_TIMEOUT_MS` = 120000ms today).
- **No persistence across page reloads.** Chat state lives in a page-level
  JS variable only; reloading the page starts a fresh conversation. This
  matches the dashboard's existing minimalism (only the auth token is
  persisted, via `sessionStorage`) — trivial to add the same way later if
  wanted, not needed for this pass.
- **No per-turn `n_predict` control.** Fixed at `256` for every chat
  request (see Architecture) — not exposed as a UI control.
- **No chat-template awareness.** Conversation "memory" is plain-text
  transcript concatenation (`User: …\nAssistant: …`), not a model-specific
  chat format. Reply quality depends entirely on how well a given model
  continues a plain-text transcript — this is a known, real limitation of
  raw-completion "chat," not a bug to fix here (fixing it would mean
  building per-model chat-template support, a materially bigger,
  model-specific project outside this design's scope).
- **No message editing, deletion, or "regenerate last response."**
- **No multi-session support.** One chat panel, one conversation in
  flight at a time; starting a new chat discards the current one.

## Architecture

### `coordinator/public/index.html`: new `<section id="chat">`

Placed above the classify-demo section (it's the headline feature now):

```html
<section id="chat">
  <h2>Chat</h2>
  <p class="notice">
    Calls the coordinator's real <code>POST /generate</code> endpoint —
    this is genuine inference, not the classify demo below. It has no
    session memory of its own: each reply is one independent completion,
    so this page resends the last few messages as part of each new
    prompt to approximate a "conversation." Only the most recent
    <strong>6 messages</strong> are resent — a long conversation will
    start to "forget" its earliest turns. Every message is safety-checked
    the same way <code>/classify</code> checks a prompt below. No
    streaming: a reply arrives all at once, which can take up to two
    minutes.
  </p>
  <label for="chat-model-select">Model</label>
  <select id="chat-model-select"></select>
  <div id="chat-history" role="log" aria-live="polite"></div>
  <textarea id="chat-input" rows="2" placeholder="Type a message..."></textarea>
  <div class="chat-controls">
    <button id="chat-send-button" type="button">Send</button>
    <button id="chat-new-button" type="button">New chat</button>
  </div>
</section>
```

### `coordinator/public/app.js`: new state and functions

New module-level state, alongside the existing `TOKEN_KEY`:

```javascript
let chatCatalog = [];       // last catalog fetched by refreshStatus()
let chatHistory = [];       // { role: "user" | "assistant", text: string, status?: "blocked" | "error" }
let chatModelLocked = false;
const CHAT_HISTORY_WINDOW = 6;  // messages resent per turn (3 user/assistant pairs)
const CHAT_N_PREDICT = 256;     // server default (64) is too short for a chat reply; stays under MAX_N_PREDICT (512)
```

**`refreshStatus()` gets one addition**: after it fetches `catalog`, it
assigns `chatCatalog = catalog` and calls a new `populateModelSelect()` —
so the chat's model dropdown always reflects the same 5-second poll the
status table already uses, no duplicate fetch.

```javascript
function populateModelSelect() {
  if (chatModelLocked) return; // don't disturb an in-progress conversation's selection
  const select = document.getElementById("chat-model-select");
  const previous = select.value;
  select.innerHTML = "";
  for (const entry of chatCatalog) {
    const option = document.createElement("option");
    option.value = entry.id;
    option.textContent = entry.available ? entry.displayName : `${entry.displayName} (unavailable)`;
    select.appendChild(option);
  }
  if (chatCatalog.some(e => e.id === previous)) {
    select.value = previous;
  }
}
```

Building the outbound prompt — takes the window of prior turns plus the
new message, formats as a plain transcript:

```javascript
function buildChatPrompt(newMessage) {
  const priorTurns = chatHistory
    .filter(m => m.status === undefined) // exclude blocked/error entries from the resent transcript
    .slice(-CHAT_HISTORY_WINDOW);
  const transcript = priorTurns
    .map(m => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`)
    .join("\n");
  return (transcript ? transcript + "\n" : "") + `User: ${newMessage}\nAssistant:`;
}
```

Sending a turn:

```javascript
async function sendChatMessage() {
  const input = document.getElementById("chat-input");
  const text = input.value.trim();
  if (!text) return;

  const prompt = buildChatPrompt(text);
  chatHistory.push({ role: "user", text });
  renderChatHistory();
  input.value = "";
  setChatBusy(true); // disables input/buttons, locks model select, shows a "thinking..." placeholder

  const modelId = document.getElementById("chat-model-select").value;
  try {
    const res = await authedFetch("/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt, modelId, n_predict: CHAT_N_PREDICT }),
    });
    const body = await res.json();
    if (res.status === 200) {
      chatHistory.push({ role: "assistant", text: body.text.trim() });
    } else if (res.status === 400 && body.safe === false) {
      chatHistory.push({ role: "assistant", text: `Blocked by safety filter (${body.categories.join(", ") || "unspecified"}).`, status: "blocked" });
    } else if (res.status === 401) {
      chatHistory.push({ role: "assistant", text: "Invalid or missing token — paste a valid SWARM_AUTH_TOKEN above.", status: "error" });
    } else {
      chatHistory.push({ role: "assistant", text: body.error ?? `Request failed (${res.status}).`, status: "error" });
    }
  } catch (err) {
    chatHistory.push({ role: "assistant", text: "Network error reaching the coordinator.", status: "error" });
    console.error("chat generate request failed", err);
  }
  renderChatHistory();
  setChatBusy(false);
}

function resetChat() {
  chatHistory = [];
  chatModelLocked = false;
  document.getElementById("chat-model-select").disabled = false;
  renderChatHistory();
}
```

`setChatBusy(busy)` disables `#chat-input`/`#chat-send-button`/`#chat-new-button`
and `#chat-model-select` while `true` (also setting `chatModelLocked = true`
the first time it's called for a conversation), and appends/removes a
transient "Thinking…" placeholder row in `#chat-history`.

`renderChatHistory()` clears and rebuilds `#chat-history`'s children from
`chatHistory`, applying a CSS class per `role`/`status` (`chat-user`,
`chat-assistant`, `chat-blocked`, `chat-error`) and scrolling the container
to the bottom after render — mirrors `refreshStatus()`'s existing
clear-and-rebuild pattern for the catalog table (`tbody.innerHTML = ""`
followed by re-appending rows).

Event wiring, alongside the existing listeners at the bottom of the file:

```javascript
document.getElementById("chat-send-button").addEventListener("click", sendChatMessage);
document.getElementById("chat-new-button").addEventListener("click", resetChat);
```

### `coordinator/public/style.css`: message styling

A handful of small additions — `#chat-history` as a scrollable, bounded-
height container; `.chat-user`/`.chat-assistant` message rows with
distinct alignment/background (reusing the existing `.notice` box's
border/radius language, not inventing a new visual system); `.chat-
blocked`/`.chat-error` rows in a visually distinct (but not alarming —
this is a demo dashboard, not a production safety console) muted-warning
style.

## Rejected Approaches

- **Full chat-template/role-aware prompting.** No chat-template
  infrastructure exists anywhere in this codebase — `core/`'s
  `InferenceEngine` does raw completion only. Building real per-model
  chat-template support (each of the catalog's 6 models likely expects a
  different format) is a materially bigger, model-specific project, not
  scoped here.
- **Persisting chat history via `sessionStorage`.** Considered — trivial
  to add later matching the token's existing pattern — but rejected for
  this pass to keep scope to "wire up the endpoint," not "build a
  persistent chat product."
- **Unbounded history resend.** Rejected per explicit direction: caps to
  the last 6 messages instead.
- **A separate catalog fetch for the chat panel.** Rejected — would
  double the poll load and risk the status table and the model dropdown
  showing inconsistent data from two different fetches taken moments
  apart. Reusing `refreshStatus()`'s existing fetch keeps one source of
  truth.

## Open Questions

- **The 6-message history window is a starting guess**, not derived from
  any measured context-window size — the coordinator has no notion of any
  node's actual context length. May need tuning per model later; no
  mechanism here adapts it automatically.
- **No visible warning as a conversation approaches the point where old
  turns start getting dropped** — it degrades silently. A future pass
  could surface this (e.g. a subtle indicator once truncation is about to
  happen), not attempted here.

## Testing Considerations

- `coordinator/tests/server.test.ts`'s existing test —
  `"index.html contains the expected element IDs app.js depends on, and
  the no-real-inference notice"` — gets extended with the new chat element
  IDs (`chat-model-select`, `chat-history`, `chat-input`,
  `chat-send-button`, `chat-new-button`). Its existing
  `does not run inference` assertion stays valid unmodified — that text
  refers specifically to the classify demo below the new chat section,
  which is untouched by this design.
- No new backend logic exists to unit-test — every new failure-handling
  branch in `sendChatMessage()` is a pure frontend response to
  `/generate`'s already-tested backend behavior.
- Manual, live-browser verification during implementation (this project's
  established practice for UI changes): a real multi-turn conversation
  against a real running coordinator + `swarm-node-agent`, confirming
  history capping actually drops early turns past 6 messages, model-lock/
  unlock across a "New chat" click, and that each of the four failure
  shapes (validation `400`, safety-blocked `400`, `503`, `502`) renders a
  visibly distinct message — plus the "Thinking…" state during a real
  multi-second wait.
