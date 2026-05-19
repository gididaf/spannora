const form = document.getElementById("login-form");
const errorEl = document.getElementById("error");
const submitBtn = document.getElementById("submit");

// If no users exist yet, send the visitor to /setup.
fetch("/api/auth/status")
  .then((r) => r.json())
  .then((data) => {
    if (data && data.setup_needed === true) location.replace("/setup");
  })
  .catch(() => {});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorEl.classList.add("hidden");
  submitBtn.disabled = true;

  const data = new FormData(form);
  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: data.get("username"),
        password: data.get("password"),
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    location.replace("/");
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove("hidden");
    submitBtn.disabled = false;
  }
});
