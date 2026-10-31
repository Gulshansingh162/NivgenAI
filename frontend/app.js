
const menu = document.querySelector("#menu");
const nav = document.querySelector("#nav");
const dialog = document.querySelector("#dialog");
const title = document.querySelector("#dialogTitle");
const description = document.querySelector("#dialogDescription");
const closeDialogButton = document.querySelector("#closeDialog");
const authTabs = document.querySelector("#authTabs");
const showRegisterButton = document.querySelector("#showRegister");
const showLoginButton = document.querySelector("#showLogin");
const authForm = document.querySelector("#authForm");
const authFields = document.querySelector("#authFields");
const authMessage = document.querySelector("#authMessage");
const authSubmit = document.querySelector("#authSubmit");
const authFootnote = document.querySelector("#authFootnote");

// When using VS Code Live Server, call Flask on port 5000.
// When Flask serves the frontend, use the same origin.
const API_BASE =
  window.location.port === "5500"
    ? "http://127.0.0.1:5000"
    : window.location.origin;

let currentRole = "admin";
let currentMode = "login";

// Display the current year.
document.querySelector("#year").textContent = new Date().getFullYear();

// Mobile navigation.
menu.addEventListener("click", () => {
  const isOpen = nav.classList.toggle("open");
  menu.setAttribute("aria-expanded", String(isOpen));
});

nav.querySelectorAll("a").forEach((link) => {
  link.addEventListener("click", () => {
    nav.classList.remove("open");
    menu.setAttribute("aria-expanded", "false");

    nav.querySelectorAll("a").forEach((item) => {
      item.classList.remove("active");
    });

    link.classList.add("active");
  });
});

// Escape text before inserting dynamic messages into the page.
function showMessage(message, type = "error") {
  authMessage.textContent = message;
  authMessage.className = `auth-message ${type}`;
}

function clearMessage() {
  authMessage.textContent = "";
  authMessage.className = "auth-message";
}

function fieldMarkup({
  id,
  label,
  type = "text",
  placeholder,
  autocomplete,
  minlength,
  required = true,
}) {
  return `
    <div class="auth-field">
      <label for="${id}">${label}</label>
      <input
        id="${id}"
        name="${id}"
        type="${type}"
        placeholder="${placeholder}"
        autocomplete="${autocomplete}"
        ${minlength ? `minlength="${minlength}"` : ""}
        ${required ? "required" : ""}
      >
    </div>
  `;
}

// Render the login form for the selected role.
function renderAuthForm() {
  clearMessage();
  authFields.innerHTML = "";

  const isRegister = currentRole === "citizen" && currentMode === "register";
  authTabs.hidden = currentRole !== "citizen";
  showRegisterButton.classList.toggle("active", isRegister);
  showLoginButton.classList.toggle("active", !isRegister);

  const roleNames = {
    admin: "Admin",
    citizen: "Citizen",
    worker: "Worker",
  };

  if (isRegister) {
    title.textContent = "Create Citizen Account";
    description.textContent =
      "Register to report local incidents and follow their response.";
    authFields.innerHTML =
      fieldMarkup({
        id: "full_name",
        label: "Full name",
        placeholder: "Enter your full name",
        autocomplete: "name",
        minlength: 2,
      }) +
      fieldMarkup({
        id: "email",
        label: "Email address",
        type: "email",
        placeholder: "you@example.com",
        autocomplete: "email",
      }) +
      fieldMarkup({
        id: "password",
        label: "Password (minimum 12 characters)",
        type: "password",
        placeholder: "Create a strong password",
        autocomplete: "new-password",
        minlength: 12,
      }) +
      fieldMarkup({
        id: "confirm_password",
        label: "Confirm password",
        type: "password",
        placeholder: "Enter your password again",
        autocomplete: "new-password",
        minlength: 12,
      });
    authSubmit.textContent = "Create Account";
    authFootnote.textContent = "Already registered? Select Login above.";
    return;
  }

  title.textContent = `${roleNames[currentRole]} Login`;

  if (currentRole === "admin") {
    description.textContent =
      "Sign in using your authorized administrator account.";
  } else if (currentRole === "worker") {
    description.textContent =
      "Sign in using the worker credentials provided by your administrator.";
  } else {
    description.textContent =
      "Sign in to your CityShield citizen account.";
  }

  authFields.innerHTML =
    fieldMarkup({
      id: "email",
      label: "Email address",
      type: "email",
      placeholder: "you@example.com",
      autocomplete: "email",
    }) +
    fieldMarkup({
      id: "password",
      label: "Password",
      type: "password",
      placeholder: "Enter your password",
      autocomplete: "current-password",
    });

  authSubmit.textContent = "Login";
  const footnotes = {
    admin: "Admin accounts are provisioned by the system administrator.",
    citizen: "New to CityShield? Select Register to create an account.",
    worker: "Worker accounts are created by the administrator.",
  };
  authFootnote.textContent = footnotes[currentRole];
}

function openAuth(role) {
  currentRole = role.toLowerCase();
  currentMode = "login";
  renderAuthForm();

  if (!dialog.open) {
    dialog.showModal();
  }
}

// Open the appropriate login page.
document.querySelectorAll("[data-role]").forEach((button) => {
  button.addEventListener("click", () => {
    openAuth(button.dataset.role);
  });
});

showRegisterButton.addEventListener("click", () => {
  currentMode = "register";
  renderAuthForm();
});

showLoginButton.addEventListener("click", () => {
  currentMode = "login";
  renderAuthForm();
});

// Close the dialog.
closeDialogButton.addEventListener("click", () => {
  dialog.close();
});

dialog.addEventListener("click", (event) => {
  if (event.target === dialog) {
    dialog.close();
  }
});

// Convert backend errors into readable messages.
async function readResponse(response) {
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const detail = data.detail;
    const message = Array.isArray(detail)
      ? detail.map((item) => item.msg).join(", ")
      : detail;

    throw new Error(
      message || `Request failed with status ${response.status}.`
    );
  }

  return data;
}

// Submit login or citizen registration to the API.
authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearMessage();

  const email = authForm.elements.email.value.trim().toLowerCase();
  const password = authForm.elements.password.value;

  authSubmit.disabled = true;
  authSubmit.textContent = currentMode === "register"
    ? "Creating account..."
    : "Signing in...";

  try {
    if (currentRole === "citizen" && currentMode === "register") {
      const fullName = authForm.elements.full_name.value.trim();
      const confirmPassword = authForm.elements.confirm_password.value;
      if (password !== confirmPassword) {
        throw new Error("The passwords do not match.");
      }

      await readResponse(
        await fetch(`${API_BASE}/api/auth/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ full_name: fullName, email, password }),
        })
      );

      currentMode = "login";
      renderAuthForm();
      showMessage("Account created. You can now sign in.", "success");
      authForm.elements.email.value = email;
      return;
    }

    const data = await readResponse(
      await fetch(`${API_BASE}/api/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email, password }),
      })
    );

    // Never let a user enter a portal for a different role.
    const authenticatedRole = String(data.user?.role || "").toLowerCase();
    if (!data.user || authenticatedRole !== currentRole) {
      throw new Error(
        `This account is not authorized for the ${currentRole} portal.`
      );
    }

    // Clear any old token before storing the new authenticated session.
    localStorage.removeItem("cityshield_token");
    localStorage.setItem("cityshield_token", data.access_token);
    localStorage.setItem(
      "cityshield_user",
      JSON.stringify({
        id: data.user.id,
        full_name: data.user.full_name,
        email: data.user.email,
        role: data.user.role,
      })
    );
    if (authenticatedRole === "admin") {
      window.location.assign(
        new URL("admin-dashboard.html", window.location.href).href
      );
      return;
    }
    if (authenticatedRole === "citizen") {
      window.location.assign(
        new URL("citizen-dashboard.html", window.location.href).href
      );
      return;
    }
    window.location.assign(
      new URL("worker-dashboard.html", window.location.href).href
    );
    return;
  } catch (error) {
    showMessage(
      error instanceof TypeError
        ? "Cannot reach the backend. Start Flask and check the API URL."
        : error.message,
      "error"
    );
  } finally {
    authSubmit.disabled = false;

    if (authSubmit.textContent === "Signing in...") {
      authSubmit.textContent = "Login";
    } else if (authSubmit.textContent === "Creating account...") {
      authSubmit.textContent = "Create Account";
    }
  }
});
