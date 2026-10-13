"use client";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ArrowUpRight,
  ArrowRight,
  Search,
  Plus,
  Bookmark,
  GraduationCap,
  LayoutGrid,
  Store,
  BriefcaseBusiness,
  ChevronDown,
  Check,
  CheckCheck,
  Clock,
  MapPin,
  Users,
  Code2,
  FlaskConical,
  Palette,
  BookOpen,
  ShieldCheck,
  LogOut,
  X,
  Mail,
  Package,
  CheckCircle2,
  Send,
  ShoppingBag,
  SlidersHorizontal,
  ExternalLink,
  Lightbulb,
  ArrowLeft,
  LoaderCircle,
} from "lucide-react";

type Member = {
  id: string;
  name: string;
  school: string;
  role: string;
  color: string;
  email?: string;
  saved?: string[];
};
type Application = { userId: string; note: string; createdAt: number };
type Submission = {
  id: string;
  userId: string;
  note: string;
  url: string;
  createdAt: number;
};
type Message = { id: string; userId: string; body: string; createdAt: number };
type Task = {
  id: string;
  ownerId: string;
  title: string;
  category: string;
  reward: number;
  tags: string[];
  description: string;
  requirements: string[];
  durationDays: number;
  status: string;
  assigneeId: string | null;
  applicationCount: number;
  applications: Application[];
  submissions: Submission[];
  messages: Message[];
  createdAt: number;
};
type Product = {
  id: string;
  ownerId: string;
  title: string;
  description: string;
  price: number;
  category: string;
  productType: string;
  delivery: string;
  art: string;
  tags: string[];
  status: string;
  createdAt: number;
};
type Order = {
  id: string;
  productId: string;
  title: string;
  price: number;
  buyerId: string;
  sellerId: string;
  status: string;
  note: string;
};
type Data = {
  preview?: boolean;
  user: Member | null;
  users: Member[];
  tasks: Task[];
  products: Product[];
  orders: Order[];
};
type Modal = {
  kind: "login" | "publish" | "task" | "product" | "rules" | "order";
  id?: string;
} | null;
type View = "tasks" | "market" | "workspace" | "saved";
const empty: Data = {
  user: null,
  users: [],
  tasks: [],
  products: [],
  orders: [],
};
const money = (amount: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: amount % 100 ? 2 : 0,
  }).format(amount / 100);
const statusName: Record<string, string> = {
  open: "Open for applications",
  invited: "Awaiting acceptance",
  active: "In progress",
  review: "Awaiting review",
  completed: "Completed",
  cancelled: "Cancelled",
  available: "Available",
  reserved: "Reserved",
  delivered: "Awaiting receipt",
  sold: "Sold",
};
const taskCategories = [
  "All bounties",
  "Research",
  "Development",
  "Design",
  "Research support",
];
const productCategories = ["All items", "Pre-owned", "Digital goods", "Books"];
const icons: Record<string, typeof Code2> = {
  Research: FlaskConical,
  Development: Code2,
  Design: Palette,
  "Research support": BookOpen,
};
async function api(path: string, body?: Record<string, unknown>) {
  const response = await fetch("/api/" + path, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || "Request failed. Please try again.");
  return data;
}

function Dialog({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      queueMicrotask(() => {
        if (previous?.isConnected) previous.focus();
      });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={"dialog " + (wide ? "wide" : "")}
      aria-label={title}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog-inner">
        <header className="dialog-head">
          <span>{title}</span>
          <button
            className="icon-button"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}
function Avatar({
  person,
  small = false,
}: {
  person?: Member;
  small?: boolean;
}) {
  return (
    <span
      className={`avatar ${person?.color || "blue"} ${small ? "small" : ""}`}
      aria-hidden="true"
    >
      {person?.name?.slice(0, 1) || "C"}
    </span>
  );
}
function Art({ type }: { type: string }) {
  return (
    <div className={"product-art " + type} aria-hidden="true">
      {type === "bike" ? (
        <svg viewBox="0 0 320 200">
          <circle cx="82" cy="139" r="39" />
          <circle cx="239" cy="139" r="39" />
          <path d="m82 139 44-76 41 76H82l38-57h101l18 57m-72 0 54-57-12-34h25M113 63h29" />
          <circle cx="167" cy="139" r="6" />
        </svg>
      ) : type === "book" ? (
        <div className="book-cover">
          <span>Thomas H. Cormen</span>
          <strong>
            Introduction
            <br />
            to Algorithms
          </strong>
          <div className="book-lines" />
          <span>Fourth edition</span>
        </div>
      ) : type === "template" ? (
        <div className="template-preview">
          <div className="template-top">
            My research space <span>✦</span>
          </div>
          <div className="template-body">
            <strong>
              Make room
              <br />
              for better ideas.
            </strong>
            <div>
              <i />
              <i />
              <i />
            </div>
            <p>Reading list &nbsp; / &nbsp; This week</p>
          </div>
        </div>
      ) : type === "code" ? (
        <div className="code-preview">
          <span>
            <i />
            <i />
            <i /> <b>clean_data.py</b>
          </span>
          <p>
            <em>import</em> pandas as pd
          </p>
          <p>
            data = <em>read_csv</em>(source)
          </p>
          <p>
            <em>clean</em>(data).to_csv()
          </p>
          <div>Ready for your next project.</div>
        </div>
      ) : (
        <Package size={80} strokeWidth={1} />
      )}
    </div>
  );
}

function Field({
  label,
  name,
  placeholder,
  required = true,
  area = false,
  ...rest
}: {
  label: string;
  name: string;
  placeholder?: string;
  required?: boolean;
  area?: boolean;
  [key: string]: unknown;
}) {
  return (
    <label className="field">
      <span>
        {label}
        {required && <b aria-hidden="true"> *</b>}
      </span>
      {area ? (
        <textarea
          name={name}
          placeholder={placeholder}
          required={required}
          rows={4}
          {...rest}
        />
      ) : (
        <input
          name={name}
          placeholder={placeholder}
          required={required}
          {...rest}
        />
      )}
    </label>
  );
}
function NoteForm({
  action,
  id,
  button,
  label = "Additional details",
  url = false,
  run,
  busy,
}: {
  action: string;
  id: string;
  button: string;
  label?: string;
  url?: boolean;
  run: (
    action: string,
    body: Record<string, unknown>,
    message: string,
  ) => Promise<unknown>;
  busy: boolean;
}) {
  return (
    <form
      className="note-form"
      onSubmit={async (e) => {
        e.preventDefault();
        const values = Object.fromEntries(new FormData(e.currentTarget));
        await run(
          action,
          { id, ...values },
          "Done. Your update has been saved.",
        );
      }}
    >
      <Field
        label={label}
        name="note"
        area
        minLength={5}
        maxLength={4000}
        placeholder="Describe your plan, deliverables, or anything your collaborator should know."
      />
      {url && (
        <Field
          label="Deliverable link (HTTPS)"
          name="url"
          type="url"
          required={false}
          placeholder="https://…"
        />
      )}
      <button className="button primary" disabled={busy}>
        {busy ? (
          <LoaderCircle size={16} className="spin" />
        ) : (
          <Send size={16} />
        )}{" "}
        {button}
      </button>
    </form>
  );
}

type CardActions = {
  person: (id: string) => Member | undefined;
  me: Member | null;
  open: (kind: NonNullable<Modal>["kind"], id?: string) => void;
  requireLogin: (action: () => void) => void;
  act: (
    action: string,
    body: Record<string, unknown>,
    message: string,
  ) => Promise<unknown>;
};

function TaskCard({ item, actions }: { item: Task; actions: CardActions }) {
  const { person, me, open, requireLogin, act } = actions;
  const owner = person(item.ownerId),
    Icon = icons[item.category] || BookOpen;
  return (
    <article className="task-card">
      <div
        className={
          "task-symbol symbol-" + taskCategories.indexOf(item.category)
        }
      >
        <Icon size={26} strokeWidth={1.6} />
      </div>
      <div className="task-content">
        <div className="task-category">
          <span>{item.category}</span>
          <span className={"status " + item.status}>
            <i />
            {statusName[item.status]}
          </span>
        </div>
        <h3>
          <button onClick={() => open("task", item.id)}>{item.title}</button>
        </h3>
        <p className="task-summary">{item.description}</p>
        <div className="tags">
          {item.tags.map((t) => (
            <span key={t}>{t}</span>
          ))}
        </div>
        <div className="task-meta">
          <Avatar person={owner} small />
          <span>{owner?.name}</span>
          <span className="meta-divider" />
          <span>{owner?.school}</span>
          <span className="meta-time">
            <Clock size={13} />
            {item.durationDays} days to deliver
          </span>
        </div>
      </div>
      <div className="reward">
        <button
          className={
            "icon-button save " + (me?.saved?.includes(item.id) ? "saved" : "")
          }
          aria-label={
            (me?.saved?.includes(item.id) ? "Unsave " : "Save ") + item.title
          }
          onClick={() =>
            requireLogin(() => {
              void act("save", { id: item.id }, "Saved items updated");
            })
          }
        >
          <Bookmark
            size={19}
            fill={me?.saved?.includes(item.id) ? "currentColor" : "none"}
          />
        </button>
        <span>Bounty reward</span>
        <strong>{money(item.reward)}</strong>
        <small>USD</small>
        <button className="details-link" onClick={() => open("task", item.id)}>
          View bounty <ArrowUpRight size={16} />
        </button>
      </div>
    </article>
  );
}
function ProductCard({
  item,
  actions,
}: {
  item: Product;
  actions: CardActions;
}) {
  const { person, open } = actions;
  return (
    <article className="product-card">
      <button
        className="art-button"
        onClick={() => open("product", item.id)}
        aria-label={"View " + item.title}
      >
        <Art type={item.art} />
        <span className="product-kind">
          {item.productType === "digital" ? "Digital goods" : "Physical item"}
        </span>
        {item.status !== "available" && (
          <span className="unavailable">{statusName[item.status]}</span>
        )}
      </button>
      <div className="product-card-body">
        <span className="muted small-text">{item.category}</span>
        <h3>
          <button onClick={() => open("product", item.id)}>{item.title}</button>
        </h3>
        <div className="product-bottom">
          <strong>{money(item.price)}</strong>
          <span>
            <MapPin size={12} />
            {person(item.ownerId)?.school}
          </span>
        </div>
      </div>
    </article>
  );
}

export default function Campus() {
  const [data, setData] = useState<Data>(empty),
    [view, setView] = useState<View>("tasks"),
    [modal, setModal] = useState<Modal>(null),
    [query, setQuery] = useState(""),
    [category, setCategory] = useState("All bounties"),
    [school, setSchool] = useState("All campuses"),
    [sort, setSort] = useState("recent"),
    [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [workspaceTab, setWorkspaceTab] = useState("My bounties");
  const [publishKind, setPublishKind] = useState("task"),
    [authStep, setAuthStep] = useState<{
      challengeId: string;
      demoCode: string;
    } | null>(null);
  const main = useRef<HTMLElement>(null);
  async function refresh() {
    try {
      setData(await api("state"));
      setLoaded(true);
    } catch (e) {
      setError((e as Error).message);
      setLoaded(true);
    }
  }
  useEffect(() => {
    refresh();
  }, []);
  const person = (id: string) => data.users.find((u) => u.id === id);
  const me = data.user;
  function open(kind: NonNullable<Modal>["kind"], id?: string) {
    setError("");
    setAuthStep(null);
    setModal({ kind, id });
  }
  function close() {
    setModal(null);
    setError("");
  }
  function navigate(next: View) {
    setView(next);
    setCategory(next === "market" ? "All items" : "All bounties");
    setQuery("");
    setError("");
    document.title =
      {
        tasks: "Bounties",
        market: "Marketplace",
        workspace: "My workspace",
        saved: "Saved",
      }[next] + " · Campus Bounty";
    setTimeout(() => main.current?.focus(), 0);
  }
  function requireLogin(action: () => void) {
    if (!me) open("login");
    else action();
  }
  async function act(
    action: string,
    body: Record<string, unknown> = {},
    message = "Saved",
  ) {
    setBusy(true);
    setError("");
    try {
      const result = await api("action", { action, ...body });
      await refresh();
      setNotice(message);
      return result;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }
  async function quick(id: string) {
    setBusy(true);
    setError("");
    try {
      await api("auth", { action: "quick", id });
      await refresh();
      close();
      setNotice("Demo account ready. Try the complete workflow.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    setBusy(true);
    try {
      await api("auth", { action: "logout" });
      await refresh();
      navigate("tasks");
      setNotice("Signed out");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const task = data.tasks.find((t) => t.id === modal?.id),
    product = data.products.find((p) => p.id === modal?.id),
    order = data.orders.find((o) => o.id === modal?.id);
  function matches(item: Task | Product) {
    return (
      (category.startsWith("All") || category === item.category) &&
      (school === "All campuses" || person(item.ownerId)?.school === school) &&
      [item.title, item.description, ...item.tags]
        .join(" ")
        .toLowerCase()
        .includes(query.toLowerCase())
    );
  }
  const tasks = data.tasks
    .filter(matches)
    .sort((a, b) =>
      sort === "amount" ? b.reward - a.reward : b.createdAt - a.createdAt,
    );
  const products = data.products
    .filter(matches)
    .sort((a, b) =>
      sort === "amount" ? b.price - a.price : b.createdAt - a.createdAt,
    );
  const myTasks = data.tasks.filter(
    (t) =>
      t.ownerId === me?.id || t.applications.some((a) => a.userId === me?.id),
  );
  const nav = [
    { id: "tasks" as View, label: "Bounties", icon: LayoutGrid },
    { id: "market" as View, label: "Marketplace", icon: Store },
    { id: "workspace" as View, label: "My workspace", icon: BriefcaseBusiness },
    { id: "saved" as View, label: "Saved", icon: Bookmark },
  ];
  const showPublish = () =>
    requireLogin(() => {
      setPublishKind(view === "market" ? "product" : "task");
      open("publish");
    });

  const cardActions = { person, me, open, requireLogin, act };
  function Empty({ title, body }: { title: string; body: string }) {
    return (
      <div className="empty">
        <Search size={34} />
        <h3>{title}</h3>
        <p>{body}</p>
      </div>
    );
  }

  return (
    <>
      <a className="skip" href="#main">
        Skip to main content
      </a>
      <div className="demo-strip">
        <span>
          <span className="demo-dot" />{" "}
          {data.preview ? "Cloud preview" : "Local demo"}
        </span>
        <span>
          Fictional profiles and listings. No real emails or payments.
        </span>
      </div>
      <header className="topbar">
        <a className="brand" href="/" aria-label="Campus Bounty home">
          <span className="brand-mark">
            <GraduationCap size={25} />
          </span>
          <span>
            Campus Bounty<small>U.S. university community</small>
          </span>
        </a>
        <div className="header-links">
          <button
            className={view === "tasks" ? "active" : ""}
            onClick={() => navigate("tasks")}
          >
            Find bounties
          </button>
          <button
            className={view === "market" ? "active" : ""}
            onClick={() => navigate("market")}
          >
            Browse market
          </button>
        </div>
        <div className="header-actions">
          <span className="members-only">
            <ShieldCheck size={15} /> University email access
          </span>
          <button className="button primary publish-top" onClick={showPublish}>
            <Plus size={17} />
            Post
          </button>
          {me ? (
            <button
              className="profile-button"
              onClick={() => open("login")}
              title="Switch demo account"
            >
              <Avatar person={me} small />
              <span>{me.name}</span>
              <ChevronDown size={14} />
            </button>
          ) : (
            <button className="button outline" onClick={() => open("login")}>
              Sign in
            </button>
          )}
        </div>
      </header>
      <div className="app-layout">
        <aside className="sidebar">
          <div className="sidebar-label">Your campus, more possibilities</div>
          <nav aria-label="Main navigation">
            {nav.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => navigate(id)}
                aria-current={view === id ? "page" : undefined}
                className={view === id ? "selected" : ""}
              >
                <Icon size={19} />
                <span>{label}</span>
                {id === "workspace" && myTasks.length > 0 && (
                  <small>{myTasks.length}</small>
                )}
              </button>
            ))}
          </nav>
          <div className="sidebar-note">
            <GraduationCap size={22} />
            <strong>
              Meet on campus.
              <br />
              Connect through skills.
            </strong>
            <p>Turn a small idea into your next collaboration.</p>
          </div>
          <div className="sidebar-bottom">
            <button onClick={() => open("rules")}>
              <ShieldCheck size={16} />
              Community & transactions
            </button>
            <span>Made for campus connections.</span>
          </div>
        </aside>
        <main id="main" ref={main} tabIndex={-1} className="main-content">
          <div className="page-path">
            Campus community <span>/</span>{" "}
            {nav.find((n) => n.id === view)?.label}
            <span className="page-path-right">
              <span className="live-dot" /> Start with a small collaboration
            </span>
          </div>
          {view === "tasks" && (
            <section className="hero">
              <div className="hero-copy">
                <span className="hero-label">
                  <span /> Ideas meet people who make them happen
                </span>
                <h1>
                  Your campus has ideas.
                  <br />
                  Bring them to life.
                </h1>
                <p>
                  Post a bounty. Find the right student.
                  <br />
                  Take on a project. Put your skills to work.
                </p>
                <button className="button hero-button" onClick={showPublish}>
                  Post your first bounty <ArrowUpRight size={17} />
                </button>
              </div>
              <div className="hero-art" aria-hidden="true">
                <div className="orbit orbit-one" />
                <div className="orbit orbit-two" />
                <div className="spark spark-one">✦</div>
                <div className="spark spark-two">✧</div>
                <div className="floating-card card-back">
                  <span className="mini-icon">
                    <Palette size={21} />
                  </span>
                  <span>A campus idea needs your eye</span>
                  <strong>
                    $180<small>Design</small>
                  </strong>
                </div>
                <div className="floating-card card-front">
                  <div>
                    <span className="mini-icon">
                      <FlaskConical size={23} />
                    </span>
                    <span className="mini-status">Open for applications</span>
                  </div>
                  <p>
                    Move research
                    <br />
                    one step forward.
                  </p>
                  <div className="mini-tags">
                    <span>Python</span>
                    <span>Data analysis</span>
                  </div>
                  <div className="ticket-bottom">
                    <span>Research</span>
                    <strong>$350</strong>
                  </div>
                </div>
                <span className="hero-sticker">
                  <Check size={17} /> Make it happen
                </span>
              </div>
            </section>
          )}
          {view === "market" && (
            <section className="market-hero">
              <div>
                <span className="hero-label">
                  Good things deserve a second chapter
                </span>
                <h1>Made to create. Meant to share.</h1>
                <p>Pre-owned finds, textbooks, and tools made by your peers.</p>
              </div>
              <div className="market-hero-icon">
                <ShoppingBag size={70} strokeWidth={1} />
              </div>
            </section>
          )}
          {(view === "tasks" || view === "market") && (
            <>
              <div className="section-heading">
                <div>
                  <h2>
                    {view === "tasks"
                      ? "Find your next bounty"
                      : "Explore the campus market"}
                  </h2>
                  <p>
                    {view === "tasks"
                      ? "Research, code, or design. Put what you know to work."
                      : "Find a new home for your things and an audience for your work."}
                  </p>
                </div>
                <span className="count-pill">
                  {view === "tasks"
                    ? `${tasks.length} ${tasks.length === 1 ? "bounty" : "bounties"}`
                    : `${products.length} ${products.length === 1 ? "item" : "items"}`}
                </span>
              </div>
              <div className="browse-layout">
                <div className="feed">
                  <div className="filters">
                    <div className="search-box">
                      <Search size={18} />
                      <input
                        aria-label="Search bounties or items"
                        placeholder={
                          view === "tasks"
                            ? "Search tasks, skills, or keywords…"
                            : "Search items, tools, or books…"
                        }
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                      />
                      {query && (
                        <button
                          aria-label="Clear search"
                          className="icon-button"
                          onClick={() => setQuery("")}
                        >
                          <X size={14} />
                        </button>
                      )}
                    </div>
                    <label className="select-wrap">
                      <MapPin size={14} />
                      <select
                        aria-label="Filter by campus"
                        value={school}
                        onChange={(e) => setSchool(e.target.value)}
                      >
                        {[
                          "All campuses",
                          "UC Berkeley",
                          "Stanford",
                          "MIT",
                          "UCLA",
                          "Harvard",
                          "Columbia",
                        ].map((s) => (
                          <option key={s}>{s}</option>
                        ))}
                      </select>
                      <ChevronDown size={13} />
                    </label>
                  </div>
                  <div className="category-row">
                    {(view === "tasks"
                      ? taskCategories
                      : productCategories
                    ).map((c) => (
                      <button
                        aria-pressed={category === c}
                        className={category === c ? "active" : ""}
                        key={c}
                        onClick={() => setCategory(c)}
                      >
                        {c}
                      </button>
                    ))}
                  </div>
                  <div className="feed-caption">
                    <span>
                      {me ? "Posted by members" : "Featured demo listings"}
                      <span className="muted">
                        {" "}
                        ·{" "}
                        {view === "tasks"
                          ? "Rewards in USD"
                          : "Physical and digital goods"}
                      </span>
                    </span>
                    <label>
                      <SlidersHorizontal size={13} />
                      <select
                        aria-label="Sort by"
                        value={sort}
                        onChange={(e) => setSort(e.target.value)}
                      >
                        <option value="recent">Newest first</option>
                        <option value="amount">Price: high to low</option>
                      </select>
                    </label>
                  </div>
                  {!loaded ? (
                    <div className="empty">
                      <LoaderCircle className="spin" />
                      Loading campus opportunities…
                    </div>
                  ) : view === "tasks" ? (
                    <div className="task-list">
                      {tasks.map((t) => (
                        <TaskCard actions={cardActions} key={t.id} item={t} />
                      ))}
                      {!tasks.length && (
                        <Empty
                          title="No matching bounties"
                          body="Try another keyword or campus, or post your own bounty."
                        />
                      )}
                    </div>
                  ) : (
                    <div className="product-grid">
                      {products.map((p) => (
                        <ProductCard
                          actions={cardActions}
                          key={p.id}
                          item={p}
                        />
                      ))}
                      {!products.length && (
                        <Empty
                          title="No matching items"
                          body="Try another keyword or explore a different category."
                        />
                      )}
                    </div>
                  )}
                </div>
                <aside className="right-rail">
                  <div className="post-card">
                    <span className="post-icon">
                      <Lightbulb size={25} />
                    </span>
                    <h3>
                      {view === "market"
                        ? "Something to share?"
                        : "Have an idea?"}
                      <br />
                      {view === "market"
                        ? "Give it a new home."
                        : "Find a helping hand."}
                    </h3>
                    <p>
                      {view === "market"
                        ? "Make room for what comes next."
                        : "Tell your campus what you need."}
                      <br />
                      {view === "market"
                        ? "Add the condition, price, and delivery details."
                        : "Define the task, reward, and deliverables."}
                    </p>
                    <button className="button primary" onClick={showPublish}>
                      Post {view === "market" ? "item" : "bounty"}{" "}
                      <Plus size={16} />
                    </button>
                  </div>
                  <div className="how-card">
                    <h3>
                      {view === "market"
                        ? "Four steps to a new home"
                        : "Four steps to collaborate"}
                    </h3>
                    {(view === "market"
                      ? [
                          "List your item and price",
                          "A member places an order",
                          "The seller delivers",
                          "The buyer confirms receipt",
                        ]
                      : [
                          "Post your task and reward",
                          "Find the right student",
                          "Complete and deliver the work",
                          "Review and confirm completion",
                        ]
                    ).map((s, i) => (
                      <div key={s}>
                        <span>{i + 1}</span>
                        <p>{s}</p>
                      </div>
                    ))}
                    <button
                      className="text-button"
                      onClick={() => open("rules")}
                    >
                      How it works <ArrowUpRight size={14} />
                    </button>
                  </div>
                  <div className="community-note">
                    <ShieldCheck size={20} />
                    <div>
                      <strong>Built on campus trust</strong>
                      <p>
                        Set clear expectations. Respect original work and
                        academic integrity.
                      </p>
                    </div>
                  </div>
                </aside>
              </div>
            </>
          )}
          {view === "workspace" && (
            <>
              <div className="workspace-title">
                <div>
                  <span className="muted">
                    All your collaborations, in one place
                  </span>
                  <h1>My workspace</h1>
                </div>
                <button className="button primary" onClick={showPublish}>
                  <Plus size={16} />
                  Create a post
                </button>
              </div>
              {!me ? (
                <div className="login-empty">
                  <GraduationCap size={46} />
                  <h2>Your next collaboration starts here</h2>
                  <p>
                    Sign in to manage applications, deliverables, and orders.
                  </p>
                  <button
                    className="button primary"
                    onClick={() => open("login")}
                  >
                    Sign in
                  </button>
                </div>
              ) : (
                <>
                  <div className="workspace-stats">
                    <div>
                      <span>My bounties</span>
                      <strong>{myTasks.length}</strong>
                    </div>
                    <div>
                      <span>Needs my attention</span>
                      <strong>
                        {
                          myTasks.filter(
                            (t) =>
                              (t.ownerId === me.id && t.status === "review") ||
                              (t.assigneeId === me.id &&
                                ["invited", "active"].includes(t.status)),
                          ).length
                        }
                      </strong>
                    </div>
                    <div>
                      <span>Orders</span>
                      <strong>{data.orders.length}</strong>
                    </div>
                  </div>
                  <div className="category-row workspace-tabs">
                    {["My bounties", "My listings", "Orders"].map((t) => (
                      <button
                        key={t}
                        className={workspaceTab === t ? "active" : ""}
                        onClick={() => setWorkspaceTab(t)}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                  {workspaceTab === "My bounties" ? (
                    <div className="task-list">
                      {myTasks.map((t) => (
                        <TaskCard actions={cardActions} key={t.id} item={t} />
                      ))}
                      {!myTasks.length && (
                        <Empty
                          title="Your first collaboration starts here"
                          body="Explore bounties that interest you, or post your own."
                        />
                      )}
                    </div>
                  ) : workspaceTab === "My listings" ? (
                    <div className="product-grid">
                      {data.products
                        .filter((p) => p.ownerId === me.id)
                        .map((p) => (
                          <ProductCard
                            actions={cardActions}
                            key={p.id}
                            item={p}
                          />
                        ))}
                      {!data.products.some((p) => p.ownerId === me.id) && (
                        <Empty
                          title="No listings yet"
                          body="List a pre-owned item or a digital creation in the market."
                        />
                      )}
                    </div>
                  ) : (
                    <div className="order-list">
                      {data.orders.map((o) => (
                        <button
                          className="order-row"
                          key={o.id}
                          onClick={() => open("order", o.id)}
                        >
                          <span className="order-icon">
                            <Package size={24} />
                          </span>
                          <span>
                            <strong>{o.title}</strong>
                            <small>
                              {o.buyerId === me.id ? "Purchased" : "Sold by me"}{" "}
                              · {statusName[o.status]}
                            </small>
                          </span>
                          <b>{money(o.price)}</b>
                          <ArrowUpRight size={18} />
                        </button>
                      ))}
                      {!data.orders.length && (
                        <Empty
                          title="Your orders will appear here"
                          body="Explore the market or list your first item."
                        />
                      )}
                    </div>
                  )}
                </>
              )}
            </>
          )}
          {view === "saved" && (
            <>
              <div className="workspace-title">
                <div>
                  <span className="muted">
                    Keep the opportunities you like close by
                  </span>
                  <h1>Saved</h1>
                </div>
              </div>
              <div className="task-list">
                {data.tasks
                  .filter((t) => me?.saved?.includes(t.id))
                  .map((t) => (
                    <TaskCard actions={cardActions} key={t.id} item={t} />
                  ))}
                {!me?.saved?.length && (
                  <Empty
                    title="No saved bounties yet"
                    body="Select the bookmark on a bounty to find it here later."
                  />
                )}
              </div>
            </>
          )}
          {error && !modal && (
            <div className="form-error" role="alert">
              {error}
              <button className="text-button" onClick={refresh}>
                Reload
              </button>
            </div>
          )}
          <footer className="content-footer">
            <span>Campus Bounty · U.S. university community</span>
            <button onClick={() => open("rules")}>
              Community rules & demo details
            </button>
          </footer>
        </main>
      </div>
      <nav className="mobile-nav" aria-label="Mobile navigation">
        {nav.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => navigate(id)}
            className={view === id ? "active" : ""}
            aria-current={view === id ? "page" : undefined}
          >
            <Icon size={20} />
            <span>{id === "workspace" ? "Workspace" : label}</span>
          </button>
        ))}
      </nav>
      <div className={"toast " + (notice ? "visible" : "")} role="status">
        {notice && (
          <>
            <CheckCircle2 size={17} />
            <span>{notice}</span>
            <button
              aria-label="Dismiss notification"
              onClick={() => setNotice("")}
            >
              <X size={15} />
            </button>
          </>
        )}
      </div>

      {modal?.kind === "login" && (
        <Dialog
          title={me ? "Your campus account" : "Welcome to Campus Bounty"}
          onClose={close}
        >
          <div className="auth-intro">
            <span className="auth-symbol">
              <GraduationCap size={32} />
            </span>
            <h2>
              {me
                ? "Hello, " + me.name
                : "Your campus. Your next collaboration."}
            </h2>
            <p>
              {me
                ? `${me.school} · ${me.email}`
                : "Use your U.S. university email to join the community."}
            </p>
          </div>
          <div className="demo-info">
            {data.preview
              ? "Private preview: switch accounts here to try both sides in your own workspace. Demo data expires after 7 days of inactivity. No real emails or payments."
              : "Demo only: no email is sent or ownership verified."}
          </div>
          {me && (
            <button
              className="button outline full"
              disabled={busy}
              onClick={async () => {
                await logout();
                close();
              }}
            >
              <LogOut size={16} />
              Sign out
            </button>
          )}
          <div className="quick-accounts">
            <span className="field-label">Try a demo account</span>
            <div>
              {[
                { id: "student", name: "Jamie Lin", role: "Apply & buy" },
                {
                  id: "professor",
                  name: "Professor Chen",
                  role: "Post research tasks",
                },
                { id: "maker", name: "Taylor Zhou", role: "Post & sell" },
              ].map((a) => (
                <button key={a.id} disabled={busy} onClick={() => quick(a.id)}>
                  <Avatar
                    person={data.users.find((u) => u.id === a.id)}
                    small
                  />
                  <strong>{a.name}</strong>
                  <small>{a.role}</small>
                </button>
              ))}
            </div>
          </div>
          <div className="or-line">
            <span>Or try university email verification</span>
          </div>
          <form
            onSubmit={async (e: FormEvent<HTMLFormElement>) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              setBusy(true);
              setError("");
              try {
                if (authStep) {
                  await api("auth", {
                    action: "verify",
                    challengeId: authStep.challengeId,
                    code: f.get("code"),
                  });
                  await refresh();
                  close();
                  setNotice("Demo email verification complete");
                } else {
                  setAuthStep(
                    await api("auth", {
                      action: "request",
                      email: f.get("email"),
                    }),
                  );
                }
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {!authStep ? (
              <Field
                label="U.S. university email"
                name="email"
                type="email"
                autoComplete="email"
                placeholder="you@berkeley.edu"
              />
            ) : (
              <>
                <div className="demo-code">
                  Demo verification code: <strong>{authStep.demoCode}</strong>
                  <span>Expires in 5 minutes. No email was sent.</span>
                </div>
                <Field
                  label="Enter demo code"
                  name="code"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  autoComplete="one-time-code"
                  placeholder="6-digit code"
                />
              </>
            )}
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <button className="button primary full" disabled={busy}>
              <Mail size={16} />
              {busy
                ? "Working…"
                : authStep
                  ? "Verify & sign in"
                  : "Get demo code"}
            </button>
          </form>
          <p className="auth-footnote">
            Demo domains: Berkeley, Stanford, MIT, UCLA, Harvard, and Columbia.
            Full institution review and email delivery are not connected yet.
          </p>
        </Dialog>
      )}
      {modal?.kind === "publish" && (
        <Dialog
          title="Share an opportunity with your campus"
          onClose={close}
          wide
        >
          <div className="publish-heading">
            <h2>What would you like to post?</h2>
            <p>Start with a clear description of your task or item.</p>
          </div>
          <div className="publish-options">
            <button
              className={publishKind === "task" ? "active" : ""}
              onClick={() => setPublishKind("task")}
            >
              <FlaskConical size={22} />
              <span>
                <strong>Post bounty</strong>
                <small>Find someone to help with a task</small>
              </span>
              {publishKind === "task" && <CheckCircle2 size={18} />}
            </button>
            <button
              className={publishKind === "product" ? "active" : ""}
              onClick={() => setPublishKind("product")}
            >
              <ShoppingBag size={22} />
              <span>
                <strong>Sell an item</strong>
                <small>Find a new home for your things</small>
              </span>
              {publishKind === "product" && <CheckCircle2 size={18} />}
            </button>
          </div>
          <form
            className="publish-form"
            onSubmit={async (e) => {
              e.preventDefault();
              const f = Object.fromEntries(new FormData(e.currentTarget));
              const r = await act(
                "publish",
                { ...f, kind: publishKind },
                "Published to the demo community",
              );
              if (r) {
                close();
                navigate(publishKind === "task" ? "tasks" : "market");
                open(publishKind === "task" ? "task" : "product", r.id);
              }
            }}
          >
            <Field
              label={publishKind === "task" ? "Bounty title" : "Item name"}
              name="title"
              minLength={5}
              maxLength={90}
              placeholder={
                publishKind === "task"
                  ? "For example: Create an interactive chart from public data"
                  : "For example: A lightly used drawing tablet or digital creation"
              }
            />
            <div className="form-grid">
              <label className="field">
                <span>Category *</span>
                <select name="category">
                  {(publishKind === "task" ? taskCategories : productCategories)
                    .slice(1)
                    .map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                </select>
              </label>
              <Field
                label={
                  publishKind === "task"
                    ? "Bounty reward (USD)"
                    : "Item price (USD)"
                }
                name="amount"
                type="number"
                min="1"
                max="100000"
                step="0.01"
                placeholder="150"
              />
            </div>
            <Field
              label={
                publishKind === "task" ? "Task description" : "Item description"
              }
              name="description"
              area
              minLength={10}
              maxLength={4000}
              placeholder="Include the context, scope, and details the other person should know."
            />
            {publishKind === "task" ? (
              <>
                <Field
                  label="Deliverables & acceptance criteria (one per line)"
                  name="requirements"
                  area
                  minLength={5}
                  placeholder={
                    "Deliver working source code\nInclude setup instructions and test results"
                  }
                />
                <Field
                  label="Time to deliver after acceptance (days)"
                  name="durationDays"
                  type="number"
                  min="1"
                  max="30"
                  defaultValue="7"
                />
              </>
            ) : (
              <>
                <label className="field">
                  <span>Item type *</span>
                  <select name="productType">
                    <option value="physical">Physical item</option>
                    <option value="digital">Digital goods</option>
                  </select>
                </label>
                <Field
                  label="Delivery method"
                  name="delivery"
                  minLength={5}
                  maxLength={300}
                  placeholder="For example: Meet on campus at Berkeley or provide a source download link"
                />
              </>
            )}
            <Field
              label="Skills or tags (comma-separated)"
              name="tags"
              required={false}
              maxLength={150}
              placeholder="Python, Data visualization"
            />
            <label className="consent">
              <input type="checkbox" required />
              <span>
                I have the right to post this content. It does not involve
                academic cheating, fabricated research, or sensitive data.
              </span>
            </label>
            <div className="demo-info">
              This is a demo. No money is charged. Moderation and real payments
              are not connected yet.
            </div>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <button className="button primary full" disabled={busy}>
              <Plus size={16} />
              {busy
                ? "Publishing…"
                : publishKind === "task"
                  ? "Post bounty"
                  : "List item"}
            </button>
          </form>
        </Dialog>
      )}
      {modal?.kind === "task" && task && (
        <Dialog title="Bounty details" onClose={close} wide>
          <div className="detail-title">
            <span className="category-label">{task.category}</span>
            <span className={"status " + task.status}>
              <i />
              {statusName[task.status]}
            </span>
            <h2>{task.title}</h2>
            <div className="detail-author">
              <Avatar person={person(task.ownerId)} small />
              <span>
                {person(task.ownerId)?.name} · {person(task.ownerId)?.role}
                (self-reported)
              </span>
              <span>{person(task.ownerId)?.school}</span>
            </div>
          </div>
          <div className="detail-metrics">
            <div>
              <span>Bounty reward</span>
              <strong>
                {money(task.reward)} <small>USD</small>
              </strong>
            </div>
            <div>
              <span>Delivery time</span>
              <strong>
                {task.durationDays}
                <small> {task.durationDays === 1 ? "day" : "days"}</small>
              </strong>
            </div>
            <div>
              <span>Applicants</span>
              <strong>{task.applicationCount}</strong>
            </div>
          </div>
          <div className="detail-body">
            <h3>What you will work on</h3>
            <p>{task.description}</p>
            <h3>Deliverables & acceptance</h3>
            <ul className="checklist">
              {task.requirements.map((r, i) => (
                <li key={i}>
                  <CheckCircle2 size={17} />
                  {r}
                </li>
              ))}
            </ul>
            <div className="tags">
              {task.tags.map((t) => (
                <span key={t}>{t}</span>
              ))}
            </div>
          </div>
          <div className="workspace-panel">
            <h3>
              {me?.id === task.ownerId
                ? "Manage this bounty"
                : "Apply for this bounty"}
            </h3>
            {!me ? (
              <>
                <p>
                  Sign in with your U.S. university email to share your
                  approach.
                </p>
                <button
                  className="button primary"
                  onClick={() => open("login")}
                >
                  Sign in to apply
                </button>
              </>
            ) : task.ownerId === me.id ? (
              <>
                {task.status === "open" && (
                  <>
                    <p>
                      {task.applicationCount
                        ? "Choose an applicant and invite them to accept the task."
                        : "No applications yet. Choose an applicant here when they apply."}
                    </p>
                    {task.applications.map((a) => (
                      <div className="application" key={a.userId}>
                        <div className="detail-author">
                          <Avatar person={person(a.userId)} small />
                          <strong>{person(a.userId)?.name}</strong>
                          <span>{person(a.userId)?.school}</span>
                        </div>
                        <p>{a.note}</p>
                        <button
                          className="button outline"
                          disabled={busy}
                          onClick={() =>
                            act(
                              "select",
                              { id: task.id, applicantId: a.userId },
                              "Invitation sent",
                            )
                          }
                        >
                          Invite applicant
                        </button>
                      </div>
                    ))}
                    <button
                      className="text-button danger"
                      disabled={busy}
                      onClick={() =>
                        act("cancel", { id: task.id }, "Bounty closed")
                      }
                    >
                      Close bounty
                    </button>
                  </>
                )}
                {task.status === "invited" && (
                  <p>
                    Invitation sent. Waiting for{" "}
                    {person(task.assigneeId || "")?.name} to accept.
                  </p>
                )}
                {task.status === "active" && (
                  <p>
                    {person(task.assigneeId || "")?.name} is working on the
                    task. Deliverables will appear here when submitted.
                  </p>
                )}
              </>
            ) : task.assigneeId === me.id ? (
              <>
                {task.status === "invited" && (
                  <>
                    <p>
                      You have been invited. Review the scope, reward, and
                      acceptance criteria before you start.
                    </p>
                    <div className="action-row">
                      <button
                        className="button primary"
                        disabled={busy}
                        onClick={() =>
                          act("accept", { id: task.id }, "Task accepted")
                        }
                      >
                        Accept task
                      </button>
                      <button
                        className="button outline"
                        disabled={busy}
                        onClick={() =>
                          act("decline", { id: task.id }, "Invitation declined")
                        }
                      >
                        Decline invitation
                      </button>
                    </div>
                  </>
                )}
                {task.status === "active" && (
                  <NoteForm
                    run={act}
                    busy={busy}
                    id={task.id}
                    action="submit"
                    button="Submit work"
                    label="Delivery notes"
                    url
                  />
                )}
                {task.status === "review" && (
                  <p>Work submitted. Waiting for the publisher to review.</p>
                )}
              </>
            ) : task.status === "open" ? (
              task.applications.some((a) => a.userId === me.id) ? (
                <p className="success-line">
                  <CheckCircle2 size={18} /> Application submitted. Waiting for
                  the publisher to choose.
                </p>
              ) : (
                <NoteForm
                  run={act}
                  busy={busy}
                  action="apply"
                  id={task.id}
                  button="Submit application"
                  label="Your approach & relevant experience"
                />
              )
            ) : (
              <p>This bounty is not accepting new applications.</p>
            )}
            {task.submissions.map((s, i) => (
              <div className="submission" key={s.id}>
                <strong>Submission {i + 1}</strong>
                <p>{s.note}</p>
                {s.url && (
                  <a href={s.url} target="_blank" rel="noreferrer">
                    View deliverable <ExternalLink size={13} />
                  </a>
                )}
              </div>
            ))}
            {task.status === "review" && task.ownerId === me?.id && (
              <>
                <p>
                  Check each agreed requirement. Confirmation updates the demo
                  only; no money is transferred.
                </p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act(
                      "approve",
                      { id: task.id },
                      "Work approved. No real funds transferred.",
                    );
                  }}
                >
                  <label className="consent">
                    <input type="checkbox" required />
                    <span>
                      I have checked all acceptance criteria and confirm the
                      work meets the agreement.
                    </span>
                  </label>
                  <button className="button primary" disabled={busy}>
                    <CheckCheck size={18} />
                    Approve work
                  </button>
                </form>
                <details>
                  <summary>Request changes</summary>
                  <NoteForm
                    run={act}
                    busy={busy}
                    id={task.id}
                    action="revise"
                    button="Request revision"
                    label="Which acceptance criteria need attention?"
                  />
                </details>
              </>
            )}
            {task.status === "completed" && (
              <p className="success-line">
                <CheckCircle2 size={18} />
                Task complete. The demo reward status is recorded; no money was
                transferred.
              </p>
            )}
            {task.status === "cancelled" && (
              <p>The publisher has closed this bounty.</p>
            )}
          </div>
          {me &&
            [task.ownerId, task.assigneeId].includes(me.id) &&
            task.status !== "open" && (
              <div className="detail-body">
                <h3>Task conversation</h3>
                {task.messages.map((m) => (
                  <div className="message" key={m.id}>
                    <strong>{person(m.userId)?.name}</strong>
                    <p>{m.body}</p>
                  </div>
                ))}
                <NoteForm
                  run={act}
                  busy={busy}
                  id={task.id}
                  action="message"
                  button="Send message"
                  label="Message your collaborator"
                />
              </div>
            )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <p className="detail-footnote">
            Fictional tasks and profiles for demo testing. Real email
            verification, payment eligibility, payments, and dispute services
            are not enabled.
          </p>
        </Dialog>
      )}
      {modal?.kind === "product" && product && (
        <Dialog title="Item details" onClose={close}>
          <Art type={product.art} />
          <div className="product-detail">
            <span className="category-label">
              {product.productType === "digital"
                ? "Digital goods"
                : "Physical item"}{" "}
              / {product.category}
            </span>
            <h2>{product.title}</h2>
            <strong className="product-price">
              {money(product.price)} <small>USD</small>
            </strong>
            <p>{product.description}</p>
            <div className="detail-author">
              <Avatar person={person(product.ownerId)} small />
              <span>
                {person(product.ownerId)?.name} ·{" "}
                {person(product.ownerId)?.school}
              </span>
            </div>
            <div className="delivery-note">
              <Package size={20} />
              <div>
                <strong>Delivery method</strong>
                <p>{product.delivery}</p>
              </div>
            </div>
            <div className="demo-info">
              Demo orders do not charge money. Both physical and digital items
              require seller delivery and buyer confirmation.
            </div>
            {product.ownerId === me?.id ? (
              <p>This is your listing. View its orders in your workspace.</p>
            ) : (
              <button
                className="button primary full"
                disabled={busy || product.status !== "available"}
                onClick={() =>
                  requireLogin(async () => {
                    const r = await act(
                      "buy",
                      { id: product.id },
                      "Demo order created. No money charged.",
                    );
                    if (r) {
                      close();
                      navigate("workspace");
                      setWorkspaceTab("Orders");
                      open("order", r.id);
                    }
                  })
                }
              >
                <ShoppingBag size={17} />
                {product.status === "available"
                  ? "Place demo order"
                  : statusName[product.status]}
              </button>
            )}
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
          </div>
        </Dialog>
      )}
      {modal?.kind === "order" && order && (
        <Dialog title="Orders" onClose={close}>
          <div className="order-detail">
            <Package size={34} />
            <h2>{order.title}</h2>
            <strong className="product-price">{money(order.price)}</strong>
            <p className="status-line">{statusName[order.status]}</p>
            <p>
              Buyer: {person(order.buyerId)?.name}
              <br />
              Seller: {person(order.sellerId)?.name}
            </p>
            <div className="demo-info">
              This is a demo order. No payment or transfer has occurred.
            </div>
            {order.note && (
              <div className="submission">
                <strong>Seller delivery notes</strong>
                <p>{order.note}</p>
              </div>
            )}
            {order.sellerId === me?.id && order.status === "reserved" && (
              <NoteForm
                run={act}
                busy={busy}
                action="fulfill"
                id={order.id}
                button="Record delivery"
                label="Delivery arrangements or digital access instructions"
              />
            )}
            {order.buyerId === me?.id && order.status === "reserved" && (
              <p>
                Waiting for delivery. Switch to the seller demo account to
                continue.
              </p>
            )}
            {order.buyerId === me?.id && order.status === "delivered" && (
              <button
                className="button primary full"
                disabled={busy}
                onClick={() =>
                  act(
                    "received",
                    { id: order.id },
                    "Receipt confirmed. Order complete.",
                  )
                }
              >
                Confirm receipt
              </button>
            )}
            {order.status === "completed" && (
              <p className="success-line">
                <CheckCircle2 size={18} />
                Order complete
              </p>
            )}
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
          </div>
        </Dialog>
      )}
      {modal?.kind === "rules" && (
        <Dialog title="Community & transactions" onClose={close}>
          <div className="rules">
            <h2>Clear expectations. Better collaboration.</h2>
            <h3>Bounties</h3>
            <p>
              Publishers define the reward, scope, and acceptance criteria.
              Students apply, accept an invitation, and deliver work for review.
              Tasks must not involve academic cheating, fabricated research, or
              unauthorized data.
            </p>
            <h3>Marketplace</h3>
            <p>
              Physical and digital listings must state delivery terms,
              condition, and usage rights. Buyers confirm receipt after
              delivery. Each item can have only one open order in this version.
            </p>
            <h3>University email & identity</h3>
            <p>
              Real access requires a reviewed university domain and verified
              email ownership. A university email alone does not prove current
              enrollment or faculty status. Demo roles and emails are not
              verified identities.
            </p>
            <h3>About this demo</h3>
            <p>
              Posts, applications, deliverables, orders, and conversations are
              saved in your demo workspace. Codes appear on screen. Payments,
              transfers, email delivery, and human moderation are not connected.
              This version is not ready for real transactions.
            </p>
            <button className="button primary full" onClick={close}>
              Got it
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
