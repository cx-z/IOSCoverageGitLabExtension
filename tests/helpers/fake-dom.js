"use strict";

class FakeClassList {
  constructor(owner) {
    this.owner = owner;
  }
  values() {
    return this.owner._className.split(/\s+/).filter(Boolean);
  }
  contains(value) {
    return this.values().includes(value);
  }
  add(value) {
    if (!this.contains(value)) this.owner._className = [...this.values(), value].join(" ");
  }
  remove(value) {
    this.owner._className = this.values().filter((item) => item !== value).join(" ");
  }
  toggle(value, force) {
    const enabled = force === undefined ? !this.contains(value) : Boolean(force);
    if (enabled) this.add(value); else this.remove(value);
    return enabled;
  }
}

function parseSimpleSelector(selector) {
  const attributeMatches = [...selector.matchAll(/\[([^=\]]+)(?:="?([^"\]]+)"?)?\]/g)];
  const withoutAttributes = selector.replace(/\[[^\]]+\]/g, "");
  const idMatch = withoutAttributes.match(/#([A-Za-z0-9_-]+)/);
  const classes = [...withoutAttributes.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((match) => match[1]);
  const tagMatch = withoutAttributes.match(/^[A-Za-z][A-Za-z0-9-]*/);
  return {
    tag: tagMatch ? tagMatch[0].toUpperCase() : null,
    id: idMatch ? idMatch[1] : null,
    classes,
    attributes: attributeMatches.map((match) => ({ name: match[1], value: match[2] })),
  };
}

function matchesSimple(element, selector) {
  if (!element || element.nodeType !== 1) return false;
  const parsed = parseSimpleSelector(selector);
  if (parsed.tag && element.tagName !== parsed.tag) return false;
  if (parsed.id && element.id !== parsed.id) return false;
  if (!parsed.classes.every((name) => element.classList.contains(name))) return false;
  return parsed.attributes.every(({ name, value }) => {
    const actual = element.getAttribute(name);
    return actual !== null && (value === undefined || actual === value);
  });
}

function matchesSelector(element, selector) {
  const parts = selector.trim().split(/\s+/);
  if (!matchesSimple(element, parts.at(-1))) return false;
  let ancestor = element.parentElement;
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    while (ancestor && !matchesSimple(ancestor, parts[index])) ancestor = ancestor.parentElement;
    if (!ancestor) return false;
    ancestor = ancestor.parentElement;
  }
  return true;
}

class FakeText {
  constructor(text, ownerDocument) {
    this.nodeType = 3;
    this.textContent = text;
    this.ownerDocument = ownerDocument;
    this.parentElement = null;
  }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }
}

class FakeElement {
  constructor(tagName, ownerDocument = null) {
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.parentElement = null;
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this._className = "";
    this._textContent = "";
    this.classList = new FakeClassList(this);
    this.listeners = new Map();
  }
  get className() { return this._className; }
  set className(value) { this._className = String(value); }
  get id() { return this.getAttribute("id") || ""; }
  set id(value) { this.setAttribute("id", String(value)); }
  get textContent() {
    return this._textContent + this.children.map((child) => child.textContent || "").join("");
  }
  set textContent(value) {
    this._textContent = String(value);
    this.children = [];
  }
  set innerHTML(_value) { throw new Error("innerHTML is forbidden in tests"); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  setAttribute(name, value) {
    const text = String(value);
    this.attributes.set(name, text);
    if (name === "class") this.className = text;
    if (name.startsWith("data-")) {
      const key = name.slice(5).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
      this.dataset[key] = text;
    }
  }
  append(...nodes) {
    for (const value of nodes) {
      const node = typeof value === "string" ? new FakeText(value, this.ownerDocument) : value;
      node.parentElement = this;
      if (!node.ownerDocument) node.ownerDocument = this.ownerDocument;
      this.children.push(node);
    }
  }
  prepend(...nodes) {
    const prepared = nodes.map((value) => typeof value === "string" ?
      new FakeText(value, this.ownerDocument) : value);
    prepared.forEach((node) => { node.parentElement = this; });
    this.children = [...prepared, ...this.children];
  }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  querySelectorAll(selector) {
    const results = [];
    const visit = (node) => {
      for (const child of node.children || []) {
        if (matchesSelector(child, selector)) results.push(child);
        visit(child);
      }
    };
    visit(this);
    return results;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

class FakeDocument extends FakeElement {
  constructor() {
    super("document", null);
    this.nodeType = 9;
    this.ownerDocument = this;
    this.documentElement = this;
    this.hidden = false;
  }
  createElement(tag) { return new FakeElement(tag, this); }
  createTextNode(text) { return new FakeText(String(text), this); }
  addEventListener() {}
  removeEventListener() {}
}

module.exports = { FakeDocument, FakeElement };
