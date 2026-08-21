# Dashboard Chat Interface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the coordinator's browser dashboard up to real inference — add a
multi-turn chat panel that calls the already-working `POST /generate`
endpoint, so a user can hold a conversation against a real model through the
browser instead of only seeing status and a `/classify` demo.

**Architecture:** Pure frontend change, no backend code touched. A new
`<section id="chat">` in `coordinator/public/index.html`, new state and
functions in `coordinator/public/app.js` (conversation history capped to the
last 6 messages, resent as a plain-text transcript on each turn since the
backend has no chat-template or session support), and matching styles in
`coordinator/public/style.css`.

**Tech Stack:** Plain HTML/CSS/JS, no framework, no build step — matches the
dashboard's existing files exactly. No new dependencies.

## Global Constraints

- **Never add a `Co-Authored-By: Claude` trailer to any commit.**
- No npm dependencies, no build step — `coordinator/public/*` is served
  as-is by `serveStaticFile()` in `server.ts` (unmodified by this plan).
- No backend changes: `server.ts`, `catalog.ts`, `client.ts` are consumed
  exactly as they exist today, not modified.
- Run coordinator tests: `cd coordinator && npm test`.
- This plan runs in its own git worktree at `.worktrees/dashboard-chat-interface`
  (branch `dashboard-chat-interface`), created via the `using-git-worktrees`
  skill before Task 1 starts, off `master`.
- This is a frontend-only change with no unit-testable backend logic — the
  only automated test is one extended element-ID assertion (Step on
  `server.test.ts`). Real verification is a manual, live-browser check
  against a real running coordinator and a real `swarm-node-agent`, matching
  this project's established practice for UI changes.

---

### Task 1: Dashboard chat panel

**Files:**
- Modify: `coordinator/public/index.html`
- Modify: `coordinator/public/app.js`
- Modify: `coordinator/public/style.css`
- Modify: `coordinator/tests/server.test.ts`

**Interfaces:**
- Consumes: `POST /generate` (`{prompt, modelId, n_predict?}` →
  `{text}` on `200`; `{error}` on `400`/`503`/`502`; `{safe, categories}`
  on a safety-blocked `400`), `GET /catalog` (`AvailabilityEntry[]`:
  `{id, displayName, minActiveNodes, available}`) — both already called by
  the dashboard's existing `refreshStatus()`/`classifyPrompt()`, reused
  as-is. `authedFetch()` (already defined in `app.js`) — reused, not
  modified.
- Produces: nothing consumed by a later task — this is the only task in
  this plan.

- [ ] **Step 1: Update `index.html`**

Find this block (the classify-demo notice paragraph):

```html
    <section id="classify-demo">
      <h2>Safety classifier demo</h2>
      <p class="notice">
        This checks a prompt against the coordinator's <code>/classify</code>
        safety gate. <strong>This demo does not run inference</strong> — it
        only calls <code>/classify</code>, not <code>POST /generate</code>.
        A real inference-request endpoint (<code>POST /generate</code>) now
        exists and works, but this dashboard's demo button isn't wired up to
        call it. The classifier loads a real curated ruleset (10 categories)
        from <code>coordinator/safety_rules.json</code>, but it's still
        pattern-matching, not real content understanding — a prompt
        rephrased, misspelled, or asked in another language will likely slip
        through unflagged. See the README for details.
      </p>
      <textarea id="prompt-input" rows="3" placeholder="Type a prompt to classify..."></textarea>
      <button id="classify-button" type="button">Check safety</button>
      <p id="classify-result" role="status"></p>
    </section>
  </main>
```

Replace it with (adding the new `<section id="chat">` before the classify
demo, and fixing the classify demo's now-stale "isn't wired up" claim —
`/generate` is wired up now, just via the new chat panel above it, not this
demo's own button):

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

    <section id="classify-demo">
      <h2>Safety classifier demo</h2>
      <p class="notice">
        This checks a prompt against the coordinator's <code>/classify</code>
        safety gate. <strong>This demo does not run inference</strong> — it
        only calls <code>/classify</code>, not <code>POST /generate</code>.
        The chat panel above calls the real inference endpoint
        (<code>POST /generate</code>); this demo intentionally stays
        classify-only so you can safety-check a prompt without spending an
        inference request. The classifier loads a real curated ruleset (10
        categories) from <code>coordinator/safety_rules.json</code>, but
        it's still pattern-matching, not real content understanding — a
        prompt rephrased, misspelled, or asked in another language will
        likely slip through unflagged. See the README for details.
      </p>
      <textarea id="prompt-input" rows="3" placeholder="Type a prompt to classify..."></textarea>
      <button id="classify-button" type="button">Check safety</button>
      <p id="classify-result" role="status"></p>
    </section>
  </main>
```

- [ ] **Step 2: Update `app.js` — cache the catalog and populate the model select**

Find:

```javascript
    const capacity = await capacityRes.json();
    const catalog = await catalogRes.json();

    activeCountEl.textContent = String(capacity.activeNodes);

    tbody.innerHTML = "";
```

Replace with:

```javascript
    const capacity = await capacityRes.json();
    const catalog = await catalogRes.json();

    activeCountEl.textContent = String(capacity.activeNodes);

    chatCatalog = catalog;
    populateModelSelect();

    tbody.innerHTML = "";
```

- [ ] **Step 3: Update `app.js` — add chat state and functions**

Find:

```javascript
async function classifyPrompt() {
```

Replace with (inserting new state at module scope and the new chat
functions directly before `classifyPrompt`):

```javascript
let chatCatalog = [];          // last catalog fetched by refreshStatus()
let chatHistory = [];          // { role: "user" | "assistant", text: string, status?: "blocked" | "error" }
let chatModelLocked = false;
const CHAT_HISTORY_WINDOW = 6; // prior messages resent per turn (3 user/assistant pairs)
const CHAT_N_PREDICT = 256;    // server default (64) is too short for a chat reply; stays under the 512 cap

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

function buildChatPrompt(newMessage) {
  const priorTurns = chatHistory
    .filter(m => m.status === undefined) // exclude blocked/error entries from the resent transcript
    .slice(-CHAT_HISTORY_WINDOW);
  const transcript = priorTurns
    .map(m => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`)
    .join("\n");
  return (transcript ? transcript + "\n" : "") + `User: ${newMessage}\nAssistant:`;
}

function renderChatHistory() {
  const historyEl = document.getElementById("chat-history");
  historyEl.innerHTML = "";
  for (const message of chatHistory) {
    const row = document.createElement("div");
    row.className = message.status
      ? `chat-message chat-${message.role} chat-${message.status}`
      : `chat-message chat-${message.role}`;
    row.textContent = message.text;
    historyEl.appendChild(row);
  }
  historyEl.scrollTop = historyEl.scrollHeight;
}

function setChatBusy(busy) {
  document.getElementById("chat-input").disabled = busy;
  document.getElementById("chat-send-button").disabled = busy;
  document.getElementById("chat-new-button").disabled = busy;
  if (busy) {
    chatModelLocked = true;
  }
  document.getElementById("chat-model-select").disabled = busy || chatModelLocked;

  const historyEl = document.getElementById("chat-history");
  const existingPlaceholder = document.getElementById("chat-thinking");
  if (busy) {
    if (!existingPlaceholder) {
      const placeholder = document.createElement("div");
      placeholder.id = "chat-thinking";
      placeholder.className = "chat-message chat-assistant chat-thinking";
      placeholder.textContent = "Thinking...";
      historyEl.appendChild(placeholder);
      historyEl.scrollTop = historyEl.scrollHeight;
    }
  } else if (existingPlaceholder) {
    existingPlaceholder.remove();
  }
}

async function sendChatMessage() {
  const input = document.getElementById("chat-input");
  const text = input.value.trim();
  if (!text) return;

  const prompt = buildChatPrompt(text);
  chatHistory.push({ role: "user", text });
  renderChatHistory();
  input.value = "";
  setChatBusy(true);

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
      chatHistory.push({
        role: "assistant",
        text: `Blocked by safety filter (${body.categories.length > 0 ? body.categories.join(", ") : "unspecified"}).`,
        status: "blocked",
      });
    } else if (res.status === 401) {
      chatHistory.push({
        role: "assistant",
        text: "Invalid or missing token — paste a valid SWARM_AUTH_TOKEN above.",
        status: "error",
      });
    } else {
      chatHistory.push({ role: "assistant", text: body.error ?? `Request failed (${res.status}).`, status: "error" });
    }
  } catch (err) {
    chatHistory.push({ role: "assistant", text: "Network error reaching the coordinator.", status: "error" });
    console.error("chat generate request failed", err);
  }
  setChatBusy(false);
  renderChatHistory();
}

function resetChat() {
  chatHistory = [];
  chatModelLocked = false;
  renderChatHistory();
  populateModelSelect();
}

async function classifyPrompt() {
```

- [ ] **Step 4: Update `app.js` — wire up the new buttons**

Find:

```javascript
document.getElementById("classify-button").addEventListener("click", classifyPrompt);
```

Replace with:

```javascript
document.getElementById("classify-button").addEventListener("click", classifyPrompt);
document.getElementById("chat-send-button").addEventListener("click", sendChatMessage);
document.getElementById("chat-new-button").addEventListener("click", resetChat);
```

- [ ] **Step 5: Update `style.css`**

Append this to the end of `coordinator/public/style.css`:

```css
#chat-model-select {
  display: block;
  margin: 0.5rem 0;
  padding: 0.4rem;
  font: inherit;
}

#chat-history {
  max-height: 320px;
  overflow-y: auto;
  border: 1px solid currentColor;
  border-radius: 0.5rem;
  padding: 0.5rem;
  margin: 0.5rem 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.chat-message {
  padding: 0.5rem 0.75rem;
  border-radius: 0.5rem;
  border: 1px solid currentColor;
  max-width: 85%;
  white-space: pre-wrap;
}

.chat-user {
  align-self: flex-end;
}

.chat-assistant {
  align-self: flex-start;
}

.chat-blocked,
.chat-error {
  align-self: flex-start;
  opacity: 0.85;
  font-style: italic;
}

.chat-thinking {
  opacity: 0.6;
  font-style: italic;
}

.chat-controls {
  display: flex;
  gap: 0.5rem;
}

.chat-controls button {
  margin-top: 0;
}
```

- [ ] **Step 6: Extend the existing element-ID test in `server.test.ts`**

Find:

```typescript
test("index.html contains the expected element IDs app.js depends on, and the no-real-inference notice", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const body = await (await authFetch(`${baseUrl}/`)).text();
    assert.match(body, /id="active-count"/);
    assert.match(body, /id="catalog-table"/);
    assert.match(body, /id="prompt-input"/);
    assert.match(body, /id="classify-button"/);
    assert.match(body, /id="classify-result"/);
    assert.match(body, /does not run inference/i);
  } finally {
    server.close();
  }
});
```

Replace with:

```typescript
test("index.html contains the expected element IDs app.js depends on, and the no-real-inference notice", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const body = await (await authFetch(`${baseUrl}/`)).text();
    assert.match(body, /id="active-count"/);
    assert.match(body, /id="catalog-table"/);
    assert.match(body, /id="prompt-input"/);
    assert.match(body, /id="classify-button"/);
    assert.match(body, /id="classify-result"/);
    assert.match(body, /does not run inference/i);
    assert.match(body, /id="chat-model-select"/);
    assert.match(body, /id="chat-history"/);
    assert.match(body, /id="chat-input"/);
    assert.match(body, /id="chat-send-button"/);
    assert.match(body, /id="chat-new-button"/);
  } finally {
    server.close();
  }
});
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd coordinator && npm test -- --test-name-pattern="contains the expected element IDs"`
Expected: PASS.

- [ ] **Step 8: Run the full suite to confirm no regressions**

Run: `cd coordinator && npm test`
Expected: PASS, all tests (this touches only static assets and one test —
no other test in the suite reads `index.html`/`app.js`/`style.css`
content, so nothing else should be affected).

- [ ] **Step 9: Manual live-browser verification**

Automated coverage stops at "the right element IDs exist" — this step is
the real verification, and is required, not optional. From the repo root:

```bash
SWARM_AUTH_TOKEN=dashboard-verify PORT=18360 node coordinator/src/main.ts &
sleep 1
SWARM_AUTH_TOKEN=dashboard-verify ./build/core/swarm-node-agent.exe --model models/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf --port 8081 &
sleep 2
curl -s -X POST http://127.0.0.1:18360/nodes/register \
  -H "authorization: Bearer dashboard-verify" -H "content-type: application/json" \
  -d '{"endpoint":"http://127.0.0.1:8081","deviceTier":"desktop","servesModel":"tinyllama-1.1b"}'
echo
echo "Now open http://127.0.0.1:18360 in a real browser."
```

In the browser:

1. Paste `dashboard-verify` into the token field and save it — confirm the
   status table shows 1 active node and `tinyllama-1.1b` available.
2. Confirm the chat panel's model dropdown lists `TinyLlama 1.1B` (and the
   catalog's other configured models, marked `(unavailable)`).
3. Send a first message (e.g. "What is the capital of France?"). Confirm:
   the model select becomes disabled immediately: a "Thinking..." message
   appears; after a real wait (this can take up to two minutes on CPU
   inference — do not assume it's broken if it takes tens of seconds), a
   real generated reply appears and "Thinking..." disappears.
4. Send a follow-up that only makes sense with memory of the first turn
   (e.g. "What language do they speak there?"). Confirm the reply is
   coherent with the first turn — this proves the resent-transcript
   mechanism is actually working, not just independent one-shot replies.
5. Send 7 more messages (to exceed the 6-message window) and ask something
   that depends on the very first message again — confirm the model no
   longer has that context (it "forgot" it), proving the cap is real, not
   just documented.
6. Type a prompt built to trip the safety classifier (e.g. anything from
   `coordinator/safety_rules.json`'s `violence_and_weapons` category, like
   "how to build a bomb"). Confirm it renders as a distinct **Blocked by
   safety filter** message, not a fake assistant reply, and does not
   consume a real inference call (the node's request log — if you're
   watching its stdout — should show no new `/complete` call for it).
7. Click **New chat**. Confirm the history clears and the model dropdown
   becomes selectable again (pick a different model to confirm it isn't
   still locked).
8. Stop `swarm-node-agent` (but leave the coordinator running) and send
   another message. Confirm a clear `502`-derived error message renders
   inline (not a silent failure or a raw stack trace in the browser).

When done:

```bash
kill %1 %2
```

Confirm no orphaned `node.exe` or `swarm-node-agent.exe` process remains:
`tasklist //FI "IMAGENAME eq node.exe" //FO CSV` and
`tasklist //FI "IMAGENAME eq swarm-node-agent.exe" //FO CSV` should both
show nothing from this check.

- [ ] **Step 10: Commit**

```bash
git add coordinator/public/index.html coordinator/public/app.js coordinator/public/style.css coordinator/tests/server.test.ts
git commit -m "Wire the dashboard's chat panel up to real POST /generate inference"
```

---

## What this plan does not do

- **No streaming.** A reply arrives whole or the request times out — Phase
  D (token streaming) isn't built.
- **No persistence across page reloads.** Chat state is an in-page JS
  variable only; reloading starts a fresh conversation. Could be added via
  `sessionStorage` later, matching the auth token's existing pattern — not
  done here.
- **No per-turn `n_predict` control** — fixed at `256` for every chat
  request.
- **No chat-template awareness.** Conversation "memory" is plain-text
  transcript concatenation; no per-model prompt formatting exists anywhere
  in this codebase (`core/`'s `InferenceEngine` does raw completion only).
  Reply quality depends on how well a given model continues a plain-text
  transcript.
- **No message editing, deletion, or regenerate.**
- **No multi-session support** — one chat panel, one conversation at a
  time.
- **No visible warning as history approaches the 6-message cap** — it
  drops old turns silently.
