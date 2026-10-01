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
  const option = (value, label, selected) => {
    const node = make("option", label);
    node.value = value;
    node.selected = selected;
    return node;
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
        refresh.disabled = true;
        status(`Reading pinned ${route.provider} metadata…`);
        try {
          const body = await api("/api/models/refresh", { method: "POST", body: JSON.stringify({ provider: route.provider }) });
          catalogues.set(route.provider, body.options || []);
          const observed = body.observation;
          status(`${observed.models.length} ${route.provider} entries · ${observed.source} · ${new Date(observed.observed_at).toLocaleString()}. ${observed.detail || "Catalogue only; authentication and quota are unknown."}`, observed.models.length ? "success" : "error");
          renderRoutes();
        } catch (error) {
          status(error.message, "error");
        } finally {
          refresh.disabled = false;
        }
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
      fields.append(selectField("Role", route.role, ["worker", "reviewer", "researcher"].map((value) => ({ value, label: value })), (value) => setField(route, "role", value)));
      fields.append(selectField("Explicit policy", route.policy_profile_id, (state.policy_profiles || []).map((policy) => ({ value: policy.policy_profile_id, label: `${policy.policy_profile_id} · ${policy.config && policy.config.access || "access not set"}` })), (value) => {
        setField(route, "policy_profile_id", value);
        renderRoutes();
      }));
      const policy = selectedPolicy(route);
      const accessField = textField("Selected policy access", policy && policy.config && policy.config.access || "not set", () => {});
      accessField.querySelector("input").readOnly = true;
      fields.append(accessField);

      const modelLabel = make("label", "Model (catalogue is advisory; manual entry allowed)");
      const model = document.createElement("input");
      model.value = route.model || "";
      model.setAttribute("list", `models-${index}`);
      model.addEventListener("input", () => setField(route, "model", model.value));
      model.addEventListener("change", () => { setField(route, "model", model.value); renderRoutes(); });
      const datalist = document.createElement("datalist");
      datalist.id = `models-${index}`;
      (catalogues.get(route.provider) || []).forEach((entry) => datalist.append(option(entry.model, `${entry.model} (${entry.efforts.join(", ")})`, false)));
      modelLabel.append(model, datalist);
      fields.append(modelLabel);
      const known = (catalogues.get(route.provider) || []).find((entry) => entry.model === route.model);
      const fallback = { cursor: ["", "none", "low", "normal", "medium", "high", "xhigh", "max"], antigravity: ["", "low", "medium", "high", "max"], zcode: ["", "low", "high", "max"] };
      const effortValues = [...(known ? known.efforts : fallback[route.provider] || [""])];
      const currentEffort = route.effort ?? "";
      if (!effortValues.includes(currentEffort)) effortValues.push(currentEffort);
      fields.append(selectField("Effort (parent/model limits apply)", currentEffort, effortValues.map((value) => ({ value, label: value || "No override" })), (value) => setField(route, "effort", value || null)));
      fields.append(selectField("Native subagents (advisory)", route.native_subagents && route.native_subagents.mode || "off", ["off", "prefer"].map((value) => ({ value, label: value })), (value) => {
        route.native_subagents = { mode: value, max_agents: route.native_subagents && route.native_subagents.max_agents || 1 };
        markDirty();
      }));
      fields.append(textField("Desired child count", route.native_subagents && route.native_subagents.max_agents || 1, (value) => {
        route.native_subagents = { mode: route.native_subagents && route.native_subagents.mode || "off", max_agents: Number(value) };
        markDirty();
      }, "number"));
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
    const title = make("h3", "Create a new project and two fresh workspace bindings");
    wizard.append(title);
    const grid = make("div");
    grid.className = "field-grid";
    const display = document.createElement("input");
    display.placeholder = "Project display name";
    const workspacePath = document.createElement("input");
    workspacePath.placeholder = "Current workspace path";
    const source = document.createElement("textarea");
    source.placeholder = "Source prefixes, one per line (required)";
    const excluded = document.createElement("textarea");
    excluded.placeholder = "Excluded prefixes, one per line";
    const nonSource = document.createElement("textarea");
    nonSource.placeholder = "Non-source prefixes, one per line";
    const writeScope = document.createElement("textarea");
    writeScope.placeholder = "Write scope, one per line";
    const access = document.createElement("select");
    access.append(option("read_only", "read_only", true), option("workspace_write", "workspace_write", false));
    const copy = document.createElement("select");
    copy.append(option("", "Do not copy an existing route", true));
    (state.routes || []).forEach((route) => copy.append(option(route.route_id, `Copy ${route.route_id}`, false)));
    grid.append(textField("Display name", "", (value) => { display.value = value; }), textField("Current path", "", (value) => { workspacePath.value = value; }));
    const wrap = (label, node) => { const labelNode = make("label", label); labelNode.append(node); return labelNode; };
    grid.append(wrap("Source prefixes", source), wrap("Excluded prefixes", excluded), wrap("Non-source prefixes", nonSource), wrap("Write scope", writeScope), wrap("Access policy", access), wrap("Copy route", copy));
    wizard.append(grid);
    const explanation = make("p", "The wizard creates unique project/workspace/policy/coverage IDs, with current and review_slot workspaces. Source, exclusion, and access arrays are explicit.");
    explanation.className = "small-note";
    wizard.append(explanation);
    const actions = make("div");
    actions.className = "actions";
    const create = make("button", "Create project");
    create.className = "button primary";
    create.type = "button";
    create.addEventListener("click", () => {
      if (!display.value.trim() || !source.value.trim() || !workspacePath.value.trim()) {
        status("Project name, current path, and at least one source prefix are required.", "error");
        return;
      }
      const projectId = uniqueId("project");
      const coverageId = uniqueId("coverage");
      const policyId = uniqueId("worker-policy");
      const reviewerPolicyId = uniqueId("review-policy");
      state.projects.push({ project_id: projectId, display_name: display.value.trim() });
      state.workspaces.push({ workspace_id: uniqueId("workspace"), project_id: projectId, mode: "current", canonical_path: workspacePath.value.trim(), coverage_profile_id: coverageId });
      state.workspaces.push({ workspace_id: uniqueId("workspace"), project_id: projectId, mode: "review_slot", canonical_path: null, coverage_profile_id: coverageId });
      state.coverage_profiles.push({
        coverage_profile_id: coverageId,
        version: "1",
        config: {
          source_prefixes: source.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
          non_source_prefixes: nonSource.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
          excluded_prefixes: excluded.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
        },
      });
      state.policy_profiles.push({ policy_profile_id: policyId, version: "1", config: {
        access: access.value,
        write_scope: writeScope.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
      } });
      state.policy_profiles.push({ policy_profile_id: reviewerPolicyId, version: "1", config: { access: "read_only", write_scope: [] } });
      const coordinator = find(state.coordinators, "coordinator_id", state.coordinator_id);
      if (coordinator && !coordinator.allowed_project_ids.includes(projectId)) coordinator.allowed_project_ids.push(projectId);
      if (copy.value) {
        const sourceRoute = find(state.routes, "route_id", copy.value);
        if (sourceRoute) state.routes.push({ ...JSON.parse(JSON.stringify(sourceRoute)), route_id: uniqueId(sourceRoute.route_id), project_id: projectId, policy_profile_id: sourceRoute.role === "reviewer" ? reviewerPolicyId : policyId });
      }
      wizard.classList.add("hidden");
      projectFilter = projectId;
      markDirty();
      render();
      status("New project staged with new bindings. Save, then restart the operator.", "success");
    });
    const cancel = make("button", "Cancel");
    cancel.className = "button secondary";
    cancel.type = "button";
    cancel.addEventListener("click", () => wizard.classList.add("hidden"));
    actions.append(create, cancel);
    wizard.append(actions);
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

  $("reload").addEventListener("click", () => { if (!dirty || window.confirm("Discard unsaved changes and reload?")) load(); });
  $("save").addEventListener("click", save);
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
      try { await navigator.clipboard.writeText($(field).value); status("Connection snippet copied.", "success"); }
      catch { $(field).focus(); $(field).select(); status("Select and copy the highlighted snippet manually."); }
    });
  }
  load();
})();
