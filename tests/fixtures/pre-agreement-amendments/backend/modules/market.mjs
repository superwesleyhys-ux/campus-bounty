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
  return {
    ...teamModule(store),
    ...workspaceHistoryModule(store),
    ...notificationModule(store),
    ...taskModule(store),
    ...goodsModule(store),
    ...conversationModule(store),
    ...conversationInboxModule(store),
    ...accountModule(store, options),
    ...listingLifecycleModule(store),
  };
}
