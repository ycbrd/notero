import { isFullPage } from '@notionhq/client';

import { loadSyncEnabledCollectionIDs } from '../collection-sync-config';
import NoteroItem from '../notero-item';
import { getNoteroPref, NoteroPref, PageTitleFormat } from '../notero-pref';
import Notion, { TitleBuilder } from '../notion';
import {
  getAllCollectionItems,
  getLocalizedString,
  hasErrorStack,
  log,
} from '../utils';

import type { Service } from './service';

const SYNC_DEBOUNCE_MS = 2000;

type NotifierIDs = readonly (number | string)[];

type NotifierEventHandler = (ids: NotifierIDs) => Zotero.Item[];

type QueuedSync = {
  readonly itemIDs: Set<Zotero.Item['id']>;
  timeoutID?: ReturnType<Zotero['setTimeout']>;
};

export default class SyncManager implements Service {
  private static get tickIcon() {
    return `chrome://zotero/skin/tick${Zotero.hiDPISuffix}.png`;
  }

  private observerID?: ReturnType<Zotero.Notifier['registerObserver']>;

  private readonly progressWindow = new Zotero.ProgressWindow();

  private queuedSync?: QueuedSync;

  private syncInProgress = false;

  constructor() {
    this.unregisterObserver = this.unregisterObserver.bind(this);
  }

  public startup() {
    this.registerObserver();

    Zotero.getMainWindow().addEventListener(
      'unload',
      // eslint-disable-next-line @typescript-eslint/unbound-method
      this.unregisterObserver,
      false
    );
  }

  public shutdown() {
    this.unregisterObserver();

    Zotero.getMainWindow().removeEventListener(
      'unload',
      // eslint-disable-next-line @typescript-eslint/unbound-method
      this.unregisterObserver,
      false
    );
  }

  private registerObserver() {
    this.observerID = Zotero.Notifier.registerObserver(
      this.observer,
      ['collection', 'collection-item', 'item', 'item-tag'],
      'notero'
    );
  }

  private unregisterObserver() {
    if (this.observerID) {
      Zotero.Notifier.unregisterObserver(this.observerID);
      delete this.observerID;
    }
  }

  private observer = {
    notify: (
      event: string,
      type: Zotero.Notifier.Type,
      ids: NotifierIDs,
      _extraData: Record<string, unknown>
    ) => {
      log(`Notified of ${event} ${type} for IDs ${JSON.stringify(ids)}`);

      const items = this.getItemsForEvent(event, type, ids);

      if (items.length) {
        this.enqueueItemsToSync(items);
      }
    },
  };

  /**
   * Return the Zotero items (if any) that should be synced for the given
   * notifier event.
   * @returns An array of Zotero items.
   */
  private getItemsForEvent(
    event: string,
    type: Zotero.Notifier.Type,
    ids: NotifierIDs
  ): Zotero.Item[] {
    const collectionIDs = loadSyncEnabledCollectionIDs();
    if (!collectionIDs.size) return [];

    const syncOnModifyItems = getNoteroPref(NoteroPref.syncOnModifyItems);

    const eventHandlers: Partial<
      Record<Zotero.Notifier.Type, Record<typeof event, NotifierEventHandler>>
    > = syncOnModifyItems
      ? {
          collection: {
            delete: this.getItemsFromCollectionIDs,
            modify: this.getItemsFromCollectionIDs,
          },
          item: {
            modify: this.getItemsFromItemIDs,
          },
          'item-tag': {
            modify: this.withIndexedIDs(0, this.getItemsFromItemIDs),
            remove: this.withIndexedIDs(0, this.getItemsFromItemIDs),
          },
        }
      : {
          'collection-item': {
            add: this.withIndexedIDs(1, this.getItemsFromItemIDs),
          },
        };

    const items = eventHandlers[type]?.[event]?.(ids) ?? [];

    return items.filter(
      (item) =>
        !item.deleted &&
        item.isRegularItem() &&
        item
          .getCollections()
          .some((collectionID) => collectionIDs.has(collectionID))
    );
  }

  private getItemsFromItemIDs(this: void, ids: NotifierIDs) {
    return Zotero.Items.get(ids as number[]);
  }

  private getItemsFromCollectionIDs(this: void, ids: NotifierIDs) {
    const items = Zotero.Collections.get(ids as number[]).reduce(
      (items: Zotero.Item[], collection) =>
        items.concat(getAllCollectionItems(collection)),
      []
    );

    // Deduplicate items in multiple collections
    return Array.from(new Set(items));
  }

  /**
   * Return a wrapped event handler that is passed IDs extracted from compound
   * IDs (e.g. `'${id0}-${id1}'`) at the given index.
   * @param index The index of the IDs to extract from compound IDs.
   * @param handler The event handler to wrap.
   * @returns A wrapped event handler.
   */
  private withIndexedIDs(
    this: void,
    index: number,
    handler: NotifierEventHandler
  ): NotifierEventHandler {
    return (ids: NotifierIDs) => {
      const itemIDs = (ids as string[]).map((compoundID) =>
        Number(compoundID.split('-')[index])
      );
      return handler(itemIDs);
    };
  }

  private getNotion() {
    const authToken = getNoteroPref(NoteroPref.notionToken);
    const databaseID = getNoteroPref(NoteroPref.notionDatabaseID);

    if (!authToken) {
      throw new Error(`Missing ${getLocalizedString(NoteroPref.notionToken)}`);
    }

    if (!databaseID) {
      throw new Error(
        `Missing ${getLocalizedString(NoteroPref.notionDatabaseID)}`
      );
    }

    return new Notion(authToken, databaseID);
  }

  private getTitleBuilder(): TitleBuilder {
    const titleBuilders: Record<
      PageTitleFormat,
      (item: NoteroItem) => string | null | Promise<string | null>
    > = {
      [PageTitleFormat.itemAuthorDateCitation]: (item) =>
        item.getAuthorDateCitation(),
      [PageTitleFormat.itemFullCitation]: (item) => item.getFullCitation(),
      [PageTitleFormat.itemInTextCitation]: (item) => item.getInTextCitation(),
      [PageTitleFormat.itemShortTitle]: (item) => item.getShortTitle(),
      [PageTitleFormat.itemTitle]: (item) => item.getTitle(),
    };

    const format =
      getNoteroPref(NoteroPref.pageTitleFormat) || PageTitleFormat.itemTitle;
    const buildTitle = titleBuilders[format];

    return async (item) => (await buildTitle(item)) || item.getTitle();
  }

  /**
   * Enqueue Zotero items to sync to Notion.
   *
   * Because Zotero items can be updated multiple times in short succession,
   * any subsequent updates after the first can sometimes occur before the
   * initial sync has finished and added the Notion link attachment. This has
   * the potential to end up creating duplicate Notion pages.
   *
   * To address this, we use two strategies:
   * - Debounce syncs so that they occur, at most, every `SYNC_DEBOUNCE_MS` ms
   * - Prevent another sync from starting until the previous one has finished
   *
   * The algorithm works as follows:
   * 1. When enqueueing items, check if there is an existing sync queued
   *    - If not, create one with a set of the item IDs to sync and a timeout
   *      of `SYNC_DEBOUNCE_MS`
   *    - If so, add the item IDs to the existing set and restart the timeout
   * 2. When a timeout ends, check if there is a sync in progress
   *    - If not, perform the sync
   *    - If so, delete the timeout ID (to indicate it has expired)
   * 3. When a sync ends, check if there is another sync queued
   *    - If there is one with an expired timeout, perform the sync
   *    - If there is one with a remaining timeout, let it run when it times out
   *    - Otherwise, do nothing
   *
   * @param items the Zotero items to sync to Notion
   */
  private enqueueItemsToSync(items: readonly Zotero.Item[]) {
    log(`Enqueue ${items.length} item(s) to sync`);

    if (!items.length) return;

    if (this.queuedSync?.timeoutID) {
      Zotero.clearTimeout(this.queuedSync.timeoutID);
    }

    const itemIDs = new Set([
      ...(this.queuedSync?.itemIDs?.values() ?? []),
      ...items.map(({ id }) => id),
    ]);

    const timeoutID = Zotero.setTimeout(() => {
      if (!this.queuedSync) return;

      this.queuedSync.timeoutID = undefined;
      if (!this.syncInProgress) {
        void this.performSync();
      }
    }, SYNC_DEBOUNCE_MS);

    this.queuedSync = { itemIDs, timeoutID };
  }

  private async performSync() {
    if (!this.queuedSync) return;

    const { itemIDs } = this.queuedSync;
    this.queuedSync = undefined as QueuedSync | undefined;
    this.syncInProgress = true;

    await this.saveItemsToNotion(itemIDs);

    if (this.queuedSync && !this.queuedSync.timeoutID) {
      await this.performSync();
    }

    this.syncInProgress = false;
  }

  private async saveItemsToNotion(itemIDs: Set<Zotero.Item['id']>) {
    const PERCENTAGE_MULTIPLIER = 100;

    const items = Zotero.Items.get(Array.from(itemIDs));
    if (!items.length) return;

    this.progressWindow.changeHeadline('Saving items to Notion...');
    this.progressWindow.show();
    const itemProgress = new this.progressWindow.ItemProgress(
      'chrome://notero/content/style/notion-logo-32.png',
      ''
    );

    try {
      const notion = this.getNotion();
      const buildTitle = this.getTitleBuilder();
      let step = 0;

      for (const item of items) {
        step++;
        const progressMessage = `Item ${step} of ${items.length}`;
        log(`Saving ${progressMessage} with ID ${item.id}`);
        itemProgress.setText(progressMessage);
        await this.saveItemToNotion(item, notion, buildTitle);
        itemProgress.setProgress((step / items.length) * PERCENTAGE_MULTIPLIER);
      }
      itemProgress.setIcon(SyncManager.tickIcon);
      this.progressWindow.startCloseTimer();
    } catch (error) {
      const errorMessage = String(error);
      log(errorMessage, 'error');
      if (hasErrorStack(error)) {
        log(error.stack, 'error');
      }
      itemProgress.setError();
      this.progressWindow.addDescription(errorMessage);
    }
  }

  private async saveItemToNotion(
    item: Zotero.Item,
    notion: Notion,
    buildTitle: TitleBuilder
  ) {
    const noteroItem = new NoteroItem(item);
    const response = await notion.saveItemToDatabase(noteroItem, buildTitle);

    await noteroItem.saveNotionTag();

    if (isFullPage(response)) {
      await noteroItem.saveNotionLinkAttachment(response.url);
    } else {
      throw new Error(
        'Failed to create Notion link attachment. ' +
          'This will result in duplicate Notion pages. ' +
          'Please ensure that the "read content" capability is enabled ' +
          'for the Notero integration at www.notion.so/my-integrations.'
      );
    }
  }
}