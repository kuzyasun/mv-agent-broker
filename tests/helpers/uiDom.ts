/**
 * Minimal DOM stub for the operator settings page script (src/operator/ui/app.js).
 * No browser and no DOM dependency: the stub implements exactly the element
 * surface the script uses (append/replaceChildren/listeners/className/values)
 * so pool rendering and interactions can be exercised offline in Node.
 *
 * textContent is a prototype accessor pair in both classes: an instance data
 * field would shadow the StubElement aggregation getter (ES2022 class-field
 * semantics) and break tree reads.
 */

export class StubNode {
  private text: string;

  constructor(text = "") {
    this.text = text;
  }

  get textContent(): string {
    return this.text;
  }

  set textContent(value: string) {
    this.text = value;
  }

  get nodeType(): number {
    return 3;
  }

  cloneNode(): StubNode {
    return new StubNode(this.textContent);
  }
}

export class StubElement extends StubNode {
  readonly tagName: string;
  children: StubElement[] = [];
  childNodes: Array<StubElement | StubNode> = [];
  parentNode: StubElement | null = null;
  listeners = new Map<string, Array<(event?: unknown) => void>>();
  attributes = new Map<string, string>();
  id = "";
  value = "";
  type = "";
  placeholder = "";
  title = "";
  disabled = false;
  readOnly = false;
  checked = false;
  open = false;
  hidden = false;
  private readonly classes = new Set<string>();
  private selectedFlag = false;

  constructor(tagName: string) {
    super();
    this.tagName = tagName;
  }

  get nodeType(): number {
    return 1;
  }

  /** option.selected=true selects it in the parent select, like the DOM. */
  get selected(): boolean {
    return this.selectedFlag;
  }

  set selected(value: boolean) {
    this.selectedFlag = value;
    const parent = this.parentNode;
    if (value && parent instanceof StubElement && parent.tagName === "select") {
      parent.value = this.value;
    }
  }

  get className(): string {
    return [...this.classes].join(" ");
  }

  set className(value: string) {
    this.classes.clear();
    for (const name of value.split(/\s+/).filter(Boolean)) this.classes.add(name);
  }

  get classList(): { add(name: string): void; remove(name: string): void; contains(name: string): boolean } {
    const classes = this.classes;
    return {
      add(name: string) { classes.add(name); },
      remove(name: string) { classes.delete(name); },
      contains(name: string) { return classes.has(name); },
    };
  }

  get textContent(): string {
    if (this.childNodes.length) return this.childNodes.map((child) => child.textContent).join("");
    return super.textContent;
  }

  set textContent(value: string) {
    // Real DOM semantics: assigning textContent replaces children with one
    // text node, so later append() calls keep the label text as first child.
    this.childNodes = value === "" ? [] : [new StubNode(value)];
    this.children = [];
    super.textContent = value;
  }

  append(...nodes: Array<StubElement | StubNode>): void {
    for (const node of nodes) {
      node.parentNode = this;
      this.childNodes.push(node);
      if (node instanceof StubElement) {
        this.children.push(node);
        // Options are constructed before insertion; a pre-selected option
        // becomes the select's value on append, like real DOM selectedness.
        if (this.tagName === "select" && node.selected) this.value = node.value;
      }
    }
  }

  replaceChildren(...nodes: Array<StubElement | StubNode>): void {
    this.childNodes = [];
    this.children = [];
    this.append(...nodes);
  }

  addEventListener(type: string, listener: (event?: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  dispatch(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener({});
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  /** Supports the two forms the script and tests use: "tag" and ".class". */
  querySelector(selector: string): StubElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): StubElement[] {
    const matches = selector.startsWith(".")
      ? (element: StubElement) => element.classList.contains(selector.slice(1))
      : (element: StubElement) => element.tagName === selector.toLowerCase();
    const out: StubElement[] = [];
    for (const child of this.children) {
      if (matches(child)) out.push(child);
      out.push(...child.querySelectorAll(selector));
    }
    return out;
  }

  closest(): StubElement | null {
    return null;
  }

  focus(): void { /* read-only textarea flow */ }
  select(): void { /* manual copy flow */ }
}

export class StubDocument {
  readonly elements = new Map<string, StubElement>();
  readonly globalListeners = new Map<string, Array<(event?: unknown) => void>>();
  hidden = false;
  readonly body = new StubElement("body");

  getElementById(id: string): StubElement {
    let element = this.elements.get(id);
    if (!element) {
      element = new StubElement("div");
      element.id = id;
      this.elements.set(id, element);
    }
    return element;
  }

  createElement(tagName: string): StubElement {
    return new StubElement(tagName);
  }

  createTextNode(text: string): StubNode {
    return new StubNode(text);
  }

  addEventListener(type: string, listener: (event?: unknown) => void): void {
    const list = this.globalListeners.get(type) ?? [];
    list.push(listener);
    this.globalListeners.set(type, list);
  }
}

/** Find the pool section whose aria-label matches the role pool name. */
export function findPool(routesContainer: StubElement, poolName: string): StubElement | null {
  return routesContainer.children.find((pool) => pool.getAttribute("aria-label") === poolName) ?? null;
}

/** Cards are articles inside a pool's route grid. */
export function poolCards(pool: StubElement): StubElement[] {
  return pool.children.filter((child) => child.classList.contains("route-grid"))
    .flatMap((grid) => grid.children.filter((card) => card.classList.contains("route-card")));
}

export async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}
