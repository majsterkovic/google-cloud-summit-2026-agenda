const COLORS = {
  hype: "var(--track-hype)",
  hood: "var(--track-hood)",
  decoding: "var(--track-decoding)",
  live: "var(--track-live)",
  security: "var(--track-security)",
  startups: "var(--track-startups)",
};

const PX_MIN = 3.15;
const DAY_START = 8 * 60;
const DAY_END = 17 * 60 + 45;
const KEYS = { plan: "gcs-pl-2026:plan", view: "gcs-pl-2026:view" };

const storage = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* private mode / quota: plan just won't persist */
    }
  },
};

let agenda = null;
let query = "";
let view = "grid";
let current = null;
let toastTimer = 0;
const hidden = new Set();
const plan = new Set();
const index = new Map();
const everywhere = new Set();

const els = {
  meta: document.getElementById("event-meta"),
  chips: document.getElementById("track-chips"),
  search: document.getElementById("search"),
  hideBreaks: document.getElementById("hide-breaks"),
  board: document.getElementById("grid-scroll"),
  schedule: document.getElementById("schedule"),
  drawer: document.getElementById("detail"),
  detailBody: document.getElementById("detail-body"),
  backdrop: document.getElementById("backdrop"),
  close: document.getElementById("drawer-close"),
  drawerPick: document.getElementById("drawer-pick"),
  planCount: document.getElementById("plan-count"),
  toast: document.getElementById("toast"),
  viewButtons: [...document.querySelectorAll(".views__btn")],
};

const minutes = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

const clock = (total) =>
  `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;

const range = (start, end) => (start === end ? start : `${start}–${end}`);
const isBreak = (session) => session.kind === "break" || session.title === "End";
const isEmpty = (session) => session.title === "End" || minutes(session.end) <= minutes(session.start);
const signature = (session) => `${session.start}|${session.end}|${session.title}`;
const visibleTracks = () => agenda.tracks.filter((track) => !hidden.has(track.id));
const overlaps = (a, b) => minutes(a.start) < minutes(b.end) && minutes(b.start) < minutes(a.end);
const selectable = (session) => session.kind !== "break" && !everywhere.has(signature(session));

const isShared = (session, tracks) =>
  tracks.length > 1 &&
  tracks.every((track) => track.sessions.some((item) => signature(item) === signature(session)));

const haystack = (session) =>
  [
    session.title,
    session.description,
    ...(session.speakers || []).flatMap((person) => [person.name, person.title, person.company]),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

const matches = (session) => !query || haystack(session).includes(query);

function text(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = value;
  return node;
}

function speakersLine(session, limit = 2) {
  const people = session.speakers || [];
  if (!people.length) return "";
  const names = people.slice(0, limit).map((person) => person.name);
  const extra = people.length > limit ? ` +${people.length - limit}` : "";
  return names.join(", ") + extra;
}

/* ---------- plan (localStorage) ---------- */

function loadPlan() {
  plan.clear();
  try {
    const saved = JSON.parse(storage.get(KEYS.plan) || "[]");
    for (const id of saved) if (index.has(id)) plan.add(id);
  } catch {
    /* corrupted value: start with an empty plan */
  }
}

const savePlan = () => storage.set(KEYS.plan, JSON.stringify([...plan]));

function planClash(session) {
  for (const id of plan) {
    const other = index.get(id).session;
    if (other.id !== session.id && overlaps(other, session)) return other;
  }
  return null;
}

function togglePlan(id) {
  const entry = index.get(id);
  if (!entry || !selectable(entry.session)) return;
  const { session } = entry;
  if (plan.has(id)) {
    plan.delete(id);
    showToast("Usunięto z planu");
  } else {
    const replaced = [...plan].filter((otherId) => overlaps(index.get(otherId).session, session));
    replaced.forEach((otherId) => plan.delete(otherId));
    plan.add(id);
    showToast(
      replaced.length
        ? `Zastąpiono: ${index.get(replaced[0]).session.title}`
        : `Dodano do planu · ${range(session.start, session.end)}`,
    );
  }
  savePlan();
  render();
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("is-visible"), 2600);
}

function pickButton(session, className = "pick") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  const picked = plan.has(session.id);
  button.setAttribute("aria-pressed", String(picked));
  button.setAttribute("aria-label", picked ? "Usuń z planu" : "Dodaj do planu");
  button.title = picked ? "Usuń z planu" : "Dodaj do planu";
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    togglePlan(session.id);
  });
  return button;
}

/* ---------- drawer ---------- */

function syncDrawerPick() {
  const button = els.drawerPick;
  if (!current || !selectable(current.session)) {
    button.hidden = true;
    return;
  }
  const picked = plan.has(current.session.id);
  const clash = !picked && planClash(current.session);
  button.hidden = false;
  button.setAttribute("aria-pressed", String(picked));
  button.textContent = picked ? "✓ W moim planie" : clash ? "Idę na tę zamiast innej" : "+ Idę na tę prelekcję";
}

function openDetail(session, track, shared) {
  current = { session, track, shared };
  document.querySelectorAll(".is-open-detail").forEach((node) => node.classList.remove("is-open-detail"));
  document
    .querySelectorAll(`[data-id="${CSS.escape(session.id)}"]`)
    .forEach((node) => node.classList.add("is-open-detail"));

  els.detailBody.replaceChildren();
  const label = text("p", "detail__track", shared ? "Wszystkie ścieżki" : track.name);
  label.style.color = shared ? "var(--accent)" : COLORS[track.id];
  els.detailBody.append(
    label,
    text("p", "detail__time", `${range(session.start, session.end)} CET`),
    text("h2", "", session.title),
  );
  const clash = planClash(session);
  if (selectable(session) && clash && !plan.has(session.id)) {
    els.detailBody.append(
      text("p", "detail__clash", `W planie o tej porze: ${clash.title}`),
    );
  }
  if (session.description) els.detailBody.append(text("p", "detail__desc", session.description));
  if (session.speakers?.length) {
    const list = document.createElement("ul");
    list.className = "detail__speakers";
    for (const person of session.speakers) {
      const item = document.createElement("li");
      item.append(text("strong", "", person.name));
      const role = [person.title, person.company].filter(Boolean).join(" · ");
      if (role) item.append(text("span", "", role));
      list.append(item);
    }
    els.detailBody.append(list);
  }

  syncDrawerPick();
  els.drawer.classList.add("is-open");
  els.drawer.setAttribute("aria-hidden", "false");
  els.backdrop.hidden = false;
  els.drawer.scrollTop = 0;
}

function closeDetail() {
  current = null;
  document.querySelectorAll(".is-open-detail").forEach((node) => node.classList.remove("is-open-detail"));
  els.drawer.classList.remove("is-open");
  els.drawer.setAttribute("aria-hidden", "true");
  els.backdrop.hidden = true;
}

/* ---------- controls ---------- */

function renderChips() {
  els.chips.replaceChildren();
  for (const track of agenda.tracks) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chip";
    button.textContent = track.short;
    button.style.setProperty("--chip", COLORS[track.id]);
    button.setAttribute("aria-pressed", hidden.has(track.id) ? "false" : "true");
    button.title = track.name;
    button.addEventListener("click", () => {
      if (hidden.has(track.id)) hidden.delete(track.id);
      else if (hidden.size < agenda.tracks.length - 1) hidden.add(track.id);
      button.setAttribute("aria-pressed", hidden.has(track.id) ? "false" : "true");
      render();
    });
    els.chips.append(button);
  }
}

function setView(next) {
  view = next;
  storage.set(KEYS.view, view);
  render();
  if (view !== "grid") window.scrollTo({ top: 0 });
}

/* ---------- grid view ---------- */

function gridCard(session, track, shared, dim) {
  const start = minutes(session.start);
  const end = minutes(session.end);
  const height = Math.max((end - start) * PX_MIN - 4, 24);
  const wrap = document.createElement("div");
  wrap.className = "session";
  wrap.dataset.id = session.id;
  if (session.kind === "break") wrap.classList.add("session--break");
  if (shared) wrap.classList.add("session--shared");
  if (height < 52) wrap.classList.add("session--short");
  if (dim) wrap.classList.add("session--dim");
  if (plan.has(session.id)) wrap.classList.add("session--picked");
  if (current?.session.id === session.id) wrap.classList.add("is-open-detail");
  wrap.style.top = `${(start - DAY_START) * PX_MIN + 2}px`;
  wrap.style.height = `${height}px`;
  wrap.style.setProperty("--bar", shared ? "var(--accent)" : COLORS[track.id]);

  const main = document.createElement("button");
  main.type = "button";
  main.className = "session__main";
  main.append(text("div", "session__time", range(session.start, session.end)));
  main.append(text("div", "session__title", session.title));
  if (height >= 78 && session.speakers?.length) {
    main.append(text("div", "session__who", speakersLine(session)));
  }
  main.addEventListener("click", () => openDetail(session, track, shared));
  wrap.append(main);

  if (selectable(session)) wrap.append(pickButton(session, "pick pick--dot"));
  return wrap;
}

function renderGrid() {
  const tracks = visibleTracks();
  const hideBreaks = els.hideBreaks.checked;
  const height = (DAY_END - DAY_START) * PX_MIN;
  const { scrollTop, scrollLeft } = els.board;

  els.schedule.replaceChildren();
  els.schedule.style.setProperty("--cols", tracks.length);
  els.schedule.style.setProperty("--px-min", `${PX_MIN}px`);

  const head = document.createElement("div");
  head.className = "schedule__head";
  head.append(text("div", "schedule__head-cell schedule__head-cell--time", "Czas"));
  for (const track of tracks) {
    const cell = text("div", "schedule__head-cell", track.short);
    cell.style.borderLeftColor = COLORS[track.id];
    cell.style.color = COLORS[track.id];
    cell.title = track.name;
    head.append(cell);
  }

  const body = document.createElement("div");
  body.className = "schedule__body";
  body.style.height = `${height}px`;

  const timeCol = document.createElement("div");
  timeCol.className = "schedule__time-col";
  for (let mark = DAY_START; mark <= DAY_END; mark += 30) {
    const label = text("div", "time-label", clock(mark));
    label.style.top = `${(mark - DAY_START) * PX_MIN}px`;
    timeCol.append(label);
  }

  const columns = tracks.map(() => {
    const column = document.createElement("div");
    column.className = "schedule__track-col";
    return column;
  });

  const span = document.createElement("div");
  span.className = "schedule__span";
  const sharedKeys = new Set();

  for (const session of tracks[0].sessions) {
    if (!isShared(session, tracks) || isEmpty(session)) continue;
    if (hideBreaks && isBreak(session)) continue;
    sharedKeys.add(signature(session));
    span.append(gridCard(session, tracks[0], true, false));
  }

  tracks.forEach((track, i) => {
    for (const session of track.sessions) {
      if (isEmpty(session)) continue;
      if (hideBreaks && isBreak(session)) continue;
      if (sharedKeys.has(signature(session))) continue;
      columns[i].append(gridCard(session, track, false, !matches(session)));
    }
  });

  body.append(timeCol, ...columns, span);

  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Warsaw",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  if (agenda.event.date === today) {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Warsaw",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date());
    const now =
      Number(parts.find((part) => part.type === "hour").value) * 60 +
      Number(parts.find((part) => part.type === "minute").value);
    if (now >= DAY_START && now <= DAY_END) {
      const line = document.createElement("div");
      line.className = "now-line";
      line.style.top = `${(now - DAY_START) * PX_MIN}px`;
      line.append(text("span", "", "teraz"));
      body.append(line);
    }
  }

  els.schedule.append(head, body);
  els.board.scrollTop = scrollTop;
  els.board.scrollLeft = scrollLeft;
}

/* ---------- list / plan view ---------- */

function listItem(session, track, shared) {
  const item = document.createElement("li");
  item.className = "item";
  item.dataset.id = session.id;
  item.style.setProperty("--bar", shared ? "var(--accent)" : COLORS[track.id]);
  if (session.kind === "break") item.classList.add("item--break");
  if (plan.has(session.id)) item.classList.add("item--picked");
  if (current?.session.id === session.id) item.classList.add("is-open-detail");

  const main = document.createElement("button");
  main.type = "button";
  main.className = "item__main";
  const meta = document.createElement("div");
  meta.className = "item__meta";
  const tag = text("span", "item__track", shared ? "Wszystkie ścieżki" : track.short);
  tag.style.color = shared ? "var(--accent)" : COLORS[track.id];
  meta.append(tag, text("span", "item__time", range(session.start, session.end)));
  main.append(meta, text("div", "item__title", session.title));
  const who = speakersLine(session, 3);
  if (who) main.append(text("div", "item__who", who));
  const clash = selectable(session) && !plan.has(session.id) && planClash(session);
  if (clash) main.append(text("div", "item__clash", `Zastąpi: ${clash.title}`));
  main.addEventListener("click", () => openDetail(session, track, shared));
  item.append(main);

  if (selectable(session)) {
    const pick = pickButton(session, "pick pick--label");
    pick.textContent = plan.has(session.id) ? "✓ Idę" : "+ Idę";
    item.append(pick);
  }
  return item;
}

function renderList(planOnly) {
  const tracks = planOnly ? agenda.tracks : visibleTracks();
  const hideBreaks = els.hideBreaks.checked && !planOnly;
  const entries = [];
  const seen = new Set();

  tracks.forEach((track, order) => {
    for (const session of track.sessions) {
      if (isEmpty(session)) continue;
      if (hideBreaks && isBreak(session)) continue;
      const shared = !planOnly && isShared(session, tracks);
      if (shared) {
        if (seen.has(signature(session))) continue;
        seen.add(signature(session));
      }
      if (planOnly && !plan.has(session.id)) continue;
      if (!planOnly && !matches(session)) continue;
      entries.push({ session, track, shared, order });
    }
  });

  entries.sort(
    (a, b) =>
      minutes(a.session.start) - minutes(b.session.start) ||
      minutes(a.session.end) - minutes(b.session.end) ||
      a.order - b.order,
  );

  els.schedule.replaceChildren();
  const root = document.createElement("div");
  root.className = "list";

  if (planOnly) {
    const bar = document.createElement("div");
    bar.className = "plan-bar";
    bar.append(
      text("p", "plan-bar__text", plan.size ? `Wybrane prelekcje: ${plan.size}` : "Twój plan jest pusty"),
    );
    if (plan.size) {
      const clear = text("button", "plan-bar__clear", "Wyczyść plan");
      clear.type = "button";
      clear.addEventListener("click", () => {
        if (!confirm("Usunąć wszystkie wybrane prelekcje?")) return;
        plan.clear();
        savePlan();
        render();
      });
      bar.append(clear);
    }
    root.append(bar);
  }

  if (!entries.length) {
    root.append(
      text(
        "p",
        "empty",
        planOnly
          ? "Dodaj prelekcje przyciskiem „+ Idę” w widoku Siatka lub Lista. Na każdą godzinę zostaje jedna."
          : "Brak sesji pasujących do filtrów.",
      ),
    );
    els.schedule.append(root);
    return;
  }

  let group = null;
  let groupStart = "";
  for (const entry of entries) {
    if (entry.session.start !== groupStart) {
      groupStart = entry.session.start;
      group = document.createElement("section");
      group.className = "slot";
      group.append(text("h3", "slot__time", groupStart));
      const list = document.createElement("ul");
      list.className = "slot__items";
      group.append(list);
      root.append(group);
    }
    group.querySelector("ul").append(listItem(entry.session, entry.track, entry.shared));
  }
  els.schedule.append(root);
}

/* ---------- render ---------- */

function render() {
  document.body.dataset.view = view;
  els.board.classList.toggle("board--list", view !== "grid");
  els.planCount.textContent = String(plan.size);
  for (const button of els.viewButtons) {
    button.setAttribute("aria-selected", String(button.dataset.view === view));
  }
  if (view === "grid") renderGrid();
  else renderList(view === "plan");
  syncDrawerPick();
}

async function init() {
  const response = await fetch("./agenda.json");
  if (!response.ok) throw new Error("Nie udało się wczytać agenda.json");
  agenda = await response.json();

  const counts = new Map();
  for (const track of agenda.tracks) {
    for (const session of track.sessions) {
      index.set(session.id, { session, track });
      counts.set(signature(session), (counts.get(signature(session)) || 0) + 1);
    }
  }
  for (const [key, count] of counts) if (count === agenda.tracks.length) everywhere.add(key);

  loadPlan();
  const savedView = storage.get(KEYS.view);
  view = ["grid", "list", "plan"].includes(savedView)
    ? savedView
    : window.matchMedia("(max-width: 760px)").matches
      ? "list"
      : "grid";

  const { event } = agenda;
  els.meta.textContent = `${event.venue}, ${event.city} · ${event.dateLabel} · ${event.start}–${event.end}`;
  renderChips();
  render();

  els.search.addEventListener("input", () => {
    query = els.search.value.trim().toLowerCase();
    render();
  });
  els.hideBreaks.addEventListener("change", render);
  els.viewButtons.forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
  els.drawerPick.addEventListener("click", () => {
    if (!current) return;
    togglePlan(current.session.id);
    openDetail(current.session, current.track, current.shared);
  });
  els.close.addEventListener("click", closeDetail);
  els.backdrop.addEventListener("click", closeDetail);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeDetail();
  });
  window.addEventListener("storage", (event) => {
    if (event.key !== KEYS.plan) return;
    loadPlan();
    render();
  });
}

init().catch((error) => {
  els.schedule.append(text("p", "empty", error.message));
});
