import { paymentModule } from "./payments.mjs";
import { paymentAllocationModule } from "./payment-allocations.mjs";
import { agreementAmendmentModule } from "./agreement-amendments.mjs";
import { listingLifecycleModule } from "./listing-lifecycle.mjs";
import { workspaceHistoryModule } from "./workspace-history.mjs";
import { conversationInboxModule } from "./conversation-inbox.mjs";
import { notificationModule } from "./notifications.mjs";
import { teamModule } from "./teams.mjs";
import { taskModule } from "./tasks.mjs";
import { goodsModule } from "./goods.mjs";
import { conversationModule } from "./conversations.mjs";
import { accountModule } from "./account.mjs";
export function createMarket(store, options = {}) {
  const market = {
    ...teamModule(store),
    ...workspaceHistoryModule(store),
    ...notificationModule(store),
    ...taskModule(store),
    ...goodsModule(store),
    ...conversationModule(store),
    ...conversationInboxModule(store),
    ...accountModule(store, options),
    ...listingLifecycleModule(store),
    ...agreementAmendmentModule(store),
    ...paymentAllocationModule(store),
    ...paymentModule(store, options),
  };
  const capabilities = market.capabilities;
  market.capabilities = async (actor) => {
    const value = await capabilities(actor);
    return options.paymentEnabled !== true
      ? {
          ...value,
          payments: {
            ...value.payments,
            enabled: false,
            environment: "unavailable",
            providerReadiness: "unconfigured",
          },
        }
      : value;
  };
  return market;
}
