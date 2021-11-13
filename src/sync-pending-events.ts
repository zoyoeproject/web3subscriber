import { MongoClient, Db, Collection, Document } from "mongodb";
import { WebsocketProvider } from "web3-providers-ws";
import { EventData } from "web3-eth-contract";
import { provider } from "web3-core";
import {
  DelphinusContract,
  DelphinusWeb3,
  Web3ProviderMode,
} from "./client";

const Web3WsProvider = require("web3-providers-ws");

const options = {
  timeout: 30000, // ms

  clientConfig: {
    // Useful if requests are large
    maxReceivedFrameSize: 100000000, // bytes - default: 1MiB
    maxReceivedMessageSize: 100000000, // bytes - default: 8MiB

    // Useful to keep a connection alive
    keepalive: true,
    keepaliveInterval: 6000, // ms
  },

  // Enable auto reconnection
  reconnect: {
    auto: true,
    delay: 5000, // ms
    maxAttempts: 5,
    onTimeout: true,
  },
};

// TODO: replace any with real type
function getAbiEvents(abiJson: any) {
  let events: any = {};
  abiJson.forEach((t: any) => {
    if (t.type == "event") {
      events[t.name] = t;
    }
  });
  return events;
}

// TODO: replace any with real type
function buildEventValue(events: any, r: EventData) {
  let event = events[r.event];
  let v: any = {};
  event.inputs.forEach((i: any) => {
    v[i.name] = r.returnValues[i.name];
  });
  return v;
}

/* Mongo Db helper to track all the recorded events handled so far */
class DBHelper {
  private readonly url: string;
  private client?: MongoClient;
  private db?: Db;
  private infoCollection?: Collection<Document>;

  constructor(url: string) {
    this.url = url;
  }

  private async getDb() {
    if (!this.db) {
      this.client = await MongoClient.connect(this.url);
      this.db = await this.client.db();
    }

    return this.db;
  }

  private async getClient() {
    await this.getDb();

    if (this.client === undefined) {
      throw "Failed to connect mongodb";
    }

    return this.client;
  }

  async close() {
    await this.client?.close();
  }

  private async getOrCreateEventCollection(eventName: string) {
    let db = await this.getDb();
    let collections = await db.listCollections({ name: eventName }).toArray();

    if (collections.length == 0) {
      console.log("Init collection: ", eventName);
      return await db.createCollection(eventName);
    } else {
      return db.collection(eventName);
    }
  }

  async getInfoCollection() {
    if (!this.infoCollection) {
      this.infoCollection = await this.getOrCreateEventCollection(
        "MetaInfoCollection"
      );
    }
    return this.infoCollection;
  }

  async getLastMonitorBlock() {
    let infoCollection = await this.getInfoCollection();

    let rs = await infoCollection.findOne({ name: "LastUpdatedBlock" });
    return rs === null ? 0 : rs.lastblock;
  }

  // TODO: replace any with real type
  async updateLastMonitorBlock(r: EventData, v: any) {
    let client = await this.getClient();
    let eventCollection = await this.getOrCreateEventCollection(r.event);
    let infoCollection = await this.getInfoCollection();

    await client.withSession(async (session) => {
      await session.withTransaction(async () => {
        await infoCollection.updateOne(
          { name: "LastUpdatedBlock" },
          { $set: { lastblock: r.blockNumber } },
          { upsert: true }
        );

        await eventCollection.insertOne({
          blockNumber: r.blockNumber,
          blockHash: r.blockHash,
          transactionHash: r.transactionHash,
          event: v,
        });
      });
    });
  }
}

async function withDBHelper(uri: string, cb: (db: DBHelper) => Promise<void>) {
  let db = new DBHelper(uri);
  try {
    return await cb(db);
  } finally {
    await db.close();
  }
}

export class EventTracker {
  private readonly initProvider: () => WebsocketProvider;
  private provider: WebsocketProvider;
  private readonly web3: DelphinusWeb3;
  private readonly contract: DelphinusContract;
  private readonly address: string;
  private readonly dbUrl: string;

  // TODO: replace any with real type
  private readonly l1Events: any;
  private readonly handlers: (n: string, v: any, hash: string) => Promise<void>;

  constructor(
    networkId: string,
    dataJson: any,
    websocketSource: string,
    monitorAccount: string,
    mongodbUrl: string,
    handlers: (n: string, v: any, hash: string) => Promise<void>
  ) {
    this.initProvider = () => {
      let provider = new Web3WsProvider(websocketSource, options);
      provider.connection.onopen = () => {
        console.info("Event Tracker Started");
      };

      provider.connection.onerror = () => {
        console.info("connection error");
      };

      provider.connection.onclose = () => {
        console.info("connection close");
      };
      return provider;
    };

    let closeProviderHelper = async (provider: provider) => {
      await (provider as any).connection.close();
    };

    let provider = this.initProvider();
    let providerConfig = {
      provider: provider,
      closeProvider: closeProviderHelper,
      monitorAccount: monitorAccount,
    };
    let web3 = new Web3ProviderMode(providerConfig);
    this.provider = provider;
    this.web3 = web3;

    this.l1Events = getAbiEvents(dataJson.abi);
    this.address = dataJson.networks[networkId].address;
    this.contract = web3.getContract(
      dataJson,
      this.address,
      monitorAccount
    );
    this.handlers = handlers;
    this.dbUrl = mongodbUrl + "/" + networkId + this.address;
  }

  private async syncPastEvents(db: DBHelper) {
    let lastblock = await db.getLastMonitorBlock();
    console.log("sync from ", lastblock);
    let pastEvents = await this.contract.getPastEventsFrom(lastblock + 1);
    for (let r of pastEvents) {
      console.log(
        "========================= Get L1 Event: %s ========================",
        r.event
      );
      console.log("blockNumber:", r.blockNumber);
      console.log("blockHash:", r.blockHash);
      console.log("transactionHash:", r.transactionHash);
      let e = buildEventValue(this.l1Events, r);
      await this.handlers(r.event, e, r.transactionHash);
      await db.updateLastMonitorBlock(r, e);
    }
  }

  private async polling(db: DBHelper) {
    try {
      await this.syncPastEvents(db);
      await setTimeout(() => {
        console.log("Polling ...");
        this.polling(db);
      }, 5000);
    } catch (e: any) {
      console.log("Sync Event Error:");
      console.log(e.message);
      console.info("Reconnecting ...");
      this.provider.connection.close();
      this.provider = this.initProvider();
      this.web3.web3Instance!.eth.clearSubscriptions(
        (error: Error, result: boolean) => {}
      );
      this.web3.web3Instance!.setProvider(this.provider);
      await setTimeout(() => {
        console.log("Polling ...");
        this.polling(db);
      }, 5000);
    }
  }

  async syncEvents(loop = false) {
    await withDBHelper(this.dbUrl, async (dbhelper: DBHelper) => {
      if (loop) {
        await this.polling(dbhelper);
      } else {
        await this.syncPastEvents(dbhelper);
      }
    });
  }

  // For debug
  async subscribePendingEvents() {
    //var subscription = this.web3.eth.subscribe('pendingTransactions',
    this.web3.web3Instance!.eth
      .subscribe("logs", { address: this.address })
      .on("data", (transaction: any) => {
        console.log(transaction);
      });
  }

  private async resetEventsInfo(db: DBHelper) {
    let infoCollection = await db.getInfoCollection();
    await infoCollection.deleteMany({ name: "LastUpdatedBlock" });
    // TODO: eventCollection should also be deleted?
    return true;
  }

  async resetEvents() {
    await withDBHelper(this.dbUrl, async (dbhelper: DBHelper) => {
      await this.resetEventsInfo(dbhelper);
    });
  }

  async close() {
    await this.provider.connection.close();
  }
}