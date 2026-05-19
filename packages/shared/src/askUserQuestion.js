// AskUserQuestion form builder. The form is a tool-card body that the model
// emits via the AskUserQuestion tool_use block — radios/checkboxes per
// question plus an always-rendered "Other" free-text fallback (the SDK
// schema mandates it: "There should be no 'Other' option, that will be
// provided automatically.").
//
// Submission is delegated to the host via askContext.submitAnswer so the
// in-server PWA can POST same-origin via apiFetch while the standalone hub
// can POST cross-origin with its bearer client. Lifecycle hooks
// (onOpen / onClosed) let the host lock its prompt textarea while a
// question is pending.
//
// askContext shape:
//   {
//     submitAnswer: (toolUseId, answers) => Promise<void>,
//     onOpen?:   (toolUseId) => void,
//     onClosed?: (toolUseId) => void,
//   }

export function makeAskQuestionForm(toolUseId, input, askContext) {
  const form = document.createElement("div");
  form.className = "aq-form";

  askContext?.onOpen?.(toolUseId);

  const questions = Array.isArray(input.questions) ? input.questions : [];
  // Per-question selection state. For single-select we track an index;
  // for multi-select we track a Set of indices. Free-text "Other" is
  // tracked separately and always allowed (the SDK doesn't include an
  // "Other" option in `options` — it expects the host to add one).
  const qState = questions.map((q) => ({
    selectedIdx: null,         // single-select: index of picked option
    selectedIdxs: new Set(),   // multi-select: indices of picked options
    otherSelected: false,      // is the "Other" radio/checkbox checked?
    otherText: "",
    multi: !!q.multiSelect,
  }));

  questions.forEach((q, qi) => {
    const qWrap = document.createElement("div");
    qWrap.className = "aq-question";

    const headerRow = document.createElement("div");
    headerRow.className = "aq-question-header";
    const chip = document.createElement("span");
    chip.className = "aq-chip";
    chip.textContent = q.header || `Q${qi + 1}`;
    if (q.multiSelect) {
      const multi = document.createElement("span");
      multi.className = "aq-multi-hint";
      multi.textContent = "multi-select";
      headerRow.append(chip, multi);
    } else {
      headerRow.appendChild(chip);
    }
    qWrap.appendChild(headerRow);

    const titleEl = document.createElement("div");
    titleEl.className = "aq-title";
    titleEl.textContent = q.question || "";
    qWrap.appendChild(titleEl);

    const groupName = `aq-${toolUseId}-${qi}`;
    let otherCheck;  // declared early so option handlers can clear it

    const opts = Array.isArray(q.options) ? q.options : [];
    opts.forEach((opt, oi) => {
      const row = document.createElement("label");
      row.className = "aq-option";
      const inp = document.createElement("input");
      inp.type = q.multiSelect ? "checkbox" : "radio";
      inp.name = groupName;
      inp.value = String(oi);
      inp.addEventListener("change", () => {
        if (q.multiSelect) {
          if (inp.checked) qState[qi].selectedIdxs.add(oi);
          else qState[qi].selectedIdxs.delete(oi);
        } else {
          qState[qi].selectedIdx = oi;
          // Browser already unchecked the Other radio in the same group;
          // mirror that in state.
          qState[qi].otherSelected = false;
        }
      });
      const txt = document.createElement("span");
      txt.className = "aq-option-text";
      const label = document.createElement("span");
      label.className = "aq-option-label";
      label.textContent = opt.label || "";
      txt.appendChild(label);
      if (opt.description) {
        const desc = document.createElement("span");
        desc.className = "aq-option-desc";
        desc.textContent = opt.description;
        txt.appendChild(desc);
      }
      row.append(inp, txt);
      qWrap.appendChild(row);
    });

    // "Other" — rendered as one more option row. Per the SDK schema:
    // "There should be no 'Other' option, that will be provided automatically."
    // Not wrapped in <label> because the text input lives inside it and we
    // don't want clicks/keystrokes there to toggle the radio.
    const otherRow = document.createElement("div");
    otherRow.className = "aq-option aq-option-other";
    otherCheck = document.createElement("input");
    otherCheck.type = q.multiSelect ? "checkbox" : "radio";
    otherCheck.name = groupName;
    otherCheck.value = "__other__";
    otherCheck.addEventListener("change", () => {
      qState[qi].otherSelected = otherCheck.checked;
      if (!q.multiSelect && otherCheck.checked) {
        // Browser already unchecked the option radio; mirror that in state.
        qState[qi].selectedIdx = null;
      }
    });
    const otherInput = document.createElement("input");
    otherInput.type = "text";
    otherInput.className = "aq-other-input";
    otherInput.placeholder = q.multiSelect ? "Other (will be added)" : "Other answer";
    otherInput.addEventListener("input", () => {
      qState[qi].otherText = otherInput.value;
      // Auto-select Other when the user starts typing. For single-select,
      // assigning .checked = true also unchecks the previously-picked
      // option radio (browser maintains the radio-group invariant).
      if (otherInput.value && !otherCheck.checked) {
        otherCheck.checked = true;
        qState[qi].otherSelected = true;
        if (!q.multiSelect) qState[qi].selectedIdx = null;
      }
    });
    otherRow.append(otherCheck, otherInput);
    qWrap.appendChild(otherRow);

    form.appendChild(qWrap);
  });

  const footer = document.createElement("div");
  footer.className = "aq-footer";
  const submit = document.createElement("button");
  submit.type = "button";
  submit.className = "aq-submit";
  submit.textContent = "Submit";
  const msg = document.createElement("span");
  msg.className = "aq-msg";
  footer.append(submit, msg);
  form.appendChild(footer);

  submit.addEventListener("click", async () => {
    const answers = {};
    for (let qi = 0; qi < questions.length; qi++) {
      const q = questions[qi];
      const s = qState[qi];
      const opts = Array.isArray(q.options) ? q.options : [];
      const other = s.otherText.trim();
      const label = `"${q.header || `Q${qi + 1}`}"`;
      if (q.multiSelect) {
        const picked = [...s.selectedIdxs].map((i) => opts[i]?.label).filter(Boolean);
        if (s.otherSelected) {
          if (!other) {
            msg.textContent = `Please type your Other answer for ${label}.`;
            return;
          }
          picked.push(other);
        }
        if (picked.length === 0) {
          msg.textContent = `Please answer ${label}.`;
          return;
        }
        answers[q.question] = picked.join(", ");
      } else {
        if (s.otherSelected) {
          if (!other) {
            msg.textContent = `Please type your Other answer for ${label}.`;
            return;
          }
          answers[q.question] = other;
        } else if (s.selectedIdx != null) {
          answers[q.question] = opts[s.selectedIdx]?.label || "";
        } else {
          msg.textContent = `Please answer ${label}.`;
          return;
        }
      }
    }

    submit.disabled = true;
    submit.textContent = "Submitting…";
    msg.textContent = "";
    try {
      await askContext.submitAnswer(toolUseId, answers);
      // Lock the form. The inbound tool_result will replace this body with
      // the rendered-answer summary, but if that's slow the user shouldn't
      // be able to re-submit in the meantime.
      form.querySelectorAll("input").forEach((el) => { el.disabled = true; });
      submit.textContent = "Submitted";
      // The setToolResult path also fires onClosed when the tool_result
      // arrives, but unlocking the prompt as soon as we know the resolver
      // fired feels snappier.
      askContext?.onClosed?.(toolUseId);
    } catch (err) {
      if (err?.message === "unauthorized") return;
      msg.textContent = `Failed: ${err?.message ?? String(err)}`;
      submit.disabled = false;
      submit.textContent = "Submit";
      // The question is effectively dead (404 / network) — let the user
      // type again instead of leaving the prompt locked forever.
      askContext?.onClosed?.(toolUseId);
    }
  });

  return form;
}
