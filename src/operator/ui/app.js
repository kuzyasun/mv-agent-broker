(() => {
  "use strict";

  const bootstrap = window.__OPERATOR_BOOTSTRAP__;
  const token = bootstrap.token;
  let state = null;
  let revision = "";
  const catalogues = new Map();
  let projectFilter = "";
  let dirty = false;
  const advancedDirty = new Set();
  const $ = (id) => document.getElementById(id);
  const make = (tag, text) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const clickedTimers = new WeakMap();
  document.addEventListener("click", (event) => {
    const target = event.target;
    const button = target instanceof Element ? target.closest(".button") : null;
    if (!button || button.disabled) return;
    clearTimeout(clickedTimers.get(button));
    button.classList.add("is-clicked");
    clickedTimers.set(button, setTimeout(() => {
      button.classList.remove("is-clicked");
      clickedTimers.delete(button);
    }, 400));
  }, true);

  const busyButtons = new WeakMap();
  async function withButtonBusy(button, callback) {
    if (button.disabled || busyButtons.has(button)) return;
    const message = buttonMessages.get(button);
    if (message) {
      clearTimeout(message.timer);
      button.textContent = message.label;
      buttonMessages.delete(button);
    }
    const previous = {
      contents: [...button.childNodes].map((node) => node.cloneNode(true)),
      disabled: button.disabled,
      ariaBusy: button.getAttribute("aria-busy"),
      ariaLabel: button.getAttribute("aria-label"),
    };
    busyButtons.set(button, previous);
    const label = button.textContent.trim();
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.setAttribute("aria-label", `${label} in progress`);
    const spinner = make("span");
    spinner.className = "button-spinner";
    spinner.setAttribute("aria-hidden", "true");
    button.replaceChildren(spinner, document.createTextNode(`${label}…`));
    try {
      return await callback();
    } finally {
      button.replaceChildren(...previous.contents);
      button.disabled = previous.disabled;
      if (previous.ariaBusy === null) button.removeAttribute("aria-busy");
      else button.setAttribute("aria-busy", previous.ariaBusy);
      if (previous.ariaLabel === null) button.removeAttribute("aria-label");
      else button.setAttribute("aria-label", previous.ariaLabel);
      busyButtons.delete(button);
    }
  }

  const buttonMessages = new WeakMap();
  function showButtonMessage(button, message, duration = 1000) {
    const previous = buttonMessages.get(button);
    if (previous) clearTimeout(previous.timer);
    const label = previous ? previous.label : button.textContent;
    button.textContent = message;
    const timer = setTimeout(() => {
      if (buttonMessages.get(button)?.timer !== timer) return;
      button.textContent = label;
      buttonMessages.delete(button);
    }, duration);
    buttonMessages.set(button, { label, timer });
  }

  const option = (value, label, selected) => {
    const node = make("option", label);
    node.value = value;
    node.selected = selected;
    return node;
  };
  const modelSearches = new WeakMap();
  const fallbackEfforts = {
    cursor: ["", "none", "low", "normal", "medium", "high", "xhigh", "max"],
    antigravity: ["", "low", "medium", "high", "max"],
    zcode: ["", "low", "high", "max"],
  };
  const catalogueFor = (provider) => {
    const catalogue = catalogues.get(provider);
    return catalogue && Array.isArray(catalogue.options)
      ? catalogue
      : { options: [], observation: null };
  };
  const observedModel = (provider, model) => catalogueFor(provider).options.find((entry) => entry.model === model);
  const effortValuesFor = (route, model = route.model) => {
    const known = observedModel(route.provider, model);
    return [...(known ? known.efforts : fallbackEfforts[route.provider] || [""])];
  };
  const adjustEffortForModel = (route) => {
    const values = effortValuesFor(route);
    const current = route.effort ?? "";
    if (values.includes(current)) return;
    route.effort = values.includes("") ? null : (values[0] || null);
  };
  const modelOptionLabel = (model, current, observed) => {
    if (current && !observed) return `${model} (configured; not observed)`;
    return model;
  };
  const populateModelSelect = (select, route, search = "") => {
    const catalogue = catalogueFor(route.provider);
    const query = search.trim().toLocaleLowerCase();
    const options = catalogue.options.filter((entry) => !query || entry.model.toLocaleLowerCase().includes(query));
    const current = route.model || "";
    const currentObserved = options.some((entry) => entry.model === current);
    const allCurrentObserved = Boolean(current) && Boolean(observedModel(route.provider, current));
    const visible = options.slice();
    if (current && !currentObserved) {
      visible.unshift({ model: current, efforts: effortValuesFor(route), configured: !allCurrentObserved });
    }
    select.replaceChildren(...visible.map((entry) => option(
      entry.model,
      modelOptionLabel(entry.model, entry.model === current, !entry.configured),
      entry.model === current,
    )));
    if (current && visible.some((entry) => entry.model === current)) select.value = current;
  };
  const catalogueSummary = (provider) => {
    const catalogue = catalogueFor(provider);
    const observation = catalogue.observation;
    if (!observation) return "No model catalogue has been refreshed yet.";
    const rawCount = Array.isArray(observation.models) ? observation.models.length : 0;
    const refreshed = Number.isFinite(observation.observed_at)
      ? new Date(observation.observed_at).toLocaleString()
      : "unknown";
    return `Observed raw entries: ${rawCount} · selectable models: ${catalogue.options.length} · last refresh: ${refreshed} · source: ${observation.source}`;
  };
  const catalogueMessage = (provider) => {
    const catalogue = catalogueFor(provider);
    if (!catalogue.observation) return "Refresh this provider to inspect its model catalogue. Manual model IDs remain available.";
    if (!catalogue.options.length) return "The refreshed catalogue is unavailable or empty. No model will be substituted; enter a model ID manually.";
    return "";
  };
  const status = (message, kind = "") => {
    const node = $("status");
    node.textContent = message;
    node.className = `status ${kind}`;
  };
  const api = async (route, options = {}) => {
    const response = await fetch(route, {
      ...options,
      headers: {
        "x-operator-token": token,
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...(options.headers || {}),
      },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
    return body;
  };
  const uniqueId = (prefix) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  const find = (items, key, value) => (items || []).find((item) => item[key] === value);
  const selectedProject = (route) => find(state.projects, "project_id", route.project_id);
  const selectedPolicy = (route) => find(state.policy_profiles, "policy_profile_id", route.policy_profile_id);
  const currentWorkspace = (projectId) => (state.workspaces || []).find((item) => item.project_id === projectId && item.mode === "current");
  const nativeModeLabels = {
    off: "Off (one agent)",
    prefer: "Prefer subagents",
    auto: "Agent decides",
  };

  function routeSummary(route) {
    const mode = route.native_subagents && route.native_subagents.mode || "off";
    const effort = route.effort || "No override";
    return `Provider ${route.provider || "not set"} · model ${route.model || "not set"} · role ${route.role || "not set"} · mode ${nativeModeLabels[mode] || mode} · effort ${effort}`;
  }

  function markDirty() {
    dirty = true;
    $("change-label").textContent = "Unsaved changes";
  }

  function syncAdvanced() {
    const accounts = JSON.parse($("accounts-json").value);
    const pins = JSON.parse($("pins-json").value);
    const coverage = JSON.parse($("coverage-json").value);
    if (!Array.isArray(accounts) || !Array.isArray(coverage) || !pins || typeof pins !== "object" || Array.isArray(pins)) {
      throw new Error("Accounts and coverage must be arrays; binary pins must be an object.");
    }
    state.accounts = accounts;
    state.coverage_profiles = coverage;
    state.state_dir = $("state-dir").value;
    if (Object.keys(pins).length) state.native_binary_pins = pins;
    else delete state.native_binary_pins;
    advancedDirty.clear();
  }

  function action(callback) {
    try { callback(); } catch (error) { status(error.message, "error"); }
  }

  function setField(object, field, value) {
    object[field] = value;
    markDirty();
  }

  function textField(labelText, value, onChange, type = "text") {
    const label = make("label", labelText);
    const input = document.createElement("input");
    input.type = type;
    input.value = value == null ? "" : String(value);
    input.addEventListener("input", () => onChange(input.value));
    label.append(input);
    return label;
  }

  function selectField(labelText, value, values, onChange) {
    const label = make("label", labelText);
    const select = document.createElement("select");
    values.forEach((item) => select.append(option(item.value, item.label, item.value === value)));
    select.addEventListener("change", () => onChange(select.value));
    label.append(select);
    return label;
  }

  function renderRoutes() {
    const container = $("routes");
    container.replaceChildren();
    (state.routes || []).forEach((route, index) => {
      if (projectFilter && route.project_id !== projectFilter) return;
      const card = make("article");
      card.className = "route-card";
      const header = make("header");
      const title = make("h3", route.route_id || "Unnamed route");
      header.append(title);
      const actions = make("div");
      actions.className = "route-actions";
      const refresh = make("button", "Refresh model catalogue");
      refresh.className = "button secondary";
      refresh.type = "button";
      refresh.addEventListener("click", async () => {
        await withButtonBusy(refresh, async () => {
          status(`Reading pinned ${route.provider} metadata…`);
          try {
            const body = await api("/api/models/refresh", { method: "POST", body: JSON.stringify({ provider: route.provider }) });
            const observed = body.observation || { models: [], source: "unknown", observed_at: NaN, detail: null };
            catalogues.set(route.provider, { options: Array.isArray(body.options) ? body.options : [], observation: observed });
            status(`${observed.models.length} ${route.provider} entries · ${observed.source} · ${Number.isFinite(observed.observed_at) ? new Date(observed.observed_at).toLocaleString() : "unknown"}. ${observed.detail || "Catalogue only; authentication and quota are unknown."}`, observed.models.length ? "success" : "error");
            renderRoutes();
          } catch (error) {
            status(error.message, "error");
          }
        });
      });
      const duplicate = make("button", "Duplicate");
      duplicate.className = "button secondary";
      duplicate.type = "button";
      duplicate.addEventListener("click", () => {
        const copy = JSON.parse(JSON.stringify(route));
        copy.route_id = uniqueId(route.route_id || "route");
        state.routes.splice(index + 1, 0, copy);
        markDirty();
        renderRoutes();
      });
      const remove = make("button", "Delete");
      remove.className = "button danger";
      remove.type = "button";
      remove.addEventListener("click", () => {
        state.routes.splice(index, 1);
        markDirty();
        renderRoutes();
      });
      actions.append(refresh, duplicate, remove);
      header.append(actions);
      card.append(header);
      const summary = make("p", routeSummary(route));
      summary.className = "route-summary";
      card.append(summary);

      const fields = make("div");
      fields.className = "field-grid";
      fields.append(textField("Route ID / visible label", route.route_id, (value) => setField(route, "route_id", value)));
      fields.append(selectField("Project", route.project_id, (state.projects || []).map((project) => ({ value: project.project_id, label: project.display_name })), (value) => setField(route, "project_id", value)));
      const providers = [...new Set((state.accounts || []).map(account => account.provider))];
      fields.append(selectField("Provider", route.provider, providers.map((value) => ({ value, label: value })), (value) => {
        setField(route, "provider", value);
        const accounts = state.accounts.filter(account => account.provider === value);
        route.account_profile_id = accounts.length === 1 ? accounts[0].account_profile_id : "";
        renderRoutes();
      }));
      fields.append(selectField("Configured account", route.account_profile_id, (state.accounts || []).filter((account) => account.provider === route.provider).map((account) => ({ value: account.account_profile_id, label: `${account.account_profile_id} · ${account.provider}` })), (value) => setField(route, "account_profile_id", value)));
      fields.append(selectField("Role", route.role, ["worker", "reviewer", "researcher"].map((value) => ({ value, label: value })), (value) => {
        setField(route, "role", value);
        renderRoutes();
      }));
      fields.append(selectField("Explicit policy", route.policy_profile_id, (state.policy_profiles || []).map((policy) => ({ value: policy.policy_profile_id, label: `${policy.policy_profile_id} · ${policy.config && policy.config.access || "access not set"}` })), (value) => {
        setField(route, "policy_profile_id", value);
        renderRoutes();
      }));
      const policy = selectedPolicy(route);
      const accessField = textField("Selected policy access", policy && policy.config && policy.config.access || "not set", () => {});
      accessField.querySelector("input").readOnly = true;
      fields.append(accessField);

      const pickerHelp = make("p", catalogueSummary(route.provider));
      pickerHelp.className = "catalogue-summary";
      fields.append(pickerHelp);
      const pickerMessage = catalogueMessage(route.provider);
      if (pickerMessage) {
        const message = make("p", pickerMessage);
        message.className = "catalogue-message";
        fields.append(message);
      }
      if (route.provider === "antigravity") {
        const explanation = make("p", "Antigravity entries are grouped by base model; observed -low, -medium, -high, and -max suffixes become Effort choices.");
        explanation.className = "catalogue-help";
        fields.append(explanation);
      }
      const searchLabel = make("label");
      searchLabel.append(make("span", "Search models"));
      const search = document.createElement("input");
      search.type = "search";
      search.placeholder = "Filter by model ID";
      search.value = modelSearches.get(route) || "";
      searchLabel.append(search);
      fields.append(searchLabel);
      const modelLabel = make("label");
      modelLabel.append(make("span", "Model"));
      const model = document.createElement("select");
      model.setAttribute("aria-describedby", `catalogue-summary-${index}`);
      populateModelSelect(model, route, search.value);
      model.addEventListener("change", () => {
        route.model = model.value;
        adjustEffortForModel(route);
        markDirty();
        renderRoutes();
      });
      modelLabel.append(model);
      fields.append(modelLabel);
      pickerHelp.id = `catalogue-summary-${index}`;
      search.addEventListener("input", () => {
        modelSearches.set(route, search.value);
        populateModelSelect(model, route, search.value);
      });
      const manual = make("details");
      manual.className = "manual-model";
      if (!observedModel(route.provider, route.model)) manual.open = true;
      manual.append(make("summary", "Enter a model ID manually"));
      const manualLabel = make("label");
      manualLabel.append(make("span", "Manual model ID"));
      const manualInput = document.createElement("input");
      manualInput.value = route.model || "";
      manualInput.addEventListener("input", () => {
        if (route.model !== manualInput.value) {
          route.model = manualInput.value;
          markDirty();
          summary.textContent = routeSummary(route);
        }
      });
      manualInput.addEventListener("change", () => {
        adjustEffortForModel(route);
        renderRoutes();
      });
      manualLabel.append(manualInput);
      manual.append(manualLabel);
      fields.append(manual);
      const known = observedModel(route.provider, route.model);
      const effortValues = effortValuesFor(route);
      const currentEffort = route.effort ?? "";
      if (!effortValues.includes(currentEffort)) effortValues.push(currentEffort);
      fields.append(selectField("Effort (parent/model limits apply)", currentEffort, effortValues.map((value) => ({ value, label: value || "No override" })), (value) => {
        setField(route, "effort", value || null);
        renderRoutes();
      }));
      const nativeMode = route.native_subagents && route.native_subagents.mode || "off";
      fields.append(selectField("Native subagents (advisory)", nativeMode, Object.entries(nativeModeLabels).map(([value, label]) => ({ value, label })), (value) => {
        route.native_subagents = value === "auto"
          ? { mode: "auto" }
          : { mode: value, max_agents: route.native_subagents && route.native_subagents.max_agents || 1 };
        markDirty();
        renderRoutes();
      }));
      const countLabel = make("label");
      countLabel.append(make("span", "Suggested maximum children"));
      const countHelp = make("span", "Advisory only; not an exact desired count or enforced cap.");
      countHelp.className = "field-help";
      countLabel.append(countHelp);
      const countInput = document.createElement("input");
      countInput.type = "number";
      countInput.min = "1";
      countInput.step = "1";
      countInput.value = nativeMode === "auto" ? "" : String(route.native_subagents && route.native_subagents.max_agents || 1);
      countInput.disabled = nativeMode === "off" || nativeMode === "auto";
      countInput.addEventListener("input", () => {
        route.native_subagents = { mode: nativeMode === "prefer" ? "prefer" : "off", max_agents: Number(countInput.value) };
        markDirty();
      });
      countLabel.append(countInput);
      fields.append(countLabel);
      card.append(fields);
      const note = make("p", known ? "Model options come from the last catalogue refresh. Child models and counts remain advisory." : "Manual or configured model; combination is unverified until checked against the CLI catalogue. No automatic substitution.");
      note.className = "small-note";
      card.append(note);
      container.append(card);
    });
    if (!container.children.length) container.append(make("p", "No routes for this project. Add a profile or select another project."));
  }

  function renderProjects() {
    const container = $("projects");
    container.replaceChildren();
    (state.projects || []).forEach((project) => {
      const card = make("article");
      card.className = "project-card";
      const header = make("header");
      header.append(make("h3", project.display_name || project.project_id));
      header.append(make("span", project.project_id));
      card.append(header);
      const workspace = currentWorkspace(project.project_id);
      const coordinator = find(state.coordinators, "coordinator_id", state.coordinator_id);
      const fields = make("div");
      fields.className = "project-fields";
      fields.append(textField("Display name", project.display_name, (value) => setField(project, "display_name", value)));
      fields.append(textField("Current workspace path", workspace && workspace.canonical_path || "", (value) => {
        if (workspace) workspace.canonical_path = value || null;
        markDirty();
      }));
      fields.append(textField("Coordinator allowlist (comma separated)", coordinator && coordinator.allowed_project_ids || [], (value) => {
        if (coordinator) coordinator.allowed_project_ids = value.split(",").map((item) => item.trim()).filter(Boolean);
        markDirty();
      }));
      const routeNames = (state.routes || []).filter((route) => route.project_id === project.project_id).map((route) => route.route_id).join(", ");
      const routesField = textField("Profiles", routeNames, () => {}, "text");
      routesField.querySelector("input").readOnly = true;
      fields.append(routesField);
      card.append(fields);
      const note = make("p", "Changing a workspace path after a session is bound will be rejected at startup. Add a new project/workspace for another repository.");
      note.className = "small-note";
      card.append(note);
      container.append(card);
    });
  }

  function renderAdvanced() {
    if (!advancedDirty.has("accounts-json")) $("accounts-json").value = JSON.stringify(state.accounts || [], null, 2);
    if (!advancedDirty.has("pins-json")) $("pins-json").value = JSON.stringify(state.native_binary_pins || {}, null, 2);
    if (!advancedDirty.has("coverage-json")) $("coverage-json").value = JSON.stringify(state.coverage_profiles || [], null, 2);
    if (!advancedDirty.has("state-dir")) $("state-dir").value = state.state_dir || "";
    $("mcp-json").value = bootstrap.snippets.json;
    $("codex-toml").value = bootstrap.snippets.toml;
  }

  function render() {
    $("revision-label").textContent = `Revision ${revision.slice(0, 12)} · ${state.routes.length} route(s)`;
    $("project-filter").replaceChildren(option("", "All projects", !projectFilter), ...(state.projects || []).map(project => option(project.project_id, project.display_name, project.project_id === projectFilter)));
    renderRoutes();
    renderProjects();
    renderAdvanced();
  }

  function renderWizard() {
    const wizard = $("project-wizard");
    wizard.replaceChildren();
    wizard.append(make("h3", "Add a project"));
    const wizardStatus = make("div");
    wizardStatus.className = "wizard-status status";
    wizardStatus.setAttribute("role", "status");
    wizardStatus.setAttribute("aria-live", "polite");
    wizard.append(wizardStatus);

    let selectedFolder = "";
    let selectedListing = null;
    let folderListing = null;
    let pickerRequest = 0;
    let pickerLoading = false;
    let displayTouched = false;
    let scopeMode = "project";
    const ignoredNames = new Set([".git", ".state", "node_modules", "dist", "build", "coverage", ".next", ".nuxt", ".cache", ".venv", "venv", "__pycache__", ".DS_Store"]);
    const commonCodeDirectories = new Set(["src", "app", "apps", "lib", "libs", "packages", "tests", "test", "scripts", "docs", "include", "public"]);
    const selectedCodeDirectories = new Set();
    const display = document.createElement("input");
    display.placeholder = "Project display name";
    const workspacePath = document.createElement("input");
    workspacePath.placeholder = "Choose a project folder";
    workspacePath.readOnly = true;
    const source = document.createElement("textarea");
    source.placeholder = "Source prefixes, one per line";
    const excluded = document.createElement("textarea");
    excluded.placeholder = "Excluded prefixes, one per line";
    const nonSource = document.createElement("textarea");
    nonSource.placeholder = "Non-source prefixes, one per line";
    const writeScope = document.createElement("textarea");
    writeScope.placeholder = "Write scope, one per line";
    const access = document.createElement("select");
    access.append(
      option("workspace_write", "Allow workers to edit selected files (recommended)", true),
      option("read_only", "Read only", false),
    );
    const copy = document.createElement("select");
    const defaultCopyProject = projectFilter || state.projects?.[0]?.project_id || "";
    copy.append(option("", "None", !defaultCopyProject));
    (state.projects || []).forEach((project) => copy.append(option(
      project.project_id,
      `All profiles from ${project.display_name || project.project_id}`,
      project.project_id === defaultCopyProject,
    )));

    const help = (text) => {
      const node = make("span", text);
      node.className = "field-help";
      return node;
    };
    const field = (labelText, node, helpText = "") => {
      const label = make("label");
      label.append(make("span", labelText));
      if (helpText) label.append(help(helpText));
      label.append(node);
      return label;
    };
    const grid = make("div");
    grid.className = "field-grid";
    grid.append(
      field("Display name", display, "Suggested from the folder name; edit it to use a different project name."),
      field("Project folder", workspacePath, "Choose the repository folder where your agents will work."),
    );
    display.addEventListener("input", () => { displayTouched = true; });
    const browse = make("button", "Browse folders");
    browse.className = "button secondary";
    browse.type = "button";
    const browseActions = make("div");
    browseActions.className = "actions";
    browseActions.append(browse);
    grid.append(browseActions);
    wizard.append(grid);

    const picker = make("div");
    picker.className = "folder-picker hidden";
    const pickerCurrent = make("p");
    pickerCurrent.className = "folder-picker-current";
    const pickerControls = make("div");
    pickerControls.className = "folder-picker-controls";
    picker.append(pickerCurrent, pickerControls);
    wizard.append(picker);

    const scopeSelect = document.createElement("select");
    scopeSelect.append(
      option("project", "Project files (recommended)", true),
      option("code", "Code folders and root files", false),
      option("custom", "Custom", false),
    );
    const scopeGrid = make("div");
    scopeGrid.className = "field-grid";
    scopeGrid.append(field("Scope preset", scopeSelect, "Generated folders are excluded. Add new files or folders in the project root to coverage later."));
    const scopeHelp = make("p", "Project files includes every scanned top-level file and folder except ignored generated folders. Code folders and root files lets you choose existing common code folders.");
    scopeHelp.className = "small-note";
    scopeGrid.append(scopeHelp);
    const scopeSummary = make("p");
    scopeSummary.className = "small-note";
    scopeGrid.append(scopeSummary);
    const codeChoices = make("div");
    codeChoices.className = "code-folder-choices";
    scopeGrid.append(codeChoices);
    const advancedScopeGrid = make("div");
    advancedScopeGrid.className = "field-grid";
    advancedScopeGrid.append(
      field("Source prefixes", source, "Editable relative top-level names; do not use '.' or '*'."),
      field("Excluded prefixes", excluded, "Ignored existing top-level names are excluded by the presets."),
      field("Non-source prefixes", nonSource, "Optional generated or non-source areas not covered as source."),
      field("Write scope", writeScope, "Workers can write only these source-covered prefixes."),
    );
    wizard.append(scopeGrid);

    const advanced = document.createElement("details");
    advanced.className = "wizard-advanced";
    advanced.append(make("summary", "Advanced folder and scope settings"));
    const manualPath = document.createElement("input");
    manualPath.placeholder = "Absolute folder path";
    const loadFolder = make("button", "Load folder");
    loadFolder.className = "button secondary";
    loadFolder.type = "button";
    const manualRow = make("div");
    manualRow.className = "manual-folder";
    manualRow.append(field("Manual folder path", manualPath, "Optional alternative to Browse folders; it uses the same validation and scan."));
    manualRow.append(loadFolder);
    advanced.append(manualRow, advancedScopeGrid);
    wizard.append(advanced);

    const policyGrid = make("div");
    policyGrid.className = "field-grid";
    policyGrid.append(
      field("Access", access, "Reviewer profiles are always read only; worker access controls the new worker policy."),
      field("Copy agent profiles", copy, "Reuse providers, models, effort, roles, and subagent preferences from another project."),
    );
    wizard.append(policyGrid);
    const explanation = make("p", "Create adds the project to your draft. Save configuration afterwards, then restart MCP to use it.");
    explanation.className = "small-note";
    wizard.append(explanation);
    const actions = make("div");
    actions.className = "actions";
    const create = make("button", "Create project");
    create.className = "button primary";
    create.type = "button";
    const cancel = make("button", "Cancel");
    cancel.className = "button secondary";
    cancel.type = "button";
    actions.append(create, cancel);
    wizard.append(actions);

    function wizardMessage(message, kind = "") {
      wizardStatus.textContent = message;
      wizardStatus.className = `wizard-status status ${kind}`;
    }

    function listValue(node) {
      return node.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    }

    function setList(node, values) {
      node.value = values.join("\n");
    }

    function currentSourceList() {
      return listValue(source);
    }

    function syncWriteScope() {
      writeScope.disabled = access.value === "read_only";
      if (access.value === "read_only") setList(writeScope, []);
      else if (scopeMode !== "custom") setList(writeScope, currentSourceList());
    }

    function renderCodeChoices() {
      codeChoices.replaceChildren();
      if (scopeMode !== "code") return;
      codeChoices.append(make("strong", "Existing common code folders"));
      const entries = Array.isArray(selectedListing?.entries) ? selectedListing.entries : [];
      const choices = entries.filter((entry) => entry.kind === "directory" && commonCodeDirectories.has(entry.name) && !ignoredNames.has(entry.name));
      if (!choices.length) {
        codeChoices.append(make("p", "No common code folders were found. Add root files or edit Source prefixes; an empty source scope cannot be created."));
        return;
      }
      for (const entry of choices) {
        const label = make("label");
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = selectedCodeDirectories.has(entry.name);
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) selectedCodeDirectories.add(entry.name);
          else selectedCodeDirectories.delete(entry.name);
          syncScopeLists("code");
        });
        label.append(checkbox, make("span", entry.name));
        codeChoices.append(label);
      }
    }

    function syncScopeLists(kind) {
      const enteringCodePreset = kind === "code" && scopeMode !== "code";
      scopeMode = kind;
      if (!selectedListing) return;
      const entries = Array.isArray(selectedListing.entries) ? selectedListing.entries : [];
      const names = entries.map((entry) => entry.name).filter(Boolean);
      setList(excluded, names.filter((name) => ignoredNames.has(name)));
      setList(nonSource, []);
      if (kind === "project") {
        setList(source, names.filter((name) => !ignoredNames.has(name)));
      } else if (kind === "code") {
        if (enteringCodePreset) {
          entries.filter((entry) => entry.kind === "directory" && commonCodeDirectories.has(entry.name) && !ignoredNames.has(entry.name))
            .forEach((entry) => selectedCodeDirectories.add(entry.name));
        }
        for (const name of [...selectedCodeDirectories]) {
          if (!names.includes(name) || !commonCodeDirectories.has(name)) selectedCodeDirectories.delete(name);
        }
        setList(source, names.filter((name) => !ignoredNames.has(name) && (
          entries.find((entry) => entry.name === name)?.kind === "file" || selectedCodeDirectories.has(name)
        )));
      }
      syncWriteScope();
      renderCodeChoices();
      updateCreateState();
    }

    function updateCreateState() {
      const sources = currentSourceList();
      const invalid = sources.some((value) => value === "." || value === "*");
      create.disabled = pickerLoading || !selectedFolder || sources.length === 0 || invalid;
      scopeSummary.textContent = selectedFolder
        ? `Included (${sources.length}): ${sources.slice(0, 12).join(", ") || "none"}${sources.length > 12 ? ", …" : ""}. Excluded (${listValue(excluded).length}): ${listValue(excluded).slice(0, 12).join(", ") || "none"}.`
        : "Choose a project folder to populate this preset.";
    }

    function chooseFolder(listing) {
      selectedFolder = listing.path;
      selectedListing = listing;
      selectedCodeDirectories.clear();
      if (scopeMode === "code") {
        listing.entries.filter((entry) => entry.kind === "directory" && commonCodeDirectories.has(entry.name))
          .forEach((entry) => selectedCodeDirectories.add(entry.name));
      }
      workspacePath.value = listing.path;
      manualPath.value = listing.path;
      if (!displayTouched) display.value = listing.path.split(/[\\/]/).filter(Boolean).pop() || listing.path;
      if (scopeMode !== "custom") {
        scopeSelect.value = scopeMode;
        syncScopeLists(scopeMode);
      }
      updateCreateState();
    }

    function renderPicker() {
      pickerCurrent.textContent = folderListing ? `Current folder: ${folderListing.path}` : "Choose a folder to inspect its top-level entries.";
      pickerControls.replaceChildren();
      if (!folderListing) return;
      const up = make("button", "Up");
      up.className = "button secondary";
      up.type = "button";
      up.disabled = pickerLoading || folderListing.parent === null;
      up.addEventListener("click", () => void loadFolderPath(folderListing.parent));
      const roots = document.createElement("select");
      roots.setAttribute("aria-label", "Drive or root");
      roots.append(option("", "Choose drive or root", true));
      (folderListing.roots || []).forEach((root) => roots.append(option(root, root, false)));
      roots.disabled = pickerLoading;
      roots.addEventListener("change", () => { if (roots.value) void loadFolderPath(roots.value); });
      pickerControls.append(up, roots);
      const children = make("div");
      children.className = "folder-children";
      for (const directory of folderListing.directories || []) {
        const button = make("button", directory.name);
        button.className = "button secondary";
        button.type = "button";
        button.disabled = pickerLoading;
        button.addEventListener("click", () => void loadFolderPath(directory.path));
        children.append(button);
      }
      pickerControls.append(children);
      const use = make("button", "Use this folder");
      use.className = "button primary";
      use.type = "button";
      use.disabled = pickerLoading;
      use.addEventListener("click", () => {
        chooseFolder(folderListing);
        picker.classList.add("hidden");
      });
      pickerControls.append(use);
      const closePicker = make("button", "Cancel folder selection");
      closePicker.className = "button secondary";
      closePicker.type = "button";
      closePicker.addEventListener("click", () => {
        pickerRequest += 1;
        pickerLoading = false;
        picker.classList.add("hidden");
        updateCreateState();
      });
      pickerControls.append(closePicker);
    }

    async function loadFolderPath(requested, selectAfter = false) {
      const requestId = ++pickerRequest;
      pickerLoading = true;
      updateCreateState();
      renderPicker();
      try {
        const body = await api("/api/folders", {
          method: "POST",
          body: JSON.stringify(requested ? { path: requested } : {}),
        });
        if (requestId !== pickerRequest) return;
        folderListing = body;
        if (selectAfter) chooseFolder(body);
        renderPicker();
        wizardMessage(`Scanned ${body.entries.length} top-level entr${body.entries.length === 1 ? "y" : "ies"}.`, "success");
      } catch (error) {
        if (requestId === pickerRequest) wizardMessage(error.message, "error");
      } finally {
        if (requestId === pickerRequest) {
          pickerLoading = false;
          updateCreateState();
          renderPicker();
        }
      }
    }

    browse.addEventListener("click", () => {
      picker.classList.remove("hidden");
      void withButtonBusy(browse, () => loadFolderPath(selectedFolder || undefined));
    });
    loadFolder.addEventListener("click", () => {
      if (!manualPath.value.trim()) {
        wizardMessage("Enter an absolute folder path to load.", "error");
        return;
      }
      void withButtonBusy(loadFolder, () => loadFolderPath(manualPath.value.trim(), true));
    });
    scopeSelect.addEventListener("change", () => {
      if (scopeSelect.value !== "custom") syncScopeLists(scopeSelect.value);
      else scopeMode = "custom";
      renderCodeChoices();
      updateCreateState();
    });
    for (const node of [source, excluded, nonSource, writeScope]) {
      node.addEventListener("input", () => {
        scopeMode = "custom";
        scopeSelect.value = "custom";
        updateCreateState();
      });
    }
    access.addEventListener("change", () => {
      syncWriteScope();
      updateCreateState();
    });
    cancel.addEventListener("click", () => {
      pickerRequest += 1;
      wizard.classList.add("hidden");
    });

    create.addEventListener("click", () => {
      const sourcePrefixes = currentSourceList();
      if (!display.value.trim() || !sourcePrefixes.length || !selectedFolder) {
        wizardMessage("Choose a project folder, enter a display name, and select at least one source prefix.", "error");
        return;
      }
      if (sourcePrefixes.some((value) => value === "." || value === "*")) {
        wizardMessage("Source prefixes must name concrete relative top-level entries; '.' and '*' are not allowed.", "error");
        return;
      }
      try {
        syncAdvanced();
      } catch (error) {
        wizardMessage(`Fix advanced configuration before creating the project: ${error.message}`, "error");
        return;
      }
      const projectId = uniqueId("project");
      const coverageId = uniqueId("coverage");
      const policyId = uniqueId("worker-policy");
      const reviewerPolicyId = uniqueId("review-policy");
      state.projects.push({ project_id: projectId, display_name: display.value.trim() });
      state.workspaces.push({ workspace_id: uniqueId("workspace"), project_id: projectId, mode: "current", canonical_path: selectedFolder, coverage_profile_id: coverageId });
      state.workspaces.push({ workspace_id: uniqueId("workspace"), project_id: projectId, mode: "review_slot", canonical_path: null, coverage_profile_id: coverageId });
      state.coverage_profiles.push({
        coverage_profile_id: coverageId,
        version: "1",
        config: {
          source_prefixes: sourcePrefixes,
          non_source_prefixes: listValue(nonSource),
          excluded_prefixes: listValue(excluded),
        },
      });
      state.policy_profiles.push({ policy_profile_id: policyId, version: "1", config: {
        access: access.value,
        write_scope: access.value === "read_only" ? [] : listValue(writeScope),
      } });
      state.policy_profiles.push({ policy_profile_id: reviewerPolicyId, version: "1", config: { access: "read_only", write_scope: [] } });
      const coordinator = find(state.coordinators, "coordinator_id", state.coordinator_id);
      if (coordinator && !coordinator.allowed_project_ids.includes(projectId)) coordinator.allowed_project_ids.push(projectId);
      (state.routes || []).filter((route) => route.project_id === copy.value).forEach((sourceRoute) => {
        const copied = JSON.parse(JSON.stringify(sourceRoute));
        copied.route_id = uniqueId(sourceRoute.route_id || "route");
        copied.project_id = projectId;
        copied.policy_profile_id = sourceRoute.role === "reviewer" ? reviewerPolicyId : policyId;
        state.routes.push(copied);
      });
      wizard.classList.add("hidden");
      projectFilter = projectId;
      markDirty();
      render();
      status("New project staged with new bindings. Save, then restart the operator.", "success");
    });
    renderPicker();
    renderCodeChoices();
    updateCreateState();
  }

  async function load() {
    try {
      const body = await api("/api/config");
      state = body.config;
      revision = body.revision;
      dirty = false;
      advancedDirty.clear();
      $("change-label").textContent = "Saved configuration";
      render();
      status("Configuration loaded. Changes are local until saved.", "success");
    } catch (error) {
      status(error.message, "error");
    }
  }

  async function save() {
    try {
      syncAdvanced();
      const body = await api("/api/config", { method: "PUT", body: JSON.stringify({ config: state, revision }) });
      revision = body.revision;
      dirty = false;
      $("change-label").textContent = "Saved · restart MCP for new sessions";
      render();
      status(`${body.message} Backup: ${body.backup}`, "success");
    } catch (error) {
      status(error.message, "error");
    }
  }

  let configOperation = null;
  async function runConfigOperation(button, callback) {
    if (configOperation) return;
    configOperation = button;
    const peer = button === $("save") ? $("reload") : $("save");
    const peerDisabled = peer.disabled;
    peer.disabled = true;
    try {
      await withButtonBusy(button, callback);
    } finally {
      peer.disabled = peerDisabled;
      configOperation = null;
    }
  }

  $("reload").addEventListener("click", () => {
    if (!dirty || window.confirm("Discard unsaved changes and reload?")) runConfigOperation($("reload"), load);
  });
  $("save").addEventListener("click", () => runConfigOperation($("save"), save));
  $("add-route").addEventListener("click", () => {
    const project = find(state.projects, "project_id", projectFilter) || state.projects[0];
    const account = state.accounts[0];
    const policy = state.policy_profiles[0];
    if (!project || !account || !policy) {
      status("Add a project, account, and policy before adding a route.", "error");
      return;
    }
    state.routes.push({ route_id: uniqueId("route"), project_id: project.project_id, provider: account.provider, account_profile_id: account.account_profile_id, model: "manual-model", role: "worker", policy_profile_id: policy.policy_profile_id, native_subagents: { mode: "off", max_agents: 1 } });
    markDirty();
    renderRoutes();
  });
  $("new-project").addEventListener("click", () => action(() => {
    syncAdvanced();
    $("project-wizard").classList.remove("hidden");
    renderWizard();
  }));
  $("project-filter").addEventListener("change", () => { projectFilter = $("project-filter").value; renderRoutes(); });
  for (const id of ["accounts-json", "pins-json", "coverage-json", "state-dir"]) {
    $(id).addEventListener("input", () => { advancedDirty.add(id); markDirty(); });
  }
  $("apply-advanced").addEventListener("click", () => action(() => { syncAdvanced(); render(); status("Advanced edits applied to the form. Save to persist them."); }));
  for (const [button, field] of [["copy-json", "mcp-json"], ["copy-toml", "codex-toml"]]) {
    $(button).addEventListener("click", async () => {
      let copied = false;
      await withButtonBusy($(button), async () => {
        try {
          await navigator.clipboard.writeText($(field).value);
          copied = true;
          status("Connection snippet copied.", "success");
        } catch {
          $(field).focus();
          $(field).select();
          status("Select and copy the highlighted snippet manually.");
        }
      });
      if (copied) showButtonMessage($(button), "Copied!");
    });
  }
  runConfigOperation($("reload"), load);
})();
