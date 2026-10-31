
const API_BASE =
  window.location.port === "5500"
    ? "http://127.0.0.1:5000"
    : window.location.origin;
const token = localStorage.getItem("cityshield_token");

const adminName = document.getElementById("adminName");
const incidentTable = document.getElementById("incidentTable");
const workerTable = document.getElementById("workerTable");
const mapMessage = document.getElementById("mapMessage");
const adminAlertList = document.getElementById("adminAlertList");
const alertForm = document.getElementById("alertForm");
const unitTable = document.getElementById("unitTable");
const resourceQueue = document.getElementById("resourceQueue");
const unitForm = document.getElementById("unitForm");
const incidentMapElement = document.getElementById("incidentMap");
const incidentMapPanel = document.querySelector(".map-panel");
const copilotForm = document.getElementById("copilotForm");
const copilotQuestion = document.getElementById("copilotQuestion");
const copilotMessage = document.getElementById("copilotMessage");
const copilotAnswer = document.getElementById("copilotAnswer");
const apiKeyForm = document.getElementById("apiKeyForm");
const apiKeyOwner = document.getElementById("apiKeyOwner");
const apiKeyTable = document.getElementById("apiKeyTable");
const apiKeyMessage = document.getElementById("apiKeyMessage");
const apiKeyCreated = document.getElementById("apiKeyCreated");
const apiKeySecret = document.getElementById("apiKeySecret");
let allWorkers = [];
let allUnits = [];
let allIncidents = [];
let allAdminAlerts = [];
let hasLoadedIncidents = false;
let hasLoadedAdminAlerts = false;
let incidentMap;
let incidentMarkers;

document.getElementById("year").textContent = new Date().getFullYear();

async function apiRequest(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.detail || `Request failed: ${response.status}`);
  }

  return data;
}

function showError(element, message) {
  element.textContent = message;
}

function safe(value) {
  const span = document.createElement("span");
  span.textContent = value ?? "";
  return span.innerHTML;
}

function incidentIsActive(item) {
  return !["resolved", "rejected"].includes(
    String(item.status || "").toLowerCase()
  );
}

function localDateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function todayDateKey() {
  return localDateKey(new Date());
}

function makeCopilotIncidentLabel(item) {
  return `#${item.id} · ${item.title || item.category || "Incident"} · ${String(item.priority || "medium").toUpperCase()} · ${item.status || "Reported"} · ${item.location || "Location not provided"} · Worker: ${item.assigned_worker || "Unassigned"} · Unit: ${item.assigned_unit || "Unassigned"}`;
}

function appendCopilotIncidentList(container, incidents) {
  if (!incidents.length) return;
  const list = document.createElement("ul");
  incidents.slice(0, 10).forEach(item => {
    const listItem = document.createElement("li");
    const details = document.createElement("span");
    details.textContent = makeCopilotIncidentLabel(item);
    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "copilot-open-incident";
    openButton.dataset.openIncident = item.id;
    openButton.textContent = "Open incident";
    listItem.append(details, openButton);
    list.appendChild(listItem);
  });
  container.appendChild(list);
  if (incidents.length > 10) {
    const more = document.createElement("p");
    more.textContent = `Showing 10 of ${incidents.length} matching incidents.`;
    container.appendChild(more);
  }
}

function showCopilotAnswer(title, paragraphs, incidents = [], alerts = [], caveat = "") {
  copilotAnswer.replaceChildren();
  const heading = document.createElement("h3");
  heading.textContent = title;
  copilotAnswer.appendChild(heading);
  paragraphs.forEach(text => {
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    copilotAnswer.appendChild(paragraph);
  });
  appendCopilotIncidentList(copilotAnswer, incidents);
  if (alerts.length) {
    const list = document.createElement("ul");
    alerts.slice(0, 8).forEach(alert => {
      const item = document.createElement("li");
      item.textContent = `${alert.title} · ${alert.category} · ${alert.affected_location}`;
      list.appendChild(item);
    });
    copilotAnswer.appendChild(list);
  }
  if (caveat) {
    const disclaimer = document.createElement("p");
    disclaimer.className = "copilot-caveat";
    disclaimer.textContent = caveat;
    copilotAnswer.appendChild(disclaimer);
  }
  copilotAnswer.hidden = false;
}

function summarizeActiveEmergencies() {
  const incidents = allIncidents.filter(incidentIsActive);
  const alerts = allAdminAlerts.filter(alert => alert.is_active);
  const critical = incidents.filter(item =>
    String(item.priority || "").toLowerCase() === "critical"
  ).length;
  const categories = [...new Set(incidents.map(item => item.category).filter(Boolean))];
  const paragraphs = [
    `${incidents.length} active incident${incidents.length === 1 ? "" : "s"} and ${alerts.length} active emergency alert${alerts.length === 1 ? "" : "s"} are recorded.`,
    `${critical} active incident${critical === 1 ? "" : "s"} marked critical${categories.length ? ` · Categories represented: ${categories.join(", ")}` : ""}.`
  ];
  showCopilotAnswer(
    "Active emergency summary",
    paragraphs,
    incidents,
    alerts,
    "“Active” means an incident is not Resolved or Rejected, or an emergency alert is flagged active. This summary only reflects data recorded in CityShield."
  );
}

function summarizeToday() {
  const today = todayDateKey();
  const incidents = allIncidents.filter(item => localDateKey(item.created_at) === today);
  const alerts = allAdminAlerts.filter(alert => localDateKey(alert.created_at) === today);
  const priorities = ["critical", "high", "medium", "low"]
    .map(priority => {
      const count = incidents.filter(item =>
        String(item.priority || "").toLowerCase() === priority
      ).length;
      return count ? `${count} ${priority}` : "";
    })
    .filter(Boolean);
  const categories = [...new Set(incidents.map(item => item.category).filter(Boolean))];
  const paragraphs = [
    `${incidents.length} incident${incidents.length === 1 ? "" : "s"} reported today and ${alerts.length} emergency alert${alerts.length === 1 ? "" : "s"} created today.`,
    `Priority breakdown: ${priorities.length ? priorities.join(", ") : "no incidents reported today"}.`,
    `Categories: ${categories.length ? categories.join(", ") : "none recorded today"}.`
  ];
  showCopilotAnswer(
    `Today's incident summary · ${new Date().toLocaleDateString()}`,
    paragraphs,
    incidents,
    alerts,
    "Today is based on the administrator's local date and report/alert creation timestamps."
  );
}

function explainCriticalIncident(query) {
  const idMatch = query.match(/\b(?:incident|report)\s*#?\s*(\d+)\b|#(\d+)\b/i);
  const targetId = idMatch ? Number(idMatch[1] || idMatch[2]) : null;
  let matches = targetId
    ? allIncidents.filter(item => Number(item.id) === targetId)
    : allIncidents.filter(item =>
        String(item.priority || "").toLowerCase() === "critical"
      );

  if (matches.length === 1) {
    const incident = matches[0];
    if (String(incident.priority || "").toLowerCase() !== "critical") {
      showCopilotAnswer(
        "Incident priority details",
        [`Incident #${incident.id} is marked ${String(incident.priority || "unknown").toUpperCase()}, not critical.`],
        [incident]
      );
      return;
    }

    const reportedDetails = String(incident.description || "").trim();
    showCopilotAnswer(
      `Why incident #${incident.id} is marked critical`,
      [
        "The incident record stores its priority as Critical, but CityShield does not record a separate explanation for who set that priority or why.",
        reportedDetails
          ? `Reported details for context (not a recorded rationale): ${reportedDetails}`
          : "No incident description is available to provide additional context."
      ],
      [incident],
      [],
      "Verify the report and contact the responsible administrator or responder for the original prioritization decision."
    );
    return;
  }

  const reason = matches.length
    ? "Multiple incidents are marked critical. Ask about a specific incident ID to view its recorded details."
    : "No incidents are currently marked critical in the loaded dashboard data.";
  showCopilotAnswer(
    "Critical-priority explanation",
    [reason, "CityShield stores the priority but does not store a separate rationale for the critical designation."],
    matches
  );
}

function answerIncidentQuestion(query) {
  const normalized = query.toLowerCase();
  const priority = ["critical", "high", "medium", "low"].find(value =>
    new RegExp(`\\b${value}\\b`).test(normalized)
  );
  const categoryMatchers = [
    ["Flooding", /\b(flood|flooding|flooded)\b/],
    ["Accident", /\b(accident|crash|collision)\b/],
    ["Waste", /\b(waste|garbage|trash|litter)\b/],
    ["Road Damage", /\b(road damage|pothole|damaged road)\b/]
  ];
  const category = categoryMatchers.find(([, pattern]) => pattern.test(normalized))?.[0];
  const requestedStatus = normalized.includes("resolved")
    ? "resolved"
    : normalized.includes("rejected")
      ? "rejected"
      : /\bin progress\b/.test(normalized)
        ? "in progress"
        : normalized.includes("under review")
          ? "under review"
          : null;
  const onlyActive = /\b(active|open|unresolved)\b/.test(normalized);
  const idMatch = normalized.match(/\b(?:incident|report)\s*#?\s*(\d+)\b|#(\d+)\b/);
  const incidentId = idMatch ? Number(idMatch[1] || idMatch[2]) : null;
  const ignoredTerms = new Set([
    "show", "me", "all", "the", "in", "city", "please", "find", "list",
    "incident", "incidents", "report", "reports", "with", "for", "of",
    "what", "is", "are", "about", "tell", "which", "give", "details",
    "status", "location", "where", "how", "many", "count", "marked",
    "priority", "active", "open", "unresolved", "critical", "high",
    "medium", "low", "flood", "flooding", "flooded", "accident",
    "crash", "collision", "waste", "garbage", "trash", "litter",
    "road", "damage", "pothole", "resolved", "rejected", "progress",
    "under", "review", "today", "daily", "summary", "summarize",
    "there", "currently", "total", "number", "happened", "happening",
    "who", "assigned", "team", "unit", "responding", "has", "been",
    "with", "by", "type", "category", "status", "at", "near", "around",
    "on", "to", "from", "and", "or"
  ]);
  const keywords = normalized
    .replace(/\b(?:incident|report)\s*#?\s*\d+\b|#\d+\b/g, " ")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter(word => word.length > 2 && !ignoredTerms.has(word));

  let matches = allIncidents.filter(item =>
    (!incidentId || Number(item.id) === incidentId) &&
    (!priority || String(item.priority || "").toLowerCase() === priority) &&
    (!category || String(item.category || "").toLowerCase() === category.toLowerCase()) &&
    (!requestedStatus || String(item.status || "").toLowerCase() === requestedStatus) &&
    (!onlyActive || incidentIsActive(item)) &&
    (!keywords.length || keywords.every(keyword =>
      [
        item.title, item.description, item.location, item.reporter,
        item.category, item.status
      ].join(" ").toLowerCase().includes(keyword)
    ))
  );
  matches = matches.slice().sort((first, second) =>
    new Date(second.created_at) - new Date(first.created_at)
  );

  const conditions = [
    priority && `${priority.toUpperCase()} priority`,
    category,
    requestedStatus && `status ${requestedStatus}`,
    onlyActive && "active"
  ].filter(Boolean);
  const filters = conditions.length ? ` matching ${conditions.join(" · ")}` : "";
  const groupedBy = ["category", "priority", "status"].find(field =>
    new RegExp(`\\bby\\s+${field}\\b`).test(normalized)
  );
  if (groupedBy && matches.length) {
    const groups = new Map();
    matches.forEach(item => {
      const key = String(item[groupedBy] || "Not recorded");
      groups.set(key, (groups.get(key) || 0) + 1);
    });
    const breakdown = [...groups.entries()]
      .map(([key, count]) => `${key}: ${count}`)
      .join(" · ");
    showCopilotAnswer(
      `Incidents grouped by ${groupedBy}`,
      [`${matches.length} incident${matches.length === 1 ? "" : "s"}${filters} · ${breakdown}`],
      matches
    );
    return;
  }
  const title = matches.length
    ? `Incident results${filters}`
    : "No matching incidents";
  const paragraphs = matches.length
    ? [`Found ${matches.length} matching incident${matches.length === 1 ? "" : "s"}${filters}. The entries below show recorded priority, status, and location.`]
    : [`No incidents matched${filters || " the search"}. Try a category, priority, location, status, or incident ID.`];
  showCopilotAnswer(title, paragraphs, matches);
}

function runCopilotQuery(rawQuery) {
  const query = rawQuery.trim();
  if (!query) return;
  copilotAnswer.hidden = true;
  copilotMessage.className = "copilot-message";
  if (!hasLoadedIncidents) {
    copilotMessage.textContent = "Incident data has not finished loading. Refresh the dashboard and try again.";
    copilotMessage.className = "copilot-message error";
    return;
  }

  copilotMessage.textContent = "Answer based on the latest data loaded in this dashboard.";
  const normalized = query.toLowerCase();
  if (/\b(today|daily|today's)\b/.test(normalized) &&
      /\b(summary|summarize|incident|report|activity)\b/.test(normalized)) {
    if (!hasLoadedAdminAlerts) {
      copilotMessage.textContent = "Emergency alert data is unavailable. Refresh the dashboard before requesting a daily summary.";
      copilotMessage.className = "copilot-message error";
      return;
    }
    summarizeToday();
    return;
  }
  if (/\b(why|explain|reason)\b/.test(normalized) &&
      /\b(critical|priority)\b/.test(normalized)) {
    explainCriticalIncident(query);
    return;
  }
  if (/\b(active|open|emergenc(?:y|ies))\b/.test(normalized) &&
      /\b(summary|summarize|emergenc(?:y|ies)|all)\b/.test(normalized)) {
    if (!hasLoadedAdminAlerts) {
      copilotMessage.textContent = "Emergency alert data is unavailable. Refresh the dashboard before requesting an active-emergencies summary.";
      copilotMessage.className = "copilot-message error";
      return;
    }
    summarizeActiveEmergencies();
    return;
  }
  answerIncidentQuestion(query);
}

function buildResponseRecommendation(item) {
  const category = String(item.category || "").toLowerCase();
  const priority = String(item.priority || "medium").toLowerCase();
  const description = String(item.description || "").toLowerCase();
  const critical = priority === "critical";
  const elevated = critical || priority === "high";
  const reportsInjury =
    /\b(injur(?:y|ies|ed)|bleeding|unconscious|trapped|casualt(?:y|ies)|hurt)\b/.test(description);
  const reportsFlooding =
    /\b(flood(?:ed|ing)?|water ?level|waterlogging|water ?logged|submerged|overflow(?:ing)?)\b/.test(description);
  const reportsHazard =
    /\b(chemical|hazard(?:ous)?|spill|toxic|sharp|contaminat(?:ed|ion))\b/.test(description);
  const teams = [];
  const actions = [
    "Confirm the exact location, immediate hazards, and whether anyone is injured; keep the incident details current."
  ];
  const safety = [];

  const addTeam = (unitType, reason) => teams.push({ unitType, reason });

  if (category === "flooding") {
    addTeam("Municipal Crew", "Inspect drainage and address blockage only when the work area is safe.");
    if (elevated || reportsFlooding || reportsInjury) {
      addTeam("Rescue Team", "Assess evacuation or water-rescue needs from safe ground.");
    }
    actions.push(
      "Assess nearby roads and low-lying areas for closure; coordinate alternate routes with the relevant traffic authority.",
      "If people are trapped, injured, or in immediate danger, contact local emergency services and request the appropriate rescue support."
    );
    safety.push(
      "Do not enter floodwater or attempt an in-water rescue; it may hide currents, debris, open drains, or electrical hazards.",
      "Keep responders and residents away from flooded roads until they are confirmed safe."
    );
  } else if (category === "accident") {
    addTeam("Ambulance", reportsInjury || elevated
      ? "Prioritize medical assessment based on the reported injuries or urgency."
      : "Keep medical response available while the scene and injury status are confirmed.");
    if (reportsInjury || elevated || /\b(trapped|fire|smoke|vehicle rollover)\b/.test(description)) {
      addTeam("Rescue Team", "Assess extrication or additional scene hazards if needed.");
    }
    actions.push(
      "Coordinate traffic control and scene access with the relevant local authority.",
      "Confirm the number and condition of people involved before updating the response plan."
    );
    safety.push(
      "Keep bystanders clear of traffic, fire, damaged vehicles, and any leaking substances.",
      "Do not move an injured person unless leaving them in place presents an immediate danger."
    );
  } else if (category === "waste") {
    addTeam("Municipal Crew", "Arrange safe cleanup and proper disposal of the reported waste.");
    if (reportsHazard) {
      actions.push(
        "Treat the material as potentially hazardous until identified; request the appropriate specialist team through local incident command."
      );
      safety.push(
        "Keep people away from unknown spills or sharp/contaminated waste; do not touch or attempt cleanup without suitable training and equipment."
      );
    } else {
      safety.push("Keep residents away from the waste and any associated sharp objects or blocked pathways.");
    }
    actions.push("Check whether the waste is blocking a drain, road, or public access route.");
  } else if (category === "road damage") {
    addTeam("Municipal Crew", "Inspect the damaged road and arrange repair or temporary barriers.");
    actions.push(
      "Assess whether the affected lane or road needs a temporary closure, then coordinate detours with the relevant traffic authority.",
      "Escalate immediately if the damage is worsening or creates a risk of collapse."
    );
    safety.push(
      "Keep people and vehicles away from unstable edges, sinkholes, exposed utilities, and damaged structures."
    );
  } else {
    actions.push("Have the duty officer review the report and select the appropriate specialist response.");
    safety.push("Keep the public clear of any unassessed hazards until responders confirm the area is safe.");
  }

  if (elevated) {
    actions.unshift(
      `${priority.toUpperCase()} priority: have the duty officer review this promptly and coordinate with local emergency services if there is immediate danger.`
    );
  }

  return { teams, actions, safety };
}

function createRecommendationContent(item) {
  const recommendation = buildResponseRecommendation(item);
  const content = document.createElement("div");
  content.className = "recommendation-content";

  const heading = document.createElement("div");
  heading.className = "recommendation-heading";
  const title = document.createElement("h3");
  title.textContent = "AI Emergency Response Recommendation";
  heading.appendChild(title);
  heading.appendChild(
    document.createTextNode(
      `Based on ${item.category || "the incident"} · ${String(item.priority || "medium").toUpperCase()} priority`
    )
  );
  content.appendChild(heading);

  const details = document.createElement("p");
  details.className = "recommendation-evidence";
  const description = String(item.description || "");
  details.textContent = description
    ? `Report details considered: ${description.slice(0, 360)}${description.length > 360 ? "…" : ""}`
    : "No description was provided; recommendations are based on the incident category and priority.";
  content.appendChild(details);

  const teamsHeading = document.createElement("h4");
  teamsHeading.textContent = "Suggested response teams";
  content.appendChild(teamsHeading);
  const teamsList = document.createElement("ul");
  recommendation.teams.forEach(team => {
    const listItem = document.createElement("li");
    const matchingUnits = allUnits.filter(unit =>
      unit.unit_type === team.unitType && unit.availability === "Available"
    );
    const teamName = document.createElement("strong");
    teamName.textContent = `${team.unitType}: `;
    listItem.append(teamName, document.createTextNode(team.reason));
    if (matchingUnits.length) {
      const availability = document.createElement("span");
      availability.className = "recommendation-availability";
      availability.textContent =
        ` Available: ${matchingUnits.map(unit => unit.code).join(", ")}.`;
      listItem.appendChild(availability);
    } else {
      const availability = document.createElement("span");
      availability.className = "recommendation-availability unavailable";
      availability.textContent = " No matching registered unit is currently available.";
      listItem.appendChild(availability);
    }
    teamsList.appendChild(listItem);
  });
  content.appendChild(teamsList);

  const appendList = (label, items) => {
    const sectionHeading = document.createElement("h4");
    sectionHeading.textContent = label;
    content.appendChild(sectionHeading);
    const list = document.createElement("ul");
    items.forEach(text => {
      const listItem = document.createElement("li");
      listItem.textContent = text;
      list.appendChild(listItem);
    });
    content.appendChild(list);
  };
  appendList("Suggested action plan", recommendation.actions);
  appendList("Safety instructions", recommendation.safety);

  const disclaimer = document.createElement("p");
  disclaimer.className = "recommendation-disclaimer";
  disclaimer.textContent =
    "Rule-based guidance from the reported category, priority, and description. Review and verify before assigning resources; this does not dispatch teams or replace emergency command.";
  content.appendChild(disclaimer);
  return content;
}

// Check that the logged-in account is an administrator.
async function verifyAdmin() {
  if (!token) {
    window.location.href = "index.html";
    return false;
  }

  try {
    const user = await apiRequest("/api/auth/me");

    if (String(user.role || "").toLowerCase() !== "admin") {
      alert("Access denied. Admin account required.");
      localStorage.removeItem("cityshield_token");
      localStorage.removeItem("cityshield_user");
      window.location.href = "index.html";
      return false;
    }

    adminName.textContent = user.full_name || "Administrator";
    return true;
  } catch (error) {
    alert("Your session has expired. Please log in again.");
    localStorage.removeItem("cityshield_token");
    localStorage.removeItem("cityshield_user");
    window.location.href = "index.html";
    return false;
  }
}

function renderIncidents(items) {
  const filter = document.getElementById("incidentFilter").value;
  const filtered = items.filter(item =>
    filter === "all" ||
    String(item.priority || "").toLowerCase() === filter
  );

  incidentTable.innerHTML = "";

  if (!filtered.length) {
    incidentTable.innerHTML =
      '<tr><td colspan="7" class="empty">No incidents found.</td></tr>';
    return;
  }

  filtered.forEach(item => {
    const row = document.createElement("tr");
    row.id = `incident-${item.id}`;
    const recommendationId = `recommendation-${item.id}`;
    const priority = String(item.priority || "medium").toLowerCase();

    const statuses = [
      "Reported",
      "Under Review",
      "In Progress",
      "Resolved",
      "Rejected"
    ];
    const statusOptions = statuses.map(status =>
      `<option value="${safe(status)}" ${item.status === status ? "selected" : ""}>${safe(status)}</option>`
    ).join("");
    const workerOptions = [
      '<option value="">Unassigned</option>',
      ...allWorkers
        .filter(worker => worker.is_active)
        .map(worker =>
          `<option value="${worker.id}" ${item.assigned_worker_id === worker.id ? "selected" : ""}>${safe(worker.full_name)}</option>`
        )
    ].join("");
    const unitOptions = [
      `<option value="" ${item.assigned_unit_id ? "" : "selected"}>No unit assigned</option>`,
      ...allUnits
        .filter(unit =>
          unit.availability === "Available" ||
          unit.id === item.assigned_unit_id
        )
        .map(unit =>
          `<option value="${unit.id}" ${item.assigned_unit_id === unit.id ? "selected" : ""}>${safe(unit.code)} · ${safe(unit.unit_type)}</option>`
        )
    ].join("");

    row.innerHTML = `
      <td>
        ${safe(item.title || item.description || "Incident")}
        <button type="button" class="recommendation-toggle" data-recommendation-for="${item.id}" aria-expanded="false" aria-controls="${recommendationId}">
          View response recommendation
        </button>
      </td>
      <td>${safe(item.location || "Not provided")}</td>
      <td><span class="priority ${safe(priority)}">${safe(priority.toUpperCase())}</span></td>
      <td>
        <span class="status-pill">${safe(item.status || "Reported")}</span>
        <div class="incident-actions">
          <select aria-label="Update status for ${safe(item.title || "incident")}" data-status-for="${item.id}">
            ${statusOptions}
          </select>
          <button type="button" class="outline-btn" data-update-incident="${item.id}">Update</button>
        </div>
      </td>
      <td>
        <span>${safe(item.assigned_worker || "Unassigned")}</span>
        <div class="incident-actions">
          <select aria-label="Assign ${safe(item.title || "incident")}" data-worker-for="${item.id}">
            ${workerOptions}
          </select>
          <button type="button" class="outline-btn" data-assign-incident="${item.id}">Assign</button>
        </div>
      </td>
      <td>
        <span>${safe(item.assigned_unit || "No unit assigned")}</span>
        <div class="incident-actions">
          <select aria-label="Assign response unit to ${safe(item.title || "incident")}" data-unit-for="${item.id}">
            ${unitOptions}
          </select>
          <button type="button" class="outline-btn" data-assign-unit="${item.id}">Assign unit</button>
        </div>
      </td>
      <td>${safe(item.created_at ? new Date(item.created_at).toLocaleDateString() : "—")}</td>
    `;
    incidentTable.appendChild(row);

    const recommendationRow = document.createElement("tr");
    recommendationRow.className = "recommendation-row";
    recommendationRow.hidden = true;
    recommendationRow.id = recommendationId;
    const recommendationCell = document.createElement("td");
    recommendationCell.colSpan = 7;
    recommendationCell.appendChild(createRecommendationContent(item));
    recommendationRow.appendChild(recommendationCell);
    incidentTable.appendChild(recommendationRow);
  });
}

function renderResourceUnits(units) {
  unitTable.innerHTML = "";
  if (!units.length) {
    unitTable.innerHTML =
      '<tr><td colspan="5" class="empty">No response units have been added.</td></tr>';
    return;
  }

  units.forEach(unit => {
    const row = document.createElement("tr");
    const availabilityClass = unit.availability
      .toLowerCase()
      .replaceAll(" ", "-");
    const incidentLabel = unit.assigned_incident_title
      ? `${unit.assigned_incident_title} (${String(unit.assigned_incident_priority || "").toUpperCase()})`
      : "—";
    row.innerHTML = `
      <td>${safe(unit.name)} <small>(${safe(unit.code)})</small></td>
      <td>${safe(unit.unit_type)}</td>
      <td><span class="unit-availability ${availabilityClass}">${safe(unit.availability)}</span></td>
      <td>${safe(incidentLabel)}</td>
      <td>
        ${
          unit.availability === "Deployed"
            ? "In use"
            : `<button type="button" class="outline-btn" data-toggle-unit="${unit.id}" data-in-service="${unit.is_in_service}">${
                unit.is_in_service ? "Take out of service" : "Return to service"
              }</button>`
        }
      </td>
    `;
    unitTable.appendChild(row);
  });
}

function renderResourceQueue(items) {
  const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  const queue = items
    .filter(item => !["Resolved", "Rejected"].includes(item.status))
    .slice()
    .sort((first, second) => {
      const priorityDifference =
        (priorityOrder[String(first.priority || "").toLowerCase()] ?? 4) -
        (priorityOrder[String(second.priority || "").toLowerCase()] ?? 4);
      if (priorityDifference !== 0) return priorityDifference;
      return new Date(first.created_at) - new Date(second.created_at);
    });

  resourceQueue.innerHTML = "";
  if (!queue.length) {
    resourceQueue.innerHTML =
      '<tr><td colspan="5" class="empty">No open incidents are waiting for response.</td></tr>';
    return;
  }

  queue.forEach(item => {
    const row = document.createElement("tr");
    const priority = String(item.priority || "medium").toLowerCase();
    row.innerHTML = `
      <td><span class="priority ${safe(priority)}">${safe(priority.toUpperCase())}</span></td>
      <td>${safe(item.title || "Incident")}</td>
      <td>${safe(item.location || "Not provided")}</td>
      <td>${safe(item.assigned_unit || "Unassigned")}</td>
      <td><span class="status-pill">${safe(item.status || "Reported")}</span></td>
    `;
    resourceQueue.appendChild(row);
  });
}

function updatePriorityCounts(items) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  items.forEach(item => {
    const priority = String(item.priority || "").toLowerCase();
    if (Object.prototype.hasOwnProperty.call(counts, priority)) {
      counts[priority] += 1;
    }
  });

  Object.entries(counts).forEach(([priority, count]) => {
    document.getElementById(`${priority}Incidents`).textContent = count;
  });
}

async function loadResourceUnits() {
  try {
    const units = await apiRequest("/api/admin/units");
    allUnits = Array.isArray(units) ? units : [];
    renderResourceUnits(allUnits);
    renderIncidents(allIncidents);
  } catch (error) {
    unitTable.innerHTML =
      '<tr><td colspan="5" class="empty">Response units could not be loaded.</td></tr>';
    console.error("Response units:", error.message);
  }
}

function renderAdminAlerts(alerts) {
  adminAlertList.innerHTML = "";
  if (!alerts.length) {
    adminAlertList.innerHTML = '<p class="empty">No emergency alerts have been sent.</p>';
    return;
  }

  alerts.forEach(alert => {
    const card = document.createElement("article");
    card.className = `admin-alert-card${alert.is_active ? "" : " closed"}`;
    card.innerHTML = `
      <h4>${safe(alert.title)}</h4>
      <div class="admin-alert-meta">${safe(alert.category)} · ${safe(alert.affected_location)} · ${
        alert.is_active ? "Active" : "Closed"
      } · ${safe(alert.created_at ? new Date(alert.created_at).toLocaleString() : "")}</div>
      <p>${safe(alert.instructions)}</p>
      ${
        alert.is_active
          ? `<div class="admin-alert-actions"><button type="button" class="outline-btn" data-close-alert="${alert.id}">Close alert</button></div>`
          : ""
      }
    `;
    adminAlertList.appendChild(card);
  });
}

async function loadAdminAlerts() {
  try {
    const alerts = await apiRequest("/api/admin/alerts");
    allAdminAlerts = Array.isArray(alerts) ? alerts : [];
    hasLoadedAdminAlerts = true;
    renderAdminAlerts(allAdminAlerts);
  } catch (error) {
    hasLoadedAdminAlerts = false;
    adminAlertList.innerHTML =
      '<p class="empty">Emergency alerts could not be loaded.</p>';
    console.error("Emergency alerts:", error.message);
  }
}

function formatApiKeyDate(value) {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

async function loadApiKeyOwners() {
  try {
    const users = await apiRequest("/api/admin/api-keys/users");
    apiKeyOwner.replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Select an active account";
    apiKeyOwner.appendChild(placeholder);

    users.forEach(user => {
      const option = document.createElement("option");
      option.value = user.id;
      option.textContent = `${user.full_name} · ${user.role} · #${user.id}`;
      apiKeyOwner.appendChild(option);
    });
    if (!users.length) {
      apiKeyMessage.textContent = "No active accounts are available for API keys.";
    }
  } catch (error) {
    apiKeyOwner.replaceChildren();
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Accounts could not be loaded";
    apiKeyOwner.appendChild(option);
    apiKeyMessage.textContent = error.message;
    apiKeyMessage.classList.add("error");
  }
}

async function loadApiKeys() {
  try {
    const keys = await apiRequest("/api/admin/api-keys");
    apiKeyTable.replaceChildren();
    if (!keys.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 7;
      cell.className = "empty";
      cell.textContent = "No API keys have been created.";
      row.appendChild(cell);
      apiKeyTable.appendChild(row);
      return;
    }

    keys.forEach(key => {
      const row = document.createElement("tr");
      const expired = key.expires_at && new Date(key.expires_at) <= new Date();
      const status = key.revoked_at
        ? "Revoked"
        : expired
          ? "Expired"
          : "Active";
      row.innerHTML = `
        <td>${safe(key.name)}<small class="api-key-prefix">${safe(key.key_prefix)}…</small></td>
        <td>${safe(key.owner_name)} <small>(${safe(key.owner_role)})</small></td>
        <td>${key.access_level === "read_only" ? "Read only" : "Read/write"}</td>
        <td>${safe(formatApiKeyDate(key.created_at))}</td>
        <td>${safe(formatApiKeyDate(key.expires_at))}</td>
        <td><span class="api-key-status ${status.toLowerCase()}">${status}</span></td>
        <td>${status === "Active" ? `<button type="button" class="outline-btn" data-revoke-api-key="${key.id}">Revoke</button>` : "—"}</td>
      `;
      apiKeyTable.appendChild(row);
    });
  } catch (error) {
    apiKeyTable.innerHTML =
      `<tr><td colspan="7" class="empty">${safe(error.message)}</td></tr>`;
  }
}

function initializeIncidentMap(center) {
  if (!window.L) {
    mapMessage.textContent =
      "The map could not load. Check your internet connection and refresh.";
    console.error("Leaflet did not load; incident map is unavailable.");
    return false;
  }

  if (incidentMap) return true;

  incidentMap = window.L.map(incidentMapElement).setView(center, 14);
  const tileLayer = window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19
  }).addTo(incidentMap);
  tileLayer.on("tileerror", () => {
    mapMessage.textContent =
      "Map tiles could not load. Check your internet connection and refresh.";
  });
  window.L.control.scale({ imperial: false }).addTo(incidentMap);
  incidentMarkers = window.L.layerGroup().addTo(incidentMap);
  return true;
}

function hasIncidentCoordinates(item) {
  if (
    item.latitude === null ||
    item.latitude === undefined ||
    item.longitude === null ||
    item.longitude === undefined ||
    item.latitude === "" ||
    item.longitude === ""
  ) {
    return false;
  }

  const latitude = Number(item.latitude);
  const longitude = Number(item.longitude);
  return Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180;
}

function renderIncidentMap(items) {
  const priorityFilter = document.getElementById("mapPriorityFilter").value;
  const locatedIncidents = items.filter(item =>
    hasIncidentCoordinates(item) &&
    (priorityFilter === "all" ||
      String(item.priority || "").toLowerCase() === priorityFilter)
  );
  const allLocatedCount = items.filter(hasIncidentCoordinates).length;
  const unlocatedCount = items.length - allLocatedCount;
  mapMessage.textContent = locatedIncidents.length
    ? `${locatedIncidents.length} coordinate-based case${locatedIncidents.length === 1 ? "" : "s"} on map${
        priorityFilter !== "all" ? ` · ${priorityFilter} priority` : ""
      }${
        unlocatedCount && priorityFilter === "all"
          ? ` · ${unlocatedCount} report${unlocatedCount === 1 ? "" : "s"} without shared coordinates`
          : ""
      }.`
    : allLocatedCount && priorityFilter !== "all"
      ? `No ${priorityFilter} priority reports with shared coordinates.`
      : "";

  if (!locatedIncidents.length) {
    if (incidentMarkers) incidentMarkers.clearLayers();
    incidentMapElement.hidden = true;
    incidentMapPanel.classList.remove("map-has-locations");
    return;
  }

  const firstIncident = locatedIncidents[0];
  incidentMapElement.hidden = false;
  if (!initializeIncidentMap([
    Number(firstIncident.latitude),
    Number(firstIncident.longitude)
  ])) {
    incidentMapElement.hidden = true;
    incidentMapPanel.classList.remove("map-has-locations");
    return;
  }

  incidentMapPanel.classList.add("map-has-locations");
  incidentMarkers.clearLayers();
  const priorityColors = {
    critical: "#d43f3f",
    high: "#d47b1e",
    medium: "#c4a000",
    low: "#25834a"
  };
  const coordinates = [];

  locatedIncidents.forEach(item => {
    const latitude = Number(item.latitude);
    const longitude = Number(item.longitude);
    const priority = String(item.priority || "medium").toLowerCase();
    const color = priorityColors[priority] || priorityColors.medium;
    const marker = window.L.marker([latitude, longitude], {
      icon: window.L.divIcon({
        className: "priority-map-marker",
        html: `<span style="--marker-color:${color}">${safe(priority.charAt(0).toUpperCase())}</span>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14]
      })
    });
    const title = safe(item.title || item.description || "Incident");
    const location = safe(item.location || "Location not provided");
    const status = safe(item.status || "Reported");
    marker.bindPopup(`
      <div class="incident-popup">
        <strong>${title}</strong>
        <span>${safe(priority.toUpperCase())} · ${status}</span>
        <span>${location}</span>
      </div>
    `);
    marker.addTo(incidentMarkers);
    coordinates.push([latitude, longitude]);
  });

  if (coordinates.length === 1) {
    incidentMap.setView(coordinates[0], 13);
  } else if (new Set(coordinates.map(point => point.join(","))).size === 1) {
    incidentMap.setView(coordinates[0], 14);
  } else {
    incidentMap.fitBounds(coordinates, { padding: [36, 36], maxZoom: 14 });
  }
  window.requestAnimationFrame(() => incidentMap.invalidateSize());
}

async function loadDashboard() {
  try {
    const stats = await apiRequest("/api/admin/stats");

    document.getElementById("totalIncidents").textContent =
      stats.total_incidents ?? 0;
    document.getElementById("totalWorkers").textContent =
      stats.total_workers ?? 0;
  } catch (error) {
    console.error("Statistics:", error.message);
  }

  await loadWorkers();
  await loadResourceUnits();

  try {
    const data = await apiRequest("/api/admin/incidents");
    allIncidents = Array.isArray(data) ? data : data.items || [];
    hasLoadedIncidents = true;
    updatePriorityCounts(allIncidents);
    renderIncidentMap(allIncidents);
    renderIncidents(allIncidents);
    renderResourceQueue(allIncidents);
  } catch (error) {
    hasLoadedIncidents = false;
    updatePriorityCounts([]);
    renderIncidentMap([]);
    allIncidents = [];
    renderResourceQueue([]);
    incidentTable.innerHTML =
      '<tr><td colspan="7" class="empty">Incident API is not connected yet.</td></tr>';
    console.error(error);
  }

  await loadAdminAlerts();
}

async function loadWorkers() {
  try {
    const data = await apiRequest("/api/admin/workers");
    const workers = Array.isArray(data) ? data : data.items || [];
    allWorkers = workers;

    workerTable.innerHTML = "";

    if (!workers.length) {
      workerTable.innerHTML =
        '<tr><td colspan="4" class="empty">No workers added yet.</td></tr>';
      return;
    }

    workers.forEach(worker => {
      const row = document.createElement("tr");
      row.innerHTML = `
        <td>${safe(worker.full_name)}</td>
        <td>${safe(worker.email)}</td>
        <td>${safe(worker.specialization || "General")}</td>
        <td><span class="status-pill">${worker.is_active ? "Active" : "Inactive"}</span></td>
      `;
      workerTable.appendChild(row);
    });
    renderIncidents(allIncidents);
  } catch (error) {
    workerTable.innerHTML =
      '<tr><td colspan="4" class="empty">Worker API is not connected yet.</td></tr>';
    console.error(error);
  }
}

const workerForm = document.getElementById("workerForm");

unitForm.addEventListener("submit", async event => {
  event.preventDefault();
  const message = document.getElementById("unitMessage");
  const submitButton = unitForm.querySelector('[type="submit"]');
  const formData = new FormData(unitForm);
  const unit = {
    name: formData.get("name").trim(),
    unit_type: formData.get("unit_type"),
    code: formData.get("code").trim()
  };

  submitButton.disabled = true;
  submitButton.textContent = "Adding unit...";
  try {
    await apiRequest("/api/admin/units", {
      method: "POST",
      body: JSON.stringify(unit)
    });
    unitForm.reset();
    message.textContent = "Response unit added.";
    message.style.color = "#25834a";
    await loadDashboard();
  } catch (error) {
    message.textContent = error.message;
    message.style.color = "#c34242";
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Add Response Unit";
  }
});

unitTable.addEventListener("click", async event => {
  const button = event.target.closest("[data-toggle-unit]");
  if (!button) return;

  const unitId = button.dataset.toggleUnit;
  const isInService = button.dataset.inService === "true";
  button.disabled = true;
  try {
    await apiRequest(`/api/admin/units/${unitId}`, {
      method: "PATCH",
      body: JSON.stringify({ is_in_service: !isInService })
    });
    await loadDashboard();
  } catch (error) {
    document.getElementById("unitMessage").textContent = error.message;
    document.getElementById("unitMessage").style.color = "#c34242";
    button.disabled = false;
  }
});

alertForm.addEventListener("submit", async event => {
  event.preventDefault();
  const message = document.getElementById("alertMessage");
  const submitButton = alertForm.querySelector('[type="submit"]');
  const formData = new FormData(alertForm);
  const alert = {
    title: formData.get("title").trim(),
    category: formData.get("category"),
    affected_location: formData.get("affected_location").trim(),
    instructions: formData.get("instructions").trim(),
    verified: formData.get("verified") === "on"
  };

  submitButton.disabled = true;
  submitButton.textContent = "Sending alert...";
  try {
    await apiRequest("/api/admin/alerts", {
      method: "POST",
      body: JSON.stringify(alert)
    });
    alertForm.reset();
    message.textContent = "Emergency alert sent to all residents.";
    message.style.color = "#25834a";
    await loadAdminAlerts();
  } catch (error) {
    message.textContent = error.message;
    message.style.color = "#c34242";
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Send alert to all residents";
  }
});

adminAlertList.addEventListener("click", async event => {
  const button = event.target.closest("[data-close-alert]");
  if (!button) return;

  button.disabled = true;
  try {
    await apiRequest(`/api/admin/alerts/${button.dataset.closeAlert}`, {
      method: "PATCH",
      body: JSON.stringify({ is_active: false })
    });
    await loadAdminAlerts();
  } catch (error) {
    document.getElementById("alertMessage").textContent = error.message;
    document.getElementById("alertMessage").style.color = "#c34242";
    button.disabled = false;
  }
});

// Create a worker using the protected admin API.
workerForm.addEventListener("submit", async event => {
  event.preventDefault();

  const message = document.getElementById("workerMessage");
  const submitButton = workerForm.querySelector('[type="submit"]');
  const formData = new FormData(workerForm);

  const worker = {
    full_name: formData.get("full_name").trim(),
    email: formData.get("email").trim(),
    phone: formData.get("phone").trim(),
    specialization: formData.get("specialization"),
    password: formData.get("password")
  };

  submitButton.disabled = true;
  submitButton.textContent = "Creating...";

  try {
    await apiRequest("/api/admin/workers", {
      method: "POST",
      body: JSON.stringify(worker)
    });

    message.textContent = "Worker account created successfully.";
    message.style.color = "green";
    workerForm.reset();
    document.getElementById("workerMessage").scrollIntoView({
      behavior: "smooth",
      block: "nearest"
    });
    await loadDashboard();
  } catch (error) {
    message.textContent = error.message;
    message.style.color = "#c34242";
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Create Worker";
  }
});

document.getElementById("incidentFilter").addEventListener("change", () => {
  renderIncidents(allIncidents);
});

copilotForm.addEventListener("submit", event => {
  event.preventDefault();
  runCopilotQuery(copilotQuestion.value);
});

document.querySelectorAll("[data-copilot-prompt]").forEach(button => {
  button.addEventListener("click", () => {
    copilotQuestion.value = button.dataset.copilotPrompt;
    runCopilotQuery(copilotQuestion.value);
  });
});

copilotAnswer.addEventListener("click", event => {
  const button = event.target.closest("[data-open-incident]");
  if (!button) return;
  document.getElementById("incidentFilter").value = "all";
  renderIncidents(allIncidents);
  const incidentRow = document.getElementById(`incident-${button.dataset.openIncident}`);
  if (!incidentRow) return;
  incidentRow.scrollIntoView({ behavior: "smooth", block: "center" });
  incidentRow.classList.add("copilot-incident-highlight");
  window.setTimeout(
    () => incidentRow.classList.remove("copilot-incident-highlight"),
    1800
  );
});

document.getElementById("mapPriorityFilter").addEventListener("change", () => {
  renderIncidentMap(allIncidents);
});

incidentTable.addEventListener("click", async event => {
  const recommendationButton = event.target.closest("[data-recommendation-for]");
  if (recommendationButton) {
    const recommendation = document.getElementById(
      recommendationButton.getAttribute("aria-controls")
    );
    recommendation.hidden = !recommendation.hidden;
    recommendationButton.setAttribute(
      "aria-expanded",
      String(!recommendation.hidden)
    );
    recommendationButton.textContent = recommendation.hidden
      ? "View response recommendation"
      : "Hide response recommendation";
    return;
  }

  const unitButton = event.target.closest("[data-assign-unit]");
  if (unitButton) {
    const incidentId = unitButton.dataset.assignUnit;
    const unitId = incidentTable.querySelector(
      `[data-unit-for="${incidentId}"]`
    ).value;
    unitButton.disabled = true;
    try {
      await apiRequest(`/api/admin/incidents/${incidentId}`, {
        method: "PATCH",
        body: JSON.stringify({
          assigned_unit_id: unitId ? Number(unitId) : null
        })
      });
      document.getElementById("incidentMessage").textContent =
        "Response unit assignment saved.";
      await loadDashboard();
    } catch (error) {
      document.getElementById("incidentMessage").textContent = error.message;
    } finally {
      unitButton.disabled = false;
    }
    return;
  }

  const assignButton = event.target.closest("[data-assign-incident]");
  if (assignButton) {
    const incidentId = assignButton.dataset.assignIncident;
    const workerId = incidentTable.querySelector(
      `[data-worker-for="${incidentId}"]`
    ).value;
    assignButton.disabled = true;
    try {
      await apiRequest(`/api/admin/incidents/${incidentId}`, {
        method: "PATCH",
        body: JSON.stringify({
          assigned_worker_id: workerId ? Number(workerId) : null
        })
      });
      document.getElementById("incidentMessage").textContent =
        "Worker assignment saved.";
      await loadDashboard();
    } catch (error) {
      document.getElementById("incidentMessage").textContent = error.message;
    } finally {
      assignButton.disabled = false;
    }
    return;
  }

  const button = event.target.closest("[data-update-incident]");
  if (!button) return;

  const incidentId = button.dataset.updateIncident;
  const status = incidentTable.querySelector(
    `[data-status-for="${incidentId}"]`
  ).value;
  const message = window.prompt(
    "Optional incident update:",
    ""
  );
  if (message === null) return;

  button.disabled = true;
  try {
    await apiRequest(`/api/admin/incidents/${incidentId}`, {
      method: "PATCH",
      body: JSON.stringify({ status, message: message.trim() })
    });
    document.getElementById("incidentMessage").textContent =
      "Incident status updated.";
    await loadDashboard();
  } catch (error) {
    document.getElementById("incidentMessage").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

apiKeyForm.addEventListener("submit", async event => {
  event.preventDefault();
  apiKeyMessage.textContent = "";
  apiKeyMessage.classList.remove("error");
  apiKeyCreated.hidden = true;
  const submitButton = apiKeyForm.querySelector('[type="submit"]');
  const formData = new FormData(apiKeyForm);
  const expiresInDays = formData.get("expires_in_days");
  const payload = {
    name: String(formData.get("name") || "").trim(),
    owner_user_id: Number(formData.get("owner_user_id")),
    access_level: formData.get("access_level"),
    expires_in_days: expiresInDays ? Number(expiresInDays) : null
  };

  submitButton.disabled = true;
  submitButton.textContent = "Creating key...";
  try {
    const result = await apiRequest("/api/admin/api-keys", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    apiKeySecret.value = result.key;
    apiKeySecret.type = "password";
    document.getElementById("toggleApiKeySecret").textContent = "Show";
    apiKeyCreated.hidden = false;
    apiKeyForm.reset();
    apiKeyMessage.textContent =
      `Created ${result.access_level.replace("_", " ")} key for ${result.owner_name} (${result.owner_role}). Copy it now; it cannot be retrieved again.`;
    await loadApiKeys();
  } catch (error) {
    apiKeyMessage.textContent = error.message;
    apiKeyMessage.classList.add("error");
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Create API Key";
  }
});

document.getElementById("toggleApiKeySecret").addEventListener("click", event => {
  const button = event.currentTarget;
  const isHidden = apiKeySecret.type === "password";
  apiKeySecret.type = isHidden ? "text" : "password";
  button.textContent = isHidden ? "Hide" : "Show";
});

document.getElementById("copyApiKeySecret").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(apiKeySecret.value);
    apiKeyMessage.textContent = "API key copied. Store it securely; it will not be shown again after leaving this page.";
    apiKeyMessage.classList.remove("error");
  } catch (error) {
    apiKeyMessage.textContent =
      "Could not access the clipboard. Use Show, then select and copy the key manually.";
    apiKeyMessage.classList.add("error");
    console.error("API key clipboard copy failed:", error.message);
  }
});

apiKeyTable.addEventListener("click", async event => {
  const button = event.target.closest("[data-revoke-api-key]");
  if (!button) return;
  button.disabled = true;
  try {
    await apiRequest(`/api/admin/api-keys/${button.dataset.revokeApiKey}`, {
      method: "PATCH",
      body: JSON.stringify({ revoked: true })
    });
    apiKeyMessage.textContent = "API key revoked.";
    apiKeyMessage.classList.remove("error");
    if (apiKeySecret.value) {
      apiKeySecret.value = "";
      apiKeyCreated.hidden = true;
    }
    await loadApiKeys();
  } catch (error) {
    apiKeyMessage.textContent = error.message;
    apiKeyMessage.classList.add("error");
    button.disabled = false;
  }
});

const refreshButton = document.getElementById("refreshBtn");
refreshButton.addEventListener("click", async () => {
  refreshButton.disabled = true;
  refreshButton.textContent = "↻ Refreshing...";
  try {
    await loadDashboard();
  } finally {
    refreshButton.disabled = false;
    refreshButton.textContent = "↻ Refresh";
  }
});

document.getElementById("logoutBtn").addEventListener("click", () => {
  localStorage.removeItem("cityshield_token");
  localStorage.removeItem("cityshield_user");
  window.location.href = "index.html";
});

document.getElementById("menuBtn").addEventListener("click", () => {
  document.getElementById("sidebar").classList.toggle("open");
});

document.querySelectorAll(".nav-link").forEach(link => {
  link.addEventListener("click", () => {
    document.querySelectorAll(".nav-link").forEach(item =>
      item.classList.remove("active")
    );
    link.classList.add("active");
    document.getElementById("sidebar").classList.remove("open");
  });
});

// Initialize only after checking the administrator's identity.
(async function initializeDashboard() {
  const isAdmin = await verifyAdmin();

  if (isAdmin) {
    await loadDashboard();
  }
})();
