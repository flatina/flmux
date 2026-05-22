// Generic helpers shared across all fixture pages.
// Each page tags itself via <body data-page="..."> so handlers self-scope.

const page = document.body.dataset.page;
const $ = (sel) => document.querySelector(sel);

function setOut(sel, value) {
  const el = $(sel);
  if (el) el.textContent = String(value);
}

if (page === "interactions") {
  let count = 0;
  $("#click-me")?.addEventListener("click", () => setOut("#click-out", ++count));

  $("#dbl-target")?.addEventListener("dblclick", () => setOut("#dbl-out", "double!"));

  $("#hover-target")?.addEventListener("mouseenter", () => setOut("#hover-out", "hovered"));
  $("#hover-target")?.addEventListener("mouseleave", () => setOut("#hover-out", "left"));

  $("#focus-input")?.addEventListener("focus", () => setOut("#focus-out", "focused"));
  $("#focus-input")?.addEventListener("blur", () => setOut("#focus-out", "blurred"));

  $("#type-target")?.addEventListener("input", (e) => setOut("#type-out", e.target.value));

  $("#press-target")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") setOut("#press-out", "enter pressed");
  });

  $("#reveal-async")?.addEventListener("click", () => {
    setOut("#async-out", "loading...");
    setTimeout(() => {
      $("#async-result")?.classList.remove("hidden");
      setOut("#async-result", "revealed");
    }, 800);
  });
}

if (page === "forms") {
  function snapshot() {
    const data = {
      name: $("#fill-name").value,
      email: $("#fill-email").value,
      note: $("#fill-note").value,
      subscribe: $("#check-subscribe").checked,
      role: document.querySelector('input[name="role"]:checked')?.value || null,
      color: $("#color-select").value
    };
    setOut("#form-out", JSON.stringify(data));
  }
  $("#submit-form")?.addEventListener("click", snapshot);
  ["fill-name", "fill-email", "fill-note", "check-subscribe", "color-select"].forEach((id) => {
    $("#" + id)?.addEventListener("change", snapshot);
    $("#" + id)?.addEventListener("input", snapshot);
  });
  document.querySelectorAll('input[name="role"]').forEach((el) => el.addEventListener("change", snapshot));
  snapshot();
}

if (page === "dialogs") {
  $("#open-alert")?.addEventListener("click", () => {
    alert("alert from fixture");
    setOut("#dialog-out", "alert closed");
  });
  $("#open-confirm")?.addEventListener("click", () => {
    const r = confirm("confirm me?");
    setOut("#dialog-out", "confirm:" + r);
  });
  $("#open-prompt")?.addEventListener("click", () => {
    const r = prompt("enter value", "default");
    setOut("#dialog-out", "prompt:" + r);
  });
}

if (page === "console") {
  $("#emit-log")?.addEventListener("click", () => console.log("hello from log", { tag: "fixture" }));
  $("#emit-warn")?.addEventListener("click", () => console.warn("warn message"));
  $("#emit-error")?.addEventListener("click", () => console.error("error message"));
  $("#throw-uncaught")?.addEventListener("click", () => {
    setTimeout(() => { throw new Error("uncaught test error"); }, 0);
  });
}
