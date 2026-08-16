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
