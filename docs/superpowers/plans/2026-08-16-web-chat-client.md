# Web Chat Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the coordinator a browser-based client — the spec's "chat app is simply its first client, not a special case" of the API gateway — so a person can see swarm status and try the safety gate without writing HTTP requests by hand.

**Scope correction, stated up front (decided with the user):** the master spec's client-apps section describes native Android/iOS/Linux/Windows/macOS apps with an on-device model and a chat interface that actually runs inference. This development environment is Windows-only with no Android SDK, Flutter, React Native, or Electron toolchain installed, and iOS development requires Xcode on macOS — categorically impossible here. Building native mobile/desktop app code that can never be compiled or tested in this environment would break this project's established discipline (every prior plan has been built and verified with real test runs). The user chose, when asked, to scope this plan down to a **browser-based client** instead — buildable and testable in this environment, deferring native apps entirely.

Separately, and just as important: **this client cannot deliver real inference results**, because no request-routing or pipeline-assembly system exists anywhere in this repo yet (Plans 8 and 9 both already documented this same gap — nothing has changed since). The coordinator has no endpoint that accepts a prompt and returns generated tokens; the C++ inference engine (`core/`) and the Node.js coordinator (`coordinator/`) have never been connected. Building that connective tissue is out of scope for a client plan — it would be its own plan (or several). What this plan actually builds: a browser dashboard showing live swarm status (active node count, model catalog availability) and a working demo of the `/classify` safety gate, with an explicit, visible notice in the UI itself (not just in docs) that end-to-end inference isn't available yet.

**Architecture:** The coordinator's own `node:http` server (`coordinator/src/server.ts`) gains three new, fixed static-file routes (`GET /`, `GET /app.js`, `GET /style.css`) serving files from a new `coordinator/public/` directory. No general-purpose static file server is built — the three served filenames are hardcoded string literals in the route handlers, never derived from the request path, so there is no path-traversal surface to defend against by construction. The client itself is plain HTML/CSS/vanilla JS with no build step and no framework, matching the coordinator's own zero-dependency ethos, served same-origin (no CORS needed) since the coordinator serves its own client.

**Tech Stack:** Same as Plans 3/6/7/8/9 for the backend (Node.js built-ins only, zero npm dependencies). Frontend: plain HTML/CSS/JS, no npm dependencies, no build step, no framework.

## Global Constraints

- Everything from Plan 3/6/7/8/9's Global Constraints still applies to the backend changes: zero npm dependencies, no placeholders, no authentication (matches every existing endpoint's trusted-LAN-scope posture — the new static routes serve public, non-sensitive files, so this is not a new exposure).
- **The three static routes are not a general static file server.** Each route hardcodes its own filename as a string literal passed to a shared `serveStaticFile()` helper — the helper never accepts or constructs a path from request input. This must remain true through both tasks: do not refactor toward a generic `GET /public/:filename` route, which would reintroduce a path-traversal class of bug this design avoids by construction.
- **The client must visibly disclose, in its own UI, that it cannot run real inference** — not only in code comments or README prose. A user opening the page and never reading documentation must still see this.
- No new npm dependency, build tool, or bundler for the frontend. Plain files served as-is.

---

### Task 1: Static file serving mechanism (backend)

**Files:**
- Modify: `coordinator/src/server.ts`
- Create: `coordinator/public/index.html` (placeholder — Task 2 replaces its content)
- Create: `coordinator/public/app.js` (placeholder — Task 2 replaces its content)
- Create: `coordinator/public/style.css` (placeholder — Task 2 replaces its content)
- Modify: `coordinator/tests/server.test.ts`

**Interfaces:**
- Consumes: nothing new — adds routes to the existing `createServer` handler.
- Produces: `GET /` → 200, `text/html`; `GET /app.js` → 200, `application/javascript`; `GET /style.css` → 200, `text/css`. Task 2 replaces the placeholder file contents; the routes and their content-types don't change.

- [ ] **Step 1: Write the failing tests**

Read `coordinator/src/server.ts` in full first to confirm exact current route ordering and the `parts` parsing convention (`url.pathname.split("/").filter(Boolean)`), and confirm none of the three new routes (`parts.length === 0`; `parts.length === 1 && parts[0] === "app.js"`; `parts.length === 1 && parts[0] === "style.css"`) collide with any existing route.

Create placeholder files (Task 2 replaces their contents, but Task 1's tests need real files to serve):

`coordinator/public/index.html`:
```html
<!doctype html>
<title>placeholder</title>
```

`coordinator/public/app.js`:
```js
// placeholder
```

`coordinator/public/style.css`:
```css
/* placeholder */
```

Add to `coordinator/tests/server.test.ts` (check the current `startTestServer` helper's actual signature before writing — reuse it):

```ts
test("GET / serves index.html with text/html content-type", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const body = await res.text();
    assert.match(body, /<title>/);
  } finally {
    server.close();
  }
});

test("GET /app.js serves app.js with application/javascript content-type", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/app.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /javascript/);
  } finally {
    server.close();
  }
});

test("GET /style.css serves style.css with text/css content-type", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/style.css`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/css/);
  } finally {
    server.close();
  }
});

test("GET /nonexistent-static-file.js still 404s (no interference with existing routes)", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/nonexistent-static-file.js`);
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test("existing GET /nodes route is unaffected by the new static routes", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/nodes`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  } finally {
    server.close();
  }
});
```

Run:
```bash
cd coordinator && npm test
```
Expected: **FAIL** — the three static routes don't exist yet (404 instead of 200).

- [ ] **Step 2: Implement**

Add near the top of `coordinator/src/server.ts` (after the existing imports):

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

function serveStaticFile(res: ServerResponse, filename: string, contentType: string): void {
  try {
    const content = readFileSync(join(PUBLIC_DIR, filename));
    res.writeHead(200, { "content-type": contentType });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end();
  }
}
```

`filename` here is always one of three string literals supplied below by this file's own code, never derived from `req.url` or `parts` — this is what makes path traversal structurally impossible, not a runtime check. Do not change this.

Add these three routes. Place them before the final `res.writeHead(404); res.end();` fallback, in any order relative to the existing API routes (they don't overlap by `parts.length`/`parts[0]`, confirmed in Step 1):

```ts
if (method === "GET" && parts.length === 0) {
  serveStaticFile(res, "index.html", "text/html; charset=utf-8");
  return;
}

if (method === "GET" && parts.length === 1 && parts[0] === "app.js") {
  serveStaticFile(res, "app.js", "application/javascript; charset=utf-8");
  return;
}

if (method === "GET" && parts.length === 1 && parts[0] === "style.css") {
  serveStaticFile(res, "style.css", "text/css; charset=utf-8");
  return;
}
```

- [ ] **Step 3: Run the tests and verify they pass**

```bash
cd coordinator && npm test
```
Expected: **PASS** — full suite, including all 5 new tests.

- [ ] **Step 4: Commit**

```bash
git add coordinator/src/server.ts coordinator/public/index.html coordinator/public/app.js coordinator/public/style.css coordinator/tests/server.test.ts
git commit -m "Serve a static web client from the coordinator (backend routes + placeholder files)"
```

---

### Task 2: The chat/dashboard client itself (frontend content)

**Files:**
- Modify: `coordinator/public/index.html` (replace placeholder)
- Modify: `coordinator/public/app.js` (replace placeholder)
- Modify: `coordinator/public/style.css` (replace placeholder)
- Modify: `coordinator/tests/server.test.ts` (a few content-marker assertions — not full DOM/browser testing, see Step 1 below for why)
- Modify: `README.md`

**Interfaces:**
- Consumes: the coordinator's existing `GET /capacity`, `GET /catalog`, and `POST /classify` endpoints (all already built, Plans 3/7) via same-origin `fetch()` calls from the browser.
- Produces: nothing new for other tasks to consume — this is the final client-facing deliverable of this plan.

**Why this task is not pure TDD:** the served files are DOM-manipulating browser JavaScript, HTML, and CSS — `node:test` has no DOM and can't meaningfully assert on rendered behavior (a "test" that mocks `document` would verify the mock, not the page). This task therefore combines two kinds of verification: (a) a few lightweight `node:test` assertions on the *served content* (does the HTML contain the expected element IDs the JS depends on, is the "no real inference yet" notice actually present in the markup) — these catch a whole class of regression (e.g. someone renames an element ID in the HTML without updating app.js) cheaply; and (b) actual browser verification, which the implementer must do manually using this environment's Browser tool before reporting DONE, per this project's standing rule that UI work must be exercised in a real browser before being reported complete, not just have its test suite pass.

- [ ] **Step 1: Write the failing content-marker tests**

Add to `coordinator/tests/server.test.ts`:

```ts
test("index.html contains the expected element IDs app.js depends on, and the no-real-inference notice", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const body = await (await fetch(`${baseUrl}/`)).text();
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

Run:
```bash
cd coordinator && npm test
```
Expected: **FAIL** — the placeholder `index.html` from Task 1 contains none of these markers.

- [ ] **Step 2: Replace the placeholder files with the real client**

Replace `coordinator/public/index.html` with:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>swarm-llm coordinator</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <header>
    <h1>swarm-llm coordinator</h1>
    <p class="tagline">Federated, open-weight LLM inference network — status dashboard</p>
  </header>

  <main>
    <section id="status">
      <h2>Swarm status</h2>
      <p>Active nodes (local + federated): <strong id="active-count">—</strong></p>
      <table id="catalog-table">
        <thead>
          <tr><th>Model</th><th>Min. active nodes</th><th>Available</th></tr>
        </thead>
        <tbody></tbody>
      </table>
    </section>

    <section id="classify-demo">
      <h2>Safety classifier demo</h2>
      <p class="notice">
        This checks a prompt against the coordinator's <code>/classify</code>
        safety gate. <strong>It does not run inference</strong> — no
        request-routing system exists yet to actually generate a response
        from a model. See the project README for details.
      </p>
      <textarea id="prompt-input" rows="3" placeholder="Type a prompt to classify..."></textarea>
      <button id="classify-button" type="button">Check safety</button>
      <p id="classify-result" role="status"></p>
    </section>
  </main>

  <script src="/app.js"></script>
</body>
</html>
```

Replace `coordinator/public/app.js` with:

```js
async function refreshStatus() {
  const activeCountEl = document.getElementById("active-count");
  const tbody = document.querySelector("#catalog-table tbody");
  try {
    const [capacityRes, catalogRes] = await Promise.all([
      fetch("/capacity"),
      fetch("/catalog"),
    ]);
    const capacity = await capacityRes.json();
    const catalog = await catalogRes.json();

    activeCountEl.textContent = String(capacity.activeNodes);

    tbody.innerHTML = "";
    for (const entry of catalog) {
      const row = document.createElement("tr");

      const nameCell = document.createElement("td");
      nameCell.textContent = entry.displayName;

      const minCell = document.createElement("td");
      minCell.textContent = String(entry.minActiveNodes);

      const availCell = document.createElement("td");
      availCell.textContent = entry.available ? "yes" : "no";

      row.append(nameCell, minCell, availCell);
      tbody.appendChild(row);
    }
  } catch (err) {
    activeCountEl.textContent = "unavailable";
    console.error("failed to refresh swarm status", err);
  }
}

async function classifyPrompt() {
  const input = document.getElementById("prompt-input");
  const resultEl = document.getElementById("classify-result");
  const prompt = input.value;

  resultEl.textContent = "Checking...";
  try {
    const res = await fetch("/classify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const body = await res.json();
    resultEl.textContent = body.safe
      ? "safe: true"
      : `safe: false (categories: ${body.categories.length > 0 ? body.categories.join(", ") : "none"})`;
  } catch (err) {
    resultEl.textContent = "Error checking prompt.";
    console.error("classify request failed", err);
  }
}

document.getElementById("classify-button").addEventListener("click", classifyPrompt);

refreshStatus();
setInterval(refreshStatus, 5000);
```

Replace `coordinator/public/style.css` with:

```css
:root {
  color-scheme: light dark;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
}

body {
  max-width: 720px;
  margin: 0 auto;
  padding: 1.5rem;
  line-height: 1.5;
}

header {
  margin-bottom: 2rem;
}

.tagline {
  opacity: 0.75;
}

section {
  margin-bottom: 2rem;
}

table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 0.5rem;
}

th, td {
  text-align: left;
  padding: 0.4rem 0.6rem;
  border-bottom: 1px solid currentColor;
}

.notice {
  padding: 0.75rem;
  border: 1px solid currentColor;
  border-radius: 0.5rem;
  opacity: 0.9;
  font-size: 0.9rem;
}

textarea {
  width: 100%;
  box-sizing: border-box;
  font: inherit;
  padding: 0.5rem;
}

button {
  margin-top: 0.5rem;
  padding: 0.5rem 1rem;
  font: inherit;
  cursor: pointer;
}

#classify-result {
  margin-top: 0.5rem;
  font-weight: 600;
}
```

- [ ] **Step 3: Run the tests and verify they pass**

```bash
cd coordinator && npm test
```
Expected: **PASS** — full suite, including the new content-marker test.

- [ ] **Step 4: Manually verify in a real browser**

Start the coordinator:
```bash
cd coordinator && PORT=8080 node src/main.ts
```

Using this environment's Browser tool, navigate to `http://127.0.0.1:8080/`, and confirm:
1. The page loads with no console errors.
2. The status section shows an active-node count and a catalog table (register a node first via `POST /nodes/register` with curl/fetch if the catalog is empty, to see a non-trivial result — or note in your report if you tested against an empty swarm).
3. Typing a prompt and clicking "Check safety" shows a `safe: true` or `safe: false (categories: ...)` result.
4. The "does not run inference" notice is visible without scrolling past the fold on a typical viewport.

Stop the server when done. Include what you observed (not just "it worked") in your report — screenshots are not required, but describe the actual rendered state you saw.

- [ ] **Step 5: Update README**

Add a "Web client" section to `README.md`, documenting: the coordinator serves a browser dashboard at `/` when running; what it shows (swarm status, catalog availability, a `/classify` demo); and the same explicit disclosure the UI itself carries — no real inference is available yet, pending a request-routing system this repo doesn't have.

- [ ] **Step 6: Commit**

```bash
git add coordinator/public/index.html coordinator/public/app.js coordinator/public/style.css coordinator/tests/server.test.ts README.md
git commit -m "Build the web chat/dashboard client: swarm status + safety-classifier demo"
```

---

## What this plan does not do

Does not implement native Android, iOS, Linux, Windows, or macOS apps — deferred, by the user's explicit choice, given this environment cannot build or test them. Does not implement real end-to-end inference from the client — no request-routing/pipeline-assembly system exists anywhere in this repo yet (same gap Plans 8 and 9 already documented); the client visibly discloses this rather than faking it. Does not add authentication, rate-limiting, or CORS handling (same-origin only, matches the coordinator's existing no-auth posture). Does not add a build step, bundler, or frontend framework.
