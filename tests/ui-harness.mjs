import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";
import { batchKey, historyBatches, historyTime, recentTestBatches } from "../lib/history-groups.mjs";
import { renderDailyHistory } from "../ui/history-preview.mjs";
import { createBatchRetest } from "../ui/batch-retest.mjs";
import { openRetestDrawer } from "../ui/retest.mjs";
import { failureInfo } from "../lib/diagnostics.mjs";
import { createResultInsights } from "../ui/result-insights.mjs";
import { createSettingsUI } from "../ui/settings.mjs";
import { mergeProgress, createRuntimeClock, createRunProgressView } from "../ui/run-progress.mjs";
import { createAccountTargets } from '../ui/account-targets.mjs';
import { createExperimentControls, repeatedResultGroups } from '../ui/experiments.mjs';
import { createPresetManager } from '../ui/presets.mjs';
import { generationTimeoutFromSeconds } from '../lib/test-parameters.mjs';
import { createRunNotes } from '../ui/run-notes.mjs';
import { targetLabel, normalizeTarget } from '../lib/targets.mjs';
import { readGrade, suiteCatalog } from '../lib/suites.mjs';
import { historyMatches } from '../lib/history-index.mjs';
import { createLabTools } from '../ui/lab-tools.mjs';
import { createChangelog } from '../ui/changelog.mjs';

export async function confirmClick(ui, control, accept = true) {
  const completion = control.fire("click");
  if (!ui.elements.get("confirm-dialog").open) {
    await completion;
    throw new Error("Expected a confirmation dialog");
  }
  await ui.elements.get(accept ? "confirm-accept" : "confirm-cancel").fire("click");
  return { completion };
}

class Element {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase(); this.children = []; this.handlers = {}; this.attributes = {}; this.dataset = {};
    this.hidden = false; this.value = ""; this.checked = false; this.disabled = false; this.className = ""; this._textContent = ""; this.textWrites = 0; this.replacements = 0;
    this.clientWidth = 200; this.clientHeight = 120; this.scrollLeft = 0; this.scrollTop = 0;
    if (tag === "iframe") this.contentWindow = {};
    this.style = { setProperty: (name, value) => { this.style[name] = value; } };
    this.classList = { add: (name) => { this.className += " " + name; }, remove: (name) => { this.className = this.className.replace(name, ""); },
      toggle: (name, on) => { if (on) this.classList.add(name); else this.classList.remove(name); } };
  }
  get textContent() { return this._textContent; }
  set textContent(value) { this._textContent = value; this.textWrites++; }
  get isConnected() { return this.parent ? this.parent.isConnected : Boolean(this._connected); }
  get parentElement() { return this.parent; }
  get firstElementChild() { return this.children[0] || null; }
  get scrollWidth() { return this.clientWidth + (this.className.includes("animation-lane") ? this.children.length * 210 : 0); }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node); } }
  insertBefore(node, before) { node.remove(); const index = this.children.indexOf(before); node.parent = this; if (index < 0) this.children.push(node); else this.children.splice(index, 0, node); }
  prepend(node) { this.insertBefore(node, this.children[0]); }
  scrollBy(options) { this.scrollLeft += options.left || 0; }
  after(node) { this.parent?.append(node); }
  replaceChildren(...nodes) { for (const child of this.children) child.parent = null; this.children = []; this.replacements++; this.textContent = ""; this.append(...nodes); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((node) => node !== this); this.parent = null; }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  getBoundingClientRect() { return this.rect || { left: 0, top: 0, right: this.clientWidth, bottom: this.clientHeight, width: this.clientWidth, height: this.clientHeight }; }
  getClientRects() { for (let item = this; item; item = item.parent) { if (item.hidden || item.parent?.tagName === "DETAILS" && !item.parent.open && item.tagName !== "SUMMARY") return []; } return this.isConnected ? [this.getBoundingClientRect()] : []; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const results = [];
    const matches = (child, part) => {
      if (part.startsWith(".")) return child.className.split(/\s+/).includes(part.slice(1));
      if (part.startsWith("[")) return child.getAttribute(part.slice(1, -1)) !== null;
      return child.tagName === part.split(/[:\[]/, 1)[0].toUpperCase() && (!part.includes(":disabled") || !child.disabled);
    };
    const visit = item => { for (const child of item.children) { if (selector.split(/,\s*/).some(part => matches(child, part))) results.push(child); visit(child); } };
    visit(this); return results;
  }
  addEventListener(type, listener) { (this.handlers[type] ||= []).push(listener); }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  focus() { this.focused = true; if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  select() { this.selectionStart = 0; this.selectionEnd = this.value.length; }
  showModal() { this.open = true; this.querySelector("[autofocus]")?.focus(); }
  close() { this.open = false; }
  async fire(type, details = {}) { for (const listener of [...(this.handlers[type] || []), this[`on${type}`]].filter(Boolean)) await listener({ preventDefault() {}, target: this, ...details }); }
}

export async function uiHarness({ bootstrap, detail, create, cleanup, open, openStorage, bank, accounts, exportBatch, saveBatch, gifExport, gifFile, saveGif, copyGif, removeGif, favorites, retests, settings, annotations, retention, writeClipboard, request, intersection = false, trackCollections = false, navigate = () => {}, search = "", viewport = { width: 1024, height: 768 }, token = "test-only-token", now = Date.now, monotonicNow = () => performance.now() }) {
  const source = await readFile(new URL("../ui/favorites.js", import.meta.url), "utf8") + "\n" + (await readFile(new URL("../ui/app.js", import.meta.url), "utf8")).replace(/^import .*;\r?\n/gm, "");
  const html = await readFile(new URL("../ui/index.html", import.meta.url), "utf8");
  const elements = new Map([...html.matchAll(/<([a-z][\w:-]*)\b[^>]*\bid="([^"]+)"[^>]*>/gi)].map(match => {
    const element = new Element(match[1]); element.hidden = /\shidden(?:\s|>)/.test(match[0]);
    for (const attribute of match[0].matchAll(/\b(aria-[\w-]+|tabindex)="([^"]*)"/g)) element.setAttribute(attribute[1], attribute[2]);
    if (/\sautofocus(?:\s|>)/.test(match[0])) element.setAttribute("autofocus", "");
    const tail = html.slice(match.index + match[0].length), plain = /^([^<]+)<\//.exec(tail); if (plain) element.textContent = plain[1];
    return [match[2], element];
  }));
  for (const name of ["max-tokens", "generation-timeout", "concurrency", 'repeat-count']) {
    const field = [...html.matchAll(/<input\b[^>]*>/g)].find(match => match[0].includes(`id="${name}"`));
    if (field) elements.get(name).value = field[0].match(/\bvalue="([^"]*)"/)?.[1] || "";
  }
  for (const [name, value] of [["history-filter", ""], ["fp-api", "auto"], ["fp-tier", "default"]]) if (elements.has(name)) elements.get(name).value = value;
  const app = new Element("main"), document = { getElementById: (id) => elements.get(id), createElement: (tag) => Object.assign(new Element(tag), { ownerDocument: document }), createElementNS: (_namespace, tag) => Object.assign(new Element(tag), { ownerDocument: document }),
    querySelector: selector => selector === "main.app" ? app : selector.includes("pelican-token") ? { content: token } : selector === '.view-tab[aria-selected="true"]'
      ? [...elements].find(([id, element]) => id.endsWith("-tab") && element.getAttribute("aria-selected") === "true")?.[1] : null, documentElement: new Element("html"), activeElement: null };
  for (const element of [app, document.documentElement, ...elements.values()]) { element.ownerDocument = document; element._connected = true; }
  elements.get("favorite-drawer").append(...["drawer-backdrop", "drawer-back", "drawer-title", "drawer-tools", "drawer-close", "drawer-content", "drawer-status", "drawer-footer"].map(id => elements.get(id)));
  elements.get("confirm-dialog").append(...["confirm-title", "confirm-message", "confirm-cancel", "confirm-accept"].map(id => elements.get(id)));
  const tabs = new Element(), window = { scrollY: 0, scrollTo({ top }) { this.scrollY = top; }, scrollBy({ top }) { this.scrollY += top; } };
  app.append(tabs); tabs.append(...["current", "fingerprint", "candy", "favorites", "history"].map(name => elements.get(`${name}-tab`)));
  let controller;
  const makeWire = () => new ReadableStream({ start(stream) { controller = stream; } });
  const event = (name, data) => controller.enqueue(new TextEncoder().encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`));
  const fetch = async (path, options = {}) => {
    if (request) return request(path, options);
    if (path === "api/bootstrap") return Response.json(bootstrap);
    if (path === "api/events") return new Response(makeWire());
    if (path.startsWith("api/settings")) return Response.json(await settings(path, options));
    if (path === "api/runs/annotations") return Response.json(await annotations(JSON.parse(options.body)));
    if (path === "api/retention/preview") return Response.json(await retention(path, options));
    if (path === "api/runs" && options.method === "POST") return Response.json(await create(JSON.parse(options.body), event));
    if (path.startsWith("api/retests")) return Response.json(await retests(path, JSON.parse(options.body)));
    if (path === "api/runs/cleanup" && options.method === "POST") return Response.json(await cleanup(JSON.parse(options.body)));
    if (path === "api/storage/open" && options.method === "POST") return Response.json(await openStorage(options));
    if (path === "api/fingerprint/bank" || path === "api/fingerprint/bank/refresh") return Response.json(await bank(path, options));
    if (/^api\/runs\/[^/]+\/gif$/.test(path) && options.method === "POST") return Response.json(await gifExport(path, options));
    if (/^api\/gifs\/[^/]+\/file$/.test(path)) return new Response(await gifFile(path.split("/")[2]), { headers: { "content-type": "image/gif" } });
    if (/^api\/gifs\/[^/]+\/copy$/.test(path)) return Response.json(await copyGif(path, JSON.parse(options.body)));
    if (/^api\/gifs\/[^/]+\/save$/.test(path)) return Response.json(await saveGif(path));
    if (/^api\/gifs\/[a-f0-9-]+\/delete$/.test(path) && options.method === "POST") return Response.json(await removeGif(path));
    if (path === "api/fingerprint/accounts" || path.startsWith('api/accounts')) return Response.json({ accounts: await accounts() });
    if (path.startsWith("api/favorites") || path.startsWith("api/schedules")) return Response.json(await (favorites ? favorites(path, options.body ? JSON.parse(options.body) : undefined) : bootstrap.favorites));
    if (/^api\/batches\/[^/]+\/export$/.test(path)) return Response.json(await exportBatch(path.split("/")[2]));
    if (path === 'api/batches/export' && options.method === 'POST') return Response.json(await exportBatch(JSON.parse(options.body)));
    if ((/^api\/batches\/[^/]+\/save$/.test(path) || path === 'api/batches/save') && options.method === 'POST') return Response.json(await saveBatch(path, JSON.parse(options.body)));
    if (/^api\/runs\/[^/]+\/open$/.test(path) && options.method === "POST") return Response.json(await open(path.split("/")[2]));
    if (path.startsWith("api/runs/")) return Response.json(await detail(path.split("/")[2]));
    throw new Error("Unexpected UI request: " + path);
  };
  const listeners = {};
  const frames = new Map(); let nextFrame = 0;
  const observed = new Set();
  const intersections = new Map();
  class IntersectionObserver {
    constructor(listener) { this.listener = listener; }
    observe(element) { intersections.set(element, this.listener); }
    unobserve(element) { intersections.delete(element); }
  }
  class ResizeObserver {
    constructor(listener) { this.listener = listener; }
    observe(element) { observed.add(element); }
    unobserve(element) { observed.delete(element); }
    disconnect() { observed.clear(); }
  }
  const copied = [], createdObjectUrls = [], revokedObjectUrls = [];
  const trackedMaps = [], trackedSets = [];
  class TestMap extends Map { constructor(...args) { super(...args); if (trackCollections) trackedMaps.push(this); } }
  class TestSet extends Set { constructor(...args) { super(...args); if (trackCollections) { this.testCreation = new Error().stack; trackedSets.push(this); } } }
  class TestURL extends URL {
    static createObjectURL() { const value = `blob:fixture/${createdObjectUrls.length + 1}`; createdObjectUrls.push(value); return value; }
    static revokeObjectURL(value) { revokedObjectUrls.push(value); }
  }
  const timers = new Map(), intervals = new Map(); let nextTimer = 0;
  const parent = {};
  const location = { search, replace: navigate }, history = { replaceState(_state, _title, url) { location.search = new URL(url, "http://fixture.local/").search; } };
  class TestDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now()])); }
    static now() { return now(); }
  }
  runInNewContext(source, { Date: TestDate, performance: { now: monotonicNow }, crypto: webcrypto, URL: TestURL, Blob, document, fetch, window, parent, history, structuredClone, batchKey, historyBatches, historyTime, recentTestBatches, renderDailyHistory, createBatchRetest, openRetestDrawer, failureInfo, createResultInsights, createSettingsUI, mergeProgress, createRuntimeClock, createRunProgressView, createAccountTargets, createExperimentControls, repeatedResultGroups, createPresetManager, generationTimeoutFromSeconds, createRunNotes, createLabTools, createChangelog, targetLabel, normalizeTarget, readGrade, suiteCatalog, historyMatches, AbortController,
    ...(trackCollections ? { Map: TestMap, Set: TestSet } : {}),
    navigator: { clipboard: { writeText: writeClipboard || (async value => copied.push(value)) } }, location, matchMedia: () => ({ matches: false }), CSS: { supports: () => true },
    URLSearchParams, Response, TextDecoder, ResizeObserver, ...(intersection ? { IntersectionObserver } : {}), innerWidth: viewport.width, innerHeight: viewport.height, setInterval(callback, delay) { intervals.set(callback, delay); }, setTimeout(callback) { timers.set(++nextTimer, callback); return nextTimer; }, clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(listener) { frames.set(++nextFrame, listener); return nextFrame; }, cancelAnimationFrame(id) { frames.delete(id); },
    addEventListener(type, listener) { (listeners[type] ||= []).push(listener); }, console });
  const dispatch = (type, value) => { for (const listener of listeners[type] || []) listener(value); };
  return { elements, document, event, observed, copied, createdObjectUrls, revokedObjectUrls, trackedMaps, trackedSets, parent, location, window, closeStream() { controller.close(); }, timers, runTimer(id) { const callback = timers.get(id); timers.delete(id); callback?.(); }, intersect(element, visible) { intersections.get(element)?.([{ target: element, isIntersecting: visible }]); }, pendingFrames: () => frames.size,
    flushFrames() { const pending = [...frames.values()]; frames.clear(); for (const listener of pending) listener(); },
    dispatch, tickIntervals() { for (const callback of intervals.keys()) callback(); }, message(value) { dispatch("message", value); }, descendants(element, tag) {
    const out = [];
    const visit = (item) => { if (!tag || item.tagName === tag.toUpperCase()) out.push(item); for (const child of item.children) visit(child); };
    visit(element); return out;
  } };
}
