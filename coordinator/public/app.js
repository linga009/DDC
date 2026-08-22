const TOKEN_KEY = "swarmAuthToken";

function getToken() {
  return sessionStorage.getItem(TOKEN_KEY) ?? "";
}

function setToken(token) {
  sessionStorage.setItem(TOKEN_KEY, token);
}

function authedFetch(url, options = {}) {
  const token = getToken();
  return fetch(url, {
    ...options,
    headers: { ...(options.headers ?? {}), authorization: `Bearer ${token}` },
  });
}

async function refreshStatus() {
  const activeCountEl = document.getElementById("active-count");
  const tbody = document.querySelector("#catalog-table tbody");
  try {
    const [capacityRes, catalogRes] = await Promise.all([
      authedFetch("/capacity"),
      authedFetch("/catalog"),
    ]);
    if (capacityRes.status === 401 || catalogRes.status === 401) {
      activeCountEl.textContent = "token required";
      // Clear the table too, not just the count: rows left over from the
      // last successful poll would otherwise sit there looking live while
      // the page is actually unauthenticated, showing stale availability
      // that may no longer be true.
      tbody.innerHTML = "";
      document.getElementById("token-status").textContent =
        "Invalid or missing token — paste a valid SWARM_AUTH_TOKEN above.";
      return;
    }
    const capacity = await capacityRes.json();
    const catalog = await catalogRes.json();

    activeCountEl.textContent = String(capacity.activeNodes);

    chatCatalog = catalog;
    populateModelSelect();

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

// Appends `piece` directly to the last rendered message's DOM node without
// rebuilding the whole history -- used while a streamed reply is actively
// growing, so a real generation (which can emit dozens of pieces) doesn't
// clear-and-rebuild the entire visible history on every single token.
// renderChatHistory() itself is still used for the FIRST piece of a new
// message (it needs a DOM node to exist before this can append to it) and
// for anything that changes a message's CSS class (an error/blocked
// status), not just its text.
function appendToLastChatMessage(piece) {
  const historyEl = document.getElementById("chat-history");
  const last = historyEl.lastElementChild;
  if (last) {
    last.textContent += piece;
    historyEl.scrollTop = historyEl.scrollHeight;
  }
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
  const assistantMessage = { role: "assistant", text: "" };
  let assistantMessageAdded = false;

  try {
    const res = await authedFetch("/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt, modelId, n_predict: CHAT_N_PREDICT, stream: true }),
    });

    if (res.status !== 200) {
      const body = await res.json();
      if (res.status === 400 && body.safe === false) {
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
    } else {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let sawDone = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          if (frame.startsWith("event: error")) {
            const dataLine = frame.split("\n").find(line => line.startsWith("data: "));
            const message = dataLine ? JSON.parse(dataLine.slice("data: ".length)).error : "generation failed mid-stream";
            if (!assistantMessageAdded) {
              chatHistory.push(assistantMessage);
              assistantMessageAdded = true;
            }
            assistantMessage.status = "error";
            assistantMessage.text += assistantMessage.text ? ` [error: ${message}]` : `Error: ${message}`;
            renderChatHistory(); // status changed -- needs the CSS class updated too, not just text
            continue;
          }
          const dataLines = frame.split("\n").filter(line => line.startsWith("data: "));
          if (dataLines.length === 0) continue;
          const piece = dataLines.map(line => line.slice("data: ".length)).join("\n");
          if (piece === "[DONE]") {
            // Terminal sentinel, not literal generated text. Stop
            // processing immediately -- matching SwarmClient.generateStream()'s
            // `return` -- so any bytes a misbehaving node sent after its
            // own [DONE] never reach the rendered chat.
            sawDone = true;
            break;
          }
          assistantMessage.text += piece;
          if (!assistantMessageAdded) {
            chatHistory.push(assistantMessage);
            assistantMessageAdded = true;
            renderChatHistory(); // first piece -- the DOM node doesn't exist yet
          } else {
            appendToLastChatMessage(piece); // later pieces -- avoid a full rebuild per token
          }
        }
        if (sawDone) break;
      }
      if (!sawDone) {
        // The connection ended (the coordinator relayed a clean
        // end-of-stream) without the terminal [DONE] sentinel ever
        // arriving -- e.g. the node process died mid-generation. The
        // response has no Content-Length (it's SSE, connection-delimited),
        // so a mid-stream drop and a genuinely finished stream both report
        // `done: true` from the reader with no other signal. Without this
        // check a truncated reply would render identically to a
        // successfully completed one.
        if (assistantMessageAdded) {
          assistantMessage.status = "error";
          assistantMessage.text += " [truncated: connection lost before the reply finished]";
        } else {
          chatHistory.push({
            role: "assistant",
            text: "Connection lost before any output arrived.",
            status: "error",
          });
        }
      } else if (!assistantMessageAdded) {
        chatHistory.push({ role: "assistant", text: "(no output)" });
      }
    }
  } catch (err) {
    if (!assistantMessageAdded) {
      chatHistory.push({ role: "assistant", text: "Network error reaching the coordinator.", status: "error" });
    }
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
  // chatModelLocked being false above is necessary but not sufficient: the
  // <select> element's own `disabled` DOM property was set to `true` by the
  // last setChatBusy(true)/setChatBusy(false) pair during the just-finished
  // conversation and nothing else clears it. Route through setChatBusy(false)
  // so the same single place that disables the dropdown is also the place
  // that re-enables it -- confirmed live: without this call, "New chat"
  // cleared the JS lock flag but left the dropdown visibly and functionally
  // disabled in the browser.
  setChatBusy(false);
}

async function classifyPrompt() {
  const input = document.getElementById("prompt-input");
  const resultEl = document.getElementById("classify-result");
  const prompt = input.value;

  resultEl.textContent = "Checking...";
  try {
    const res = await authedFetch("/classify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    if (res.status === 401) {
      resultEl.textContent = "Invalid or missing token — paste a valid SWARM_AUTH_TOKEN above.";
      return;
    }
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
document.getElementById("chat-send-button").addEventListener("click", sendChatMessage);
document.getElementById("chat-new-button").addEventListener("click", resetChat);

document.getElementById("save-token-button").addEventListener("click", () => {
  const input = document.getElementById("token-input");
  setToken(input.value);
  document.getElementById("token-status").textContent = "Token saved for this tab.";
  refreshStatus();
});

document.getElementById("token-input").value = getToken();

refreshStatus();
setInterval(refreshStatus, 5000);
