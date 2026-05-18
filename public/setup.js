const form = document.getElementById("setup-form");
const errorEl = document.getElementById("error");
const submitBtn = document.getElementById("submit");

// If setup is already done, go to login.
fetch("/api/auth/status")
  .then((r) => r.json())
  .then((data) => {
    if (data && data.setup_needed === false) location.replace("/login");
  })
  .catch(() => {});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorEl.classList.add("hidden");
  submitBtn.disabled = true;

  const data = new FormData(form);
  try {
    const res = await fetch("/api/auth/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: data.get("token"),
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
