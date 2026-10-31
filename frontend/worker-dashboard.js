const API_BASE =
  window.location.port === "5500"
    ? "http://127.0.0.1:5000"
    : window.location.origin;
const token = localStorage.getItem("cityshield_token");
const assignedList = document.getElementById("assignedList");
const assignedMessage = document.getElementById("assignedMessage");
const notificationBanner = document.getElementById("notificationBanner");
const knownAssignments = new Map();
const imageUrls = new Set();
let hasLoadedAssignments = false;

function clearImageUrls() {
  imageUrls.forEach(url => URL.revokeObjectURL(url));
  imageUrls.clear();
}

async function apiRequest(path, options = {}) {
  const headers = {
    Authorization: `Bearer ${token}`,
    ...(options.headers || {}),
  };
  if (!(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  if (response.status === 401) {
    localStorage.removeItem("cityshield_token");
    localStorage.removeItem("cityshield_user");
    window.location.assign("index.html");
    throw new Error("Your session has expired. Please sign in again.");
  }

  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json")
    ? await response.json()
    : {};
  if (!response.ok) {
    const detail = data.detail;
    const message = Array.isArray(detail)
      ? detail.map(item => item.msg).join(", ")
      : detail;
    throw new Error(message || `Request failed with status ${response.status}.`);
  }
  return data;
}

function showMessage(element, message, type = "") {
  const className = element.id === "formMessage"
    ? "form-message"
    : "reports-message";
  element.textContent = message;
  element.className = `${className} ${type}`;
}

function textElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text ?? "";
  return element;
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleString();
}

function statusOptions(currentStatus) {
  return ["Reported", "Under Review", "In Progress", "Resolved", "Rejected"]
    .map(status => {
      const option = document.createElement("option");
      option.value = status;
      option.textContent = status;
      option.selected = status === currentStatus;
      return option;
    });
}

async function loadImage(incident, image) {
  try {
    const response = await fetch(`${API_BASE}${incident.image_url}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(`Image request failed with status ${response.status}.`);
    }
    const url = URL.createObjectURL(await response.blob());
    imageUrls.add(url);
    image.src = url;
  } catch (error) {
    image.hidden = true;
    console.error("Incident image:", error.message);
  }
}

function renderHistory(container, updates) {
  container.replaceChildren();
  if (!updates.length) {
    container.append(textElement("p", "field-hint", "No updates yet."));
    return;
  }
  updates.forEach(update => {
    const item = textElement("div", "update-item", "");
    item.append(textElement("strong", "", update.status));
    item.append(textElement("span", "", update.message));
    item.append(textElement("time", "", formatDate(update.created_at)));
    container.append(item);
  });
}

function createIncidentCard(incident, assigned = false) {
  const card = textElement("article", "report-card", "");
  const top = textElement("div", "report-card-top", "");
  const details = textElement("div", "", "");
  details.append(textElement("h3", "", incident.title));
  details.append(
    textElement(
      "div",
      "report-meta",
      `${incident.category} · ${incident.location} · ${formatDate(incident.created_at)}`
    )
  );
  if (assigned) {
    details.append(
      textElement("div", "report-meta", `Reported by ${incident.reporter}`)
    );
  }
  top.append(details);
  const statusClass = String(incident.status || "")
    .toLowerCase()
    .replaceAll(" ", "-");
  top.append(
    textElement("span", `status-badge ${statusClass}`, incident.status)
  );
  card.append(top);
  card.append(
    textElement("p", "report-description", incident.description)
  );

  const coordinatesProvided =
    incident.latitude !== null &&
    incident.latitude !== undefined &&
    incident.longitude !== null &&
    incident.longitude !== undefined &&
    Number.isFinite(Number(incident.latitude)) &&
    Number.isFinite(Number(incident.longitude));
  const destination = coordinatesProvided
    ? `${incident.latitude},${incident.longitude}`
    : incident.location;
  if (destination) {
    const mapUrl = new URL("https://www.google.com/maps/dir/");
    mapUrl.searchParams.set("api", "1");
    mapUrl.searchParams.set("destination", destination);
    const mapLink = textElement(
      "a",
      "button button-secondary map-directions",
      "⌖ Get directions"
    );
    mapLink.href = mapUrl.href;
    mapLink.target = "_blank";
    mapLink.rel = "noopener noreferrer";
    mapLink.setAttribute(
      "aria-label",
      `Get directions to ${incident.location}`
    );
    card.append(mapLink);
  }

  if (incident.image_url) {
    const image = document.createElement("img");
    image.className = "report-image";
    image.alt = `Photo attached to ${incident.title}`;
    image.loading = "lazy";
    card.append(image);
    loadImage(incident, image);
  }

  if (assigned) {
    const updateForm = document.createElement("form");
    updateForm.className = "worker-update-form";
    const status = document.createElement("select");
    status.className = "worker-status-select";
    status.setAttribute("aria-label", `Status for ${incident.title}`);
    statusOptions(incident.status).forEach(option => status.append(option));
    const message = document.createElement("textarea");
    message.required = true;
    message.maxLength = 1000;
    message.rows = 2;
    message.placeholder = "Progress note for the response team";
    const submit = textElement("button", "button button-primary", "Post update");
    submit.type = "submit";
    updateForm.append(status, message, submit);
    updateForm.addEventListener("submit", async event => {
      event.preventDefault();
      submit.disabled = true;
      try {
        await apiRequest(`/api/worker/assigned/${incident.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            status: status.value,
            message: message.value.trim(),
          }),
        });
        message.value = "";
        showMessage(assignedMessage, "Progress update saved.", "success");
        await loadDashboard();
      } catch (error) {
        showMessage(assignedMessage, error.message, "error");
      } finally {
        submit.disabled = false;
      }
    });
    card.append(updateForm);
  }

  const toggle = textElement("button", "updates-toggle", "View update history");
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", "false");
  const history = textElement("div", "updates-list", "");
  history.hidden = true;
  toggle.addEventListener("click", async () => {
    if (!history.hidden) {
      history.hidden = true;
      toggle.textContent = "View update history";
      toggle.setAttribute("aria-expanded", "false");
      return;
    }
    toggle.disabled = true;
    try {
      const updates = await apiRequest(
        `/api/worker/incidents/${incident.id}/updates`
      );
      renderHistory(history, updates);
      history.hidden = false;
      toggle.textContent = "Hide update history";
      toggle.setAttribute("aria-expanded", "true");
    } catch (error) {
      showMessage(assignedMessage, error.message, "error");
    } finally {
      toggle.disabled = false;
    }
  });
  card.append(toggle, history);
  return card;
}

function renderList(container, incidents, assigned) {
  container.replaceChildren();
  if (!incidents.length) {
    container.append(
      textElement(
        "p",
        "empty-state",
        assigned
          ? "No incidents have been assigned to you yet."
          : "You have not submitted a report yet."
      )
    );
    return;
  }
  incidents.forEach(incident =>
    container.append(createIncidentCard(incident, assigned))
  );
}

async function loadDashboard(notify = false) {
  try {
    const assigned = await apiRequest("/api/worker/assigned");

    if (notify && hasLoadedAssignments) {
      const changed = assigned.find(incident =>
        knownAssignments.has(incident.id) &&
        knownAssignments.get(incident.id) !== incident.latest_update_id
      );
      const newlyAssigned = assigned.find(incident =>
        !knownAssignments.has(incident.id)
      );
      if (newlyAssigned) {
        notificationBanner.textContent =
          `New incident assigned: "${newlyAssigned.title}".`;
        notificationBanner.hidden = false;
      } else if (changed) {
        notificationBanner.textContent =
          `Update on "${changed.title}": ${changed.status}. ${changed.latest_update_message || ""}`;
        notificationBanner.hidden = false;
      }
    }

    knownAssignments.clear();
    assigned.forEach(incident =>
      knownAssignments.set(incident.id, incident.latest_update_id)
    );
    hasLoadedAssignments = true;
    clearImageUrls();
    renderList(assignedList, assigned, true);
    showMessage(assignedMessage, "");
  } catch (error) {
    showMessage(assignedMessage, error.message, "error");
  }
}

document.getElementById("logoutButton").addEventListener("click", () => {
  localStorage.removeItem("cityshield_token");
  localStorage.removeItem("cityshield_user");
  window.location.assign("index.html");
});

const refreshReportsButton = document.getElementById("refreshReports");
refreshReportsButton.addEventListener("click", async () => {
  refreshReportsButton.disabled = true;
  refreshReportsButton.textContent = "↻ Refreshing...";
  try {
    await loadDashboard(true);
  } finally {
    refreshReportsButton.disabled = false;
    refreshReportsButton.textContent = "↻ Refresh";
  }
});

async function initializeWorkerDashboard() {
  if (!token) {
    window.location.assign("index.html");
    return;
  }
  try {
    const user = await apiRequest("/api/auth/me");
    if (String(user.role).toLowerCase() !== "worker") {
      localStorage.removeItem("cityshield_token");
      localStorage.removeItem("cityshield_user");
      window.location.assign("index.html");
      return;
    }
    document.getElementById("welcomeName").textContent =
      `Welcome, ${user.full_name}`;
    await loadDashboard();
    window.setInterval(() => loadDashboard(true), 30000);
  } catch (error) {
    showMessage(assignedMessage, error.message, "error");
  }
}

initializeWorkerDashboard();
