const API_BASE =
  window.location.port === "5500"
    ? "http://127.0.0.1:5000"
    : window.location.origin;
const token = localStorage.getItem("cityshield_token");
const reportForm = document.getElementById("reportForm");
const reportList = document.getElementById("reportList");
const formMessage = document.getElementById("formMessage");
const reportsMessage = document.getElementById("reportsMessage");
const notificationBanner = document.getElementById("notificationBanner");
const imageInput = document.getElementById("imageInput");
const imagePreview = document.getElementById("imagePreview");
const imageUrls = new Set();
const knownUpdates = new Map();
const emergencyAlertList = document.getElementById("emergencyAlertList");
const emergencyAlertsMessage = document.getElementById("emergencyAlertsMessage");
const knownEmergencyAlerts = new Set();
const facilitySearchButton = document.getElementById("facilitySearchButton");
const facilitySearchMessage = document.getElementById("facilitySearchMessage");
const facilityRecommendation = document.getElementById("facilityRecommendation");
const facilityResults = document.getElementById("facilityResults");
const voiceLanguage = document.getElementById("voiceLanguage");
const startVoiceReportButton = document.getElementById("startVoiceReport");
const stopVoiceReportButton = document.getElementById("stopVoiceReport");
const voiceReportMessage = document.getElementById("voiceReportMessage");
let previewUrl = null;
let hasLoadedEmergencyAlerts = false;
let speechRecognition;
let voiceTranscript = "";
let voiceGeneratedTitle = false;
let speechRecognitionError = false;

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
  if (!response.ok) {
    const data = contentType.includes("application/json")
      ? await response.json()
      : {};
    const detail = data.detail;
    const message = Array.isArray(detail)
      ? detail.map(item => item.msg).join(", ")
      : detail;
    throw new Error(message || `Request failed with status ${response.status}.`);
  }
  return response;
}

function showMessage(element, message, type = "") {
  element.textContent = message;
  element.className = `${element.id === "formMessage" ? "form-message" : "reports-message"} ${type}`;
}

function createTextElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text ?? "";
  return element;
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleString();
}

function classifyVoiceReport(transcript) {
  const text = transcript.toLocaleLowerCase();
  const matches = patterns =>
    patterns.some(pattern => text.includes(pattern));

  if (matches([
    "flood", "waterlogging", "water logging", "water has risen",
    "paani bhar", "pani bhar", "baadh", "बाढ़", "पानी भर", "जलभराव",
    "ਪਾਣੀ ਭਰ", "ਪਾਣੀ ਭਰਿਆ", "ਹੜ੍ਹ"
  ])) {
    return "Flooding";
  }
  if (matches([
    "accident", "crash", "collision", "road accident", "durghatna",
    "हादसा", "दुर्घटना", "ਟੱਕਰ", "ਹਾਦਸਾ"
  ])) {
    return "Accident";
  }
  if (matches([
    "garbage", "trash", "waste", "litter", "kachra", "कचरा", "कूड़ा",
    "ਕੂੜਾ", "ਗੰਦਗੀ"
  ])) {
    return "Waste";
  }
  if (matches([
    "pothole", "damaged road", "broken road", "road damage",
    "सड़क टूटी", "सड़क खराब", "सड़क में गड्ढा", "ਖੱਡਾ", "ਟੁੱਟੀ ਸੜਕ"
  ])) {
    return "Road Damage";
  }
  return "";
}

function applyVoiceReport(transcript) {
  const normalizedTranscript = transcript.trim();
  if (!normalizedTranscript) return;

  reportForm.elements.description.value = normalizedTranscript;
  const category = classifyVoiceReport(normalizedTranscript);
  if (category) {
    reportForm.elements.category.value = category;
    if (!reportForm.elements.title.value.trim() || voiceGeneratedTitle) {
      reportForm.elements.title.value = `${category} report`;
      voiceGeneratedTitle = true;
    }

    const urgent = /immediate danger|life[- ]threatening|urgent|emergency|जान का खतरा|तुरंत खतरा|गंभीर खतरा|ਜਾਨ ਦਾ ਖ਼ਤਰਾ|ਤੁਰੰਤ ਖ਼ਤਰਾ|ਐਮਰਜੈਂਸੀ/i
      .test(normalizedTranscript);
    if (urgent) {
      reportForm.elements.priority.value = "critical";
    }

    voiceReportMessage.textContent =
      `${category} detected. Review the suggested title, priority, and transcript; enter the location before submitting.`;
    voiceReportMessage.className = "voice-message success";
  } else {
    voiceReportMessage.textContent =
      "Transcript added. We could not identify an incident type, so please choose the category and enter the location.";
    voiceReportMessage.className = "voice-message";
  }
}

function createSpeechRecognition() {
  const Recognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) return null;

  const recognition = new Recognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  recognition.lang = voiceLanguage.value;

  recognition.onstart = () => {
    voiceTranscript = "";
    speechRecognitionError = false;
    startVoiceReportButton.disabled = true;
    stopVoiceReportButton.disabled = false;
    voiceLanguage.disabled = true;
    document.getElementById("submitReport").disabled = true;
    voiceReportMessage.textContent = "Listening… Speak clearly, then select Stop.";
    voiceReportMessage.className = "voice-message";
  };

  recognition.onresult = event => {
    let interimTranscript = "";
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const text = result[0].transcript.trim();
      if (result.isFinal && text) {
        voiceTranscript = `${voiceTranscript} ${text}`.trim();
      } else {
        interimTranscript = `${interimTranscript} ${text}`.trim();
      }
    }

    const visibleTranscript = `${voiceTranscript} ${interimTranscript}`.trim();
    if (visibleTranscript) {
      applyVoiceReport(visibleTranscript);
      if (interimTranscript) {
        voiceReportMessage.textContent =
          `Listening… ${classifyVoiceReport(visibleTranscript) || "transcribing"}; review the transcript before submitting.`;
        voiceReportMessage.className = "voice-message";
      }
    }
  };

  recognition.onerror = event => {
    speechRecognitionError = true;
    const messages = {
      "not-allowed": "Microphone access was blocked. Allow microphone access in your browser and try again.",
      "no-speech": "No speech was detected. Try again in a quieter place.",
      "audio-capture": "No microphone was found. Connect a microphone and try again.",
      network: "Speech recognition needs a network connection. Check your connection and try again."
    };
    voiceReportMessage.textContent =
      messages[event.error] || `Speech recognition failed (${event.error}). Please try again.`;
    voiceReportMessage.className = "voice-message error";
  };

  recognition.onend = () => {
    startVoiceReportButton.disabled = false;
    stopVoiceReportButton.disabled = true;
    voiceLanguage.disabled = false;
    document.getElementById("submitReport").disabled = false;
    if (voiceTranscript) {
      applyVoiceReport(voiceTranscript);
      if (!speechRecognitionError) {
        voiceReportMessage.textContent =
          "Transcript added to the report. Check the category, urgency, and location before submitting.";
        voiceReportMessage.className = "voice-message success";
      }
    }
  };
  return recognition;
}

function clearImageUrls() {
  imageUrls.forEach(url => URL.revokeObjectURL(url));
  imageUrls.clear();
}

async function loadReportImage(incident, image) {
  try {
    const response = await apiRequest(incident.image_url);
    const url = URL.createObjectURL(await response.blob());
    imageUrls.add(url);
    image.src = url;
  } catch (error) {
    image.alt = "Report image could not be loaded.";
    image.hidden = true;
    console.error("Report image:", error.message);
  }
}

function renderUpdates(container, updates) {
  container.replaceChildren();
  if (!updates.length) {
    container.append(createTextElement("p", "field-hint", "No updates yet."));
    return;
  }

  updates.forEach(update => {
    const item = createTextElement("div", "update-item", "");
    item.append(createTextElement("strong", "", update.status));
    item.append(createTextElement("span", "", update.message));
    item.append(createTextElement("time", "", formatDate(update.created_at)));
    container.append(item);
  });
}

function renderReports(items) {
  clearImageUrls();
  reportList.replaceChildren();
  if (!items.length) {
    reportList.append(
      createTextElement(
        "p",
        "empty-state",
        "You have not sent a report yet. Use the form to report an issue."
      )
    );
    return;
  }

  items.forEach(item => {
    const card = createTextElement("article", "report-card", "");
    const top = createTextElement("div", "report-card-top", "");
    const details = createTextElement("div", "", "");
    details.append(createTextElement("h3", "", item.title));
    details.append(
      createTextElement(
        "div",
        "report-meta",
        `${item.category} · ${item.location} · ${formatDate(item.created_at)}`
      )
    );
    top.append(details);
    const statusClass = String(item.status || "")
      .toLowerCase()
      .replaceAll(" ", "-");
    top.append(
      createTextElement("span", `status-badge ${statusClass}`, item.status)
    );
    card.append(top);
    card.append(
      createTextElement("p", "report-description", item.description)
    );

    if (item.image_url) {
      const image = document.createElement("img");
      image.className = "report-image";
      image.alt = `Photo attached to ${item.title}`;
      image.loading = "lazy";
      card.append(image);
      loadReportImage(item, image);
    }

    const actions = createTextElement("div", "report-actions", "");
    const toggle = createTextElement("button", "updates-toggle", "View updates");
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", "false");
    const updatesContainer = createTextElement("div", "updates-list", "");
    updatesContainer.hidden = true;
    toggle.addEventListener("click", async () => {
      if (!updatesContainer.hidden) {
        updatesContainer.hidden = true;
        toggle.setAttribute("aria-expanded", "false");
        toggle.textContent = "View updates";
        return;
      }

      toggle.disabled = true;
      try {
        const response = await apiRequest(
          `/api/citizen/incidents/${item.id}/updates`
        );
        renderUpdates(updatesContainer, await response.json());
        updatesContainer.hidden = false;
        toggle.setAttribute("aria-expanded", "true");
        toggle.textContent = "Hide updates";
      } catch (error) {
        showMessage(reportsMessage, error.message, "error");
      } finally {
        toggle.disabled = false;
      }
    });
    actions.append(toggle, updatesContainer);
    card.append(actions);
    reportList.append(card);
  });
}

function renderEmergencyAlerts(alerts) {
  emergencyAlertList.replaceChildren();
  if (!alerts.length) {
    emergencyAlertList.append(
      createTextElement(
        "p",
        "empty-state",
        "There are no active emergency alerts."
      )
    );
    return;
  }

  alerts.forEach(alert => {
    const card = createTextElement("article", "emergency-alert-card", "");
    card.append(createTextElement("h3", "", alert.title));
    card.append(
      createTextElement(
        "div",
        "emergency-alert-meta",
        `${alert.category} · Affected area: ${alert.affected_location} · ${formatDate(alert.created_at)}`
      )
    );
    card.append(createTextElement("p", "", alert.instructions));
    emergencyAlertList.append(card);
  });
}

async function loadEmergencyAlerts(checkForNew = false) {
  try {
    const response = await apiRequest("/api/citizen/alerts");
    const alerts = await response.json();

    if (checkForNew && hasLoadedEmergencyAlerts) {
      const newAlert = alerts.find(alert => !knownEmergencyAlerts.has(alert.id));
      if (newAlert) {
        notificationBanner.textContent =
          `Emergency alert: ${newAlert.title}. Affected area: ${newAlert.affected_location}.`;
        notificationBanner.hidden = false;
      }
    }

    knownEmergencyAlerts.clear();
    alerts.forEach(alert => knownEmergencyAlerts.add(alert.id));
    renderEmergencyAlerts(alerts);
    emergencyAlertsMessage.textContent = alerts.length
      ? `${alerts.length} active alert${alerts.length === 1 ? "" : "s"} for all residents.`
      : "No active emergency alerts.";
    emergencyAlertsMessage.className = "reports-message";
    hasLoadedEmergencyAlerts = true;
  } catch (error) {
    emergencyAlertsMessage.textContent = error.message;
    emergencyAlertsMessage.className = "reports-message error";
    emergencyAlertList.replaceChildren();
  }
}

function formatFacilityDistance(meters) {
  return meters < 1000 ? `${meters} m away` : `${(meters / 1000).toFixed(1)} km away`;
}

function createFacilityCard(facility, recommended = false) {
  const card = createTextElement(
    "article",
    `facility-card${recommended ? " recommended" : ""}`,
    ""
  );
  const titleRow = createTextElement("div", "facility-card-heading", "");
  const title = createTextElement("h4", "", facility.name);
  const distance = createTextElement(
    "span",
    "facility-distance",
    formatFacilityDistance(facility.distance_meters)
  );
  titleRow.append(title, distance);
  card.append(titleRow);
  card.append(
    createTextElement(
      "p",
      "facility-type",
      facility.category === "shelter" ? "Designated emergency shelter" : "Hospital"
    )
  );
  if (facility.address) {
    card.append(createTextElement("p", "facility-address", facility.address));
  }

  const destination = `${facility.latitude},${facility.longitude}`;
  const directions = document.createElement("a");
  directions.className = "facility-directions";
  directions.href = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`;
  directions.target = "_blank";
  directions.rel = "noopener noreferrer";
  directions.textContent = "Get directions";
  card.append(directions);
  return card;
}

function renderNearbyFacilities(facilities, radiusMeters) {
  facilityRecommendation.replaceChildren();
  facilityResults.replaceChildren();

  const shelters = facilities.filter(item => item.category === "shelter");
  const hospitals = facilities.filter(item => item.category === "hospital");
  const nearestShelter = shelters[0];
  if (nearestShelter) {
    facilityRecommendation.hidden = false;
    facilityRecommendation.append(
      createTextElement("p", "facility-recommendation-label", "NEAREST MAPPED DESIGNATED SHELTER"),
      createTextElement(
        "p",
        "facility-recommendation-copy",
        `${nearestShelter.name} is the closest mapped designated shelter (${formatFacilityDistance(nearestShelter.distance_meters)}). Confirm it is open and follow local emergency instructions.`
      ),
      createFacilityCard(nearestShelter, true)
    );
  } else {
    facilityRecommendation.hidden = true;
  }

  const addGroup = (heading, items, omitFacility = null) => {
    const visibleItems = items.filter(item => item !== omitFacility);
    if (!visibleItems.length) return;
    const group = createTextElement("section", "facility-group", "");
    group.append(createTextElement("h3", "", heading));
    const list = createTextElement("div", "facility-card-list", "");
    visibleItems.forEach(item => list.append(createFacilityCard(item)));
    group.append(list);
    facilityResults.append(group);
  };

  addGroup("Designated emergency shelters", shelters, nearestShelter);
  addGroup("Nearby hospitals", hospitals);

  const radiusKm = (radiusMeters / 1000).toFixed(0);
  if (!facilities.length) {
    facilitySearchMessage.textContent =
      `No mapped hospitals or designated emergency shelters were found within ${radiusKm} km. Check official local emergency resources.`;
    facilitySearchMessage.className = "facility-search-message";
  } else {
    facilitySearchMessage.textContent =
      `Found ${hospitals.length} hospital${hospitals.length === 1 ? "" : "s"} and ${shelters.length} designated shelter${shelters.length === 1 ? "" : "s"} within ${radiusKm} km.`;
    facilitySearchMessage.className = "facility-search-message success";
  }
}

facilitySearchButton.addEventListener("click", () => {
  if (!navigator.geolocation) {
    facilitySearchMessage.textContent =
      "This browser does not support location access. Check official local emergency resources instead.";
    facilitySearchMessage.className = "facility-search-message error";
    return;
  }

  facilitySearchButton.disabled = true;
  facilitySearchButton.textContent = "Getting your location…";
  facilitySearchMessage.textContent = "Waiting for your location permission…";
  facilitySearchMessage.className = "facility-search-message";

  navigator.geolocation.getCurrentPosition(
    async position => {
      facilitySearchButton.textContent = "Searching nearby…";
      facilitySearchMessage.textContent = "Looking for nearby mapped facilities…";
      try {
        const parameters = new URLSearchParams({
          latitude: String(position.coords.latitude),
          longitude: String(position.coords.longitude),
        });
        const response = await apiRequest(`/api/citizen/facilities?${parameters}`);
        const data = await response.json();
        if (!Array.isArray(data.facilities) || !Number.isFinite(data.radius_meters)) {
          throw new Error("The facility service returned an invalid response.");
        }
        renderNearbyFacilities(data.facilities, data.radius_meters);
      } catch (error) {
        facilitySearchMessage.textContent = error.message;
        facilitySearchMessage.className = "facility-search-message error";
        facilityRecommendation.replaceChildren();
        facilityRecommendation.hidden = true;
        facilityResults.replaceChildren();
      } finally {
        facilitySearchButton.disabled = false;
        facilitySearchButton.textContent = "Find facilities near me";
      }
    },
    error => {
      facilitySearchMessage.textContent =
        error.code === error.PERMISSION_DENIED
          ? "Location permission was denied. Allow location access or check official local emergency resources."
          : "Could not get your location. Check your device settings and try again.";
      facilitySearchMessage.className = "facility-search-message error";
      facilitySearchButton.disabled = false;
      facilitySearchButton.textContent = "Find facilities near me";
    },
    { enableHighAccuracy: false, timeout: 15000, maximumAge: 60000 }
  );
});

async function loadReports(checkForUpdates = false) {
  try {
    const response = await apiRequest("/api/citizen/incidents");
    const items = await response.json();

    if (checkForUpdates) {
      const changed = items.find(item =>
        knownUpdates.has(item.id) &&
        knownUpdates.get(item.id) !== item.latest_update_id
      );
      if (changed) {
        const updateMessage = changed.latest_update_message
          ? ` ${changed.latest_update_message}`
          : "";
        notificationBanner.textContent =
          `Update on "${changed.title}": ${changed.status}.${updateMessage}`;
        notificationBanner.hidden = false;
      }
    }

    items.forEach(item => knownUpdates.set(item.id, item.latest_update_id));
    renderReports(items);
    showMessage(reportsMessage, "");
  } catch (error) {
    showMessage(reportsMessage, error.message, "error");
  }
}

document.getElementById("welcomeName").textContent = "Citizen Portal";
reportForm.elements.title.addEventListener("input", () => {
  voiceGeneratedTitle = false;
});

startVoiceReportButton.addEventListener("click", () => {
  if (!speechRecognition) {
    speechRecognition = createSpeechRecognition();
  }
  if (!speechRecognition) {
    voiceReportMessage.textContent =
      "Voice reporting is not supported in this browser. Use a recent Chrome or Edge browser, or type your report.";
    voiceReportMessage.className = "voice-message error";
    return;
  }

  speechRecognition.lang = voiceLanguage.value;
  try {
    speechRecognition.start();
  } catch (error) {
    voiceReportMessage.textContent =
      "Voice recognition could not start. Stop any active recording and try again.";
    voiceReportMessage.className = "voice-message error";
    console.error("Speech recognition:", error.message);
  }
});

stopVoiceReportButton.addEventListener("click", () => {
  if (speechRecognition) speechRecognition.stop();
});

document.getElementById("logoutButton").addEventListener("click", () => {
  localStorage.removeItem("cityshield_token");
  localStorage.removeItem("cityshield_user");
  window.location.assign("index.html");
});

document.getElementById("locationButton").addEventListener("click", () => {
  const locationMessage = document.getElementById("locationMessage");
  if (!navigator.geolocation) {
    locationMessage.textContent = "This browser does not support location access.";
    return;
  }
  locationMessage.textContent = "Getting your coordinates…";
  navigator.geolocation.getCurrentPosition(
    position => {
      const latitude = position.coords.latitude.toFixed(5);
      const longitude = position.coords.longitude.toFixed(5);
      reportForm.elements.latitude.value = position.coords.latitude;
      reportForm.elements.longitude.value = position.coords.longitude;
      reportForm.elements.location.value = `${latitude}, ${longitude}`;
      locationMessage.textContent =
        `Coordinates added (${latitude}, ${longitude}).`;
    },
    error => {
      locationMessage.textContent =
        error.code === error.PERMISSION_DENIED
          ? "Location permission was denied. You can enter an address instead."
          : "Could not get your location. You can enter an address instead.";
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

imageInput.addEventListener("change", () => {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  imagePreview.hidden = true;

  const file = imageInput.files[0];
  if (!file) return;
  const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
  if (!allowedTypes.includes(file.type) || file.size > 5 * 1024 * 1024) {
    imageInput.value = "";
    showMessage(
      formMessage,
      "Choose a JPG, PNG, or WebP image up to 5 MB.",
      "error"
    );
    return;
  }
  previewUrl = URL.createObjectURL(file);
  imagePreview.src = previewUrl;
  imagePreview.hidden = false;
  showMessage(formMessage, "");
});

reportForm.addEventListener("submit", async event => {
  event.preventDefault();
  showMessage(formMessage, "");
  const button = document.getElementById("submitReport");
  button.disabled = true;
  button.textContent = "Sending report…";

  try {
    const response = await apiRequest("/api/citizen/incidents", {
      method: "POST",
      body: new FormData(reportForm),
    });
    const incident = await response.json();
    knownUpdates.set(incident.id, incident.latest_update_id);
    reportForm.reset();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    imagePreview.removeAttribute("src");
    imagePreview.hidden = true;
    voiceGeneratedTitle = false;
    document.getElementById("locationMessage").textContent =
      "You can enter an address without sharing device location.";
    showMessage(formMessage, "Your report was sent successfully.", "success");
    await loadReports();
  } catch (error) {
    showMessage(formMessage, error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Send report";
  }
});

const refreshReportsButton = document.getElementById("refreshReports");
refreshReportsButton.addEventListener("click", async () => {
  refreshReportsButton.disabled = true;
  refreshReportsButton.textContent = "↻ Refreshing...";
  try {
    await loadReports(true);
  } finally {
    refreshReportsButton.disabled = false;
    refreshReportsButton.textContent = "↻ Refresh";
  }
});

async function initializeCitizenDashboard() {
  if (!token) {
    window.location.assign("index.html");
    return;
  }

  try {
    const response = await apiRequest("/api/auth/me");
    const user = await response.json();
    if (String(user.role).toLowerCase() !== "citizen") {
      localStorage.removeItem("cityshield_token");
      localStorage.removeItem("cityshield_user");
      window.location.assign("index.html");
      return;
    }
    document.getElementById("welcomeName").textContent =
      `Welcome, ${user.full_name}`;
    await loadReports();
    await loadEmergencyAlerts();
    window.setInterval(() => {
      loadReports(true);
      loadEmergencyAlerts(true);
    }, 30000);
  } catch (error) {
    showMessage(reportsMessage, error.message, "error");
  }
}

initializeCitizenDashboard();
