// Execute the actual component callbacks with deterministic hook/transport
// dependencies. No server mutations, synthetic application IDs only.
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  vm = require("node:vm"),
  ts = require("typescript");
const root = path.resolve("src/components/shared");
const component = (name) => Object.assign(() => null, { componentName: name });
function harness(
  search,
  { taskStatus = "open", applications = [], owner = "publisher" } = {},
) {
  const pushed = [],
    calls = [],
    query = new URLSearchParams(search),
    account = {
      id: "actor",
      display_name: "Reader",
      can_apply: true,
      campus_verified: true,
      account_status: "active",
    };
  const task = {
    id: "bounty-id",
    owner_id: owner,
    title: "Synthetic bounty",
    status: taskStatus,
    reward_cents: 100,
    milestones: [],
    related_agreement: { id: "agreement-id", state: "awaiting_funding" },
  };
  const mocks = {
    react: {
      useRef: () => ({ current: null }),
      useState: (value) => [value, () => {}],
      useEffect: () => {},
      useCallback: (fn) => fn,
    },
    "next/navigation": {
      useRouter: () => ({ push: (url) => pushed.push(url) }),
      useSearchParams: () => query,
    },
    "./api": {
      ApiError: class ApiError extends Error {},
      useResource: (p) => ({
        data:
          p === "me"
            ? account
            : p === "auth/preview"
              ? { enabled: false }
              : p === "teams"
                ? []
                : p === "tasks/bounty-id"
                  ? task
                  : p === "tasks/bounty-id/applications"
                    ? applications
                    : p === "saved/tasks/bounty-id"
                      ? { id: "bounty-id", saved: true }
                      : undefined,
        loading: false,
        reload: () => {},
      }),
      useMutation: () => ({
        run: async (...args) => {
          calls.push(args);
          return { id: "created-application" };
        },
        clear: () => {},
        busy: false,
      }),
    },
    "./types": { money: (value) => String(value) },
  };
  const cache = {};
  function load(file) {
    if (cache[file]) return cache[file];
    const js = ts.transpileModule(
      fs.readFileSync(path.join(root, file), "utf8"),
      {
        compilerOptions: {
          jsx: ts.JsxEmit.ReactJSX,
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
        },
      },
    ).outputText;
    const mod = { exports: {} };
    cache[file] = mod.exports;
    const req = (name) => {
      if (mocks[name]) return mocks[name];
      if (name === "react/jsx-runtime") return require(name);
      if (name === "./history-pagination")
        return load("history-pagination.tsx");
      if (name.endsWith(".css")) return {};
      return new Proxy(
        {},
        {
          get: (_, key) =>
            key === "__esModule" ? false : component(String(key)),
        },
      );
    };
    vm.runInNewContext(`(function(require,module,exports){${js}\n})`, {
      URLSearchParams,
    })(req, mod, mod.exports);
    return mod.exports;
  }
  return { load, query, account, task, pushed, calls };
}
function nodes(tree) {
  if (!tree) return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (typeof tree !== "object") return [];
  return [tree, ...nodes(tree.props?.children)];
}
function assertOrigin(url, search, id, resource) {
  const u = new URL(url, "https://local.test"),
    p = new URLSearchParams(search);
  assert.equal(u.searchParams.get("id"), id);
  assert.equal(u.searchParams.get("resource"), resource);
  assert.equal(u.searchParams.get("cursor"), p.get("cursor"));
  assert.equal(u.searchParams.get("tab"), p.get("tab"));
  assert.equal(
    u.searchParams.get("returnView"),
    p.get("returnView") || p.get("view"),
  );
  return u;
}
test("actual successful application form callback preserves older Saved origin", async () => {
  const search = "view=saved&id=bounty-id&cursor=saved-position";
  const h = harness(search),
    tree = h.load("task-detail.tsx").TaskDetail({
      id: "bounty-id",
      account: h.account,
      openAgreement: () => {},
    });
  const form = nodes(tree).find((x) => x.type === "form");
  assert.ok(form);
  await form.props.onSubmit({ preventDefault() {} });
  assert.equal(h.calls[0][0], "tasks/bounty-id/applications");
  assert.equal(h.pushed.length, 1);
  assertOrigin(h.pushed[0], search, "created-application", "application");
});
test("actual bounty links and ApplicationCard prop keep original scopes, never destination tab", () => {
  for (const origin of [
    "view=bounties&tab=applications&returnView=workspace&cursor=applications-position",
    "view=bounties&tab=posted&returnView=workspace&cursor=posted-position",
    "view=saved&cursor=saved-position",
  ]) {
    const h = harness(origin, {
        taskStatus: "contracted",
        applications: [
          {
            id: "application-id",
            applicant_id: "actor",
            state: "accepted",
            members: [],
          },
        ],
      }),
      tree = h.load("task-detail.tsx").TaskDetail({
        id: "bounty-id",
        account: h.account,
        openAgreement: () => {},
      }),
      all = nodes(tree);
    for (const [name, id, kind] of [
      ["Chat about your application", "application-id", "application"],
      ["Open linked agreement", "agreement-id", "agreement"],
    ]) {
      const link = all.find((x) => x.props?.children === name);
      assert.ok(link);
      assertOrigin(link.props.href, origin, id, kind);
    }
    const card = all.find((x) => x.type?.componentName === "ApplicationCard");
    assertOrigin(
      card.props.discussionUrl,
      origin,
      "application-id",
      "application",
    );
  }
});
test("actual app ProductDetail new-order callback preserves an older Orders origin", () => {
  const search =
      "view=market&id=product-id&tab=orders&cursor=orders-position&returnView=workspace",
    h = harness(search);
  const tree = h.load("app.tsx").default({ local: true }),
    product = nodes(tree).find(
      (x) => x.type?.componentName === "ProductDetail",
    );
  assert.ok(product);
  product.props.openOrder("new-order-id");
  assertOrigin(h.pushed[0], search, "new-order-id", "order");
});
