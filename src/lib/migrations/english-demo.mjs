import replacements from "./english-demo.json" with { type: "json" };

// Translate only known demo copy; preserve user edits and transaction history.
export function migrateEnglishDemo(data) {
  if (data.demoCopyLocale === "en") return false;
  const categories = new Map();
  for (const [group, entries] of Object.entries(replacements)) {
    for (const { id, fields } of entries) {
      const item = data[group].find((record) => record.id === id);
      if (fields.category) categories.set(...fields.category);
      if (!item) continue;
      for (const [field, [previous, translated]] of Object.entries(fields)) {
        if (JSON.stringify(item[field]) === JSON.stringify(previous)) {
          item[field] = structuredClone(translated);
        }
      }
    }
  }
  for (const item of [...data.tasks, ...data.products]) {
    item.category = categories.get(item.category) || item.category;
  }
  const roles = new Map(replacements.users.map((entry) => entry.fields.role));
  roles.set("\u6210\u5458", "Member");
  for (const user of data.users) {
    user.role = roles.get(user.role) || user.role;
  }
  for (const order of data.orders) {
    const entry = replacements.products.find(
      (item) => item.id === order.productId,
    );
    if (entry?.fields.title && order.title === entry.fields.title[0]) {
      order.title = entry.fields.title[1];
    }
  }
  data.demoCopyLocale = "en";
  return true;
}
