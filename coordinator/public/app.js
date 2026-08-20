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
      document.getElementById("token-status").textContent =
        "Invalid or missing token — paste a valid SWARM_AUTH_TOKEN above.";
      return;
    }
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

document.getElementById("save-token-button").addEventListener("click", () => {
  const input = document.getElementById("token-input");
  setToken(input.value);
  document.getElementById("token-status").textContent = "Token saved for this tab.";
  refreshStatus();
});

document.getElementById("token-input").value = getToken();

refreshStatus();
setInterval(refreshStatus, 5000);
